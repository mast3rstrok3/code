import {
  AppReviewWorkflowCycleBudget,
  CommandId,
  EventId,
  type OrchestrationEvent,
  type OrchestrationThreadShell,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2Run,
  type OrchestrationV2ServerCommand,
  type ServerSettings,
  ThreadId,
  WORKFLOW_AUTOMATION_RUNTIME_MODE,
} from "@t3tools/contracts";
import { resolveAppReviewStepParts } from "@t3tools/shared/appReviewParts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveAppReviewE2eCommands } from "@t3tools/shared/t3ProjectFile";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";
import {
  APP_REVIEW_WORKFLOW_PROMPT_ID,
  FEATURE_APP_REVIEW_CYCLE_KEY,
  resolveWorkflowStepCycleBudget,
} from "@t3tools/shared/workflowStepCycles";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { AppStackManager } from "../appStack/AppStackManager.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { T3ProjectFileLoader } from "../project/T3ProjectFileLoader.ts";
import {
  appendWorkflowSkillCommandSection,
  appendWorkflowStepInstructions,
  WORKFLOW_PROMPT_IDS,
} from "../provider/WorkflowPromptRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { resolveProjectDevelopmentBranch } from "../vcs/developmentBranch.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  buildFeatureAppReviewFixMessage,
  buildFeatureAppReviewMessage,
  buildFeatureE2eAppReviewBrief,
  buildFeatureFixMessage,
  buildFeatureImplementMessage,
  buildFeaturePullRequestMessage,
  buildFeatureReviewMessage,
  FEATURE_BROWSER_APP_REVIEW_EVIDENCE,
  featureAppReviewFixMessageId,
  featureAppReviewId,
  featureAppReviewMessageId,
  featureAppReviewReportMarkdown,
  featureAppReviewThreadId,
  type FeatureAppReviewState,
  featureE2eAppReviewRunId,
  featureE2eAppReviewState,
  featureFixMessageId,
  featureImplementMessageId,
  featureInstructionRun,
  featurePullRequestMessageId,
  featureReviewMessageId,
  featureReviewThreadId,
  featureRootOfReviewThread,
  type FeatureReviewState,
  type FeatureWorkflowAction,
  latestRun,
  nextFeatureWorkflowActions,
} from "./featureWorkflow.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { resolveWorkflowStepModelSelection } from "./workflowSubagents.ts";

export const FEATURE_WORKFLOW_COMPLETED_ACTIVITY_KIND = "feature-workflow.completed";
export const FEATURE_APP_REVIEW_SKIPPED_ACTIVITY_KIND = "feature-app-review.skipped";

const CODE_REVIEW_PROMPT_ID = WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex;
const APP_REVIEW_PROMPT_ID = WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex;

/** Native events that can move a Feature to its next step. */
const TRIGGER_EVENT_TYPES = new Set<OrchestrationV2DomainEvent["type"]>([
  "run.updated",
  "runtime-request.updated",
  "thread.metadata-updated",
]);

/**
 * Drives the Feature workflow on the native runtime: once the user's turn wrote the
 * instruction, starts the test-first implement turn, runs App Review cycles (the project's E2E
 * suites on the worktree's App Stack, or a recorded browser review when it has none) and then
 * Code Review cycles, hands their findings back to the Feature thread, opens the pull request,
 * and stops the workflow's App Stacks once the pull request is linked. The steps themselves are
 * decided by `nextFeatureWorkflowActions`.
 */
export class FeatureWorkflowReactor extends Context.Service<
  FeatureWorkflowReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Re-reads one Feature thread and starts whatever step is due. */
    readonly evaluate: (threadId: ThreadId) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/FeatureWorkflowReactor") {}

const commandId = (...parts: ReadonlyArray<string | number>) =>
  CommandId.make(["feature", ...parts].join(":"));

export const make = Effect.gen(function* () {
  const native = yield* OrchestratorV2;
  const workflowEngine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettingsService;
  const appStacks = yield* AppStackManager;
  const git = yield* GitVcsDriver;
  const projectFiles = yield* T3ProjectFileLoader;

  const readSettings = settingsService.getSettings.pipe(
    Effect.map((settings): ServerSettings | null => settings),
    Effect.orElseSucceed(() => null),
  );

  const dispatch = (command: OrchestrationV2ServerCommand) =>
    native.dispatch(command).pipe(Effect.asVoid);

  /**
   * A Feature root this reactor drives. The workflow id is stamped when the preset is chosen,
   * so Feature threads from before this reactor existed, which have none, are left alone
   * instead of suddenly implementing or publishing old work.
   */
  const isFeatureRoot = (thread: {
    readonly workflowPreset?: string | null | undefined;
    readonly workflowRole?: string | null | undefined;
    readonly workflowContext?: unknown;
    readonly archivedAt: unknown;
  }) =>
    thread.workflowPreset === "fast-plan" &&
    (thread.workflowRole ?? null) === null &&
    thread.workflowContext != null &&
    thread.archivedAt === null;

  const readReviews = Effect.fn("FeatureWorkflowReactor.readReviews")(function* (
    threadId: ThreadId,
    cycleBudget: number,
  ) {
    const reviews: FeatureReviewState[] = [];
    for (let cycle = 1; cycle <= cycleBudget; cycle += 1) {
      const records = yield* native
        .getThreadRecords(featureReviewThreadId(threadId, cycle), ["runs", "messages"], {
          messageRoles: ["assistant"],
        })
        .pipe(Effect.option);
      if (Option.isNone(records)) break;
      const run = latestRun(records.value.runs);
      const finalMessage = records.value.messages.findLast(
        (message) => message.runId === run?.id && !message.streaming,
      );
      reviews.push({ runStatus: run?.status ?? null, finalText: finalMessage?.text ?? null });
      if (run?.status !== "completed") break;
    }
    return reviews;
  });

  /**
   * App Reviews read back cycle by cycle: an E2E cycle from its App Review Workflow run, a
   * browser cycle from the record its reviewer gives a verdict.
   */
  const readAppReviews = Effect.fn("FeatureWorkflowReactor.readAppReviews")(function* (
    threadId: ThreadId,
    cycleBudget: number,
  ) {
    const reviews: FeatureAppReviewState[] = [];
    for (let cycle = 1; cycle <= cycleBudget; cycle += 1) {
      const e2eRun = yield* snapshots
        .getAppReviewWorkflowRun({ runId: featureE2eAppReviewRunId(threadId, cycle) })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isSome(e2eRun)) {
        const review = featureE2eAppReviewState(e2eRun.value);
        reviews.push(review);
        if (review.status !== "failed") break;
        continue;
      }
      const reviewThreadId = featureAppReviewThreadId(threadId, cycle);
      const detail = yield* snapshots
        .getThreadDetailById(reviewThreadId, { activityKinds: [] })
        .pipe(Effect.orElseSucceed(() => Option.none()));
      if (Option.isNone(detail)) break;
      const records = yield* native.getThreadRecords(reviewThreadId, ["runs"]).pipe(Effect.option);
      const run = Option.isNone(records) ? undefined : latestRun(records.value.runs);
      const reviewId = featureAppReviewId(threadId, cycle);
      const record = detail.value.appReviews.find((candidate) => candidate.id === reviewId) ?? null;
      // A reviewer that ended without a verdict failed: it never showed the change working.
      const status =
        run === undefined
          ? null
          : run.status !== "completed"
            ? "pending"
            : record?.status === "passed"
              ? "passed"
              : "failed";
      reviews.push({
        status,
        reportMarkdown: featureAppReviewReportMarkdown(record),
        evidenceMarkdown: FEATURE_BROWSER_APP_REVIEW_EVIDENCE,
      });
      if (status !== "failed") break;
    }
    return reviews;
  });

  const readAppReviewSkippedReason = Effect.fn("FeatureWorkflowReactor.readAppReviewSkippedReason")(
    function* (threadId: ThreadId) {
      const skipped = yield* snapshots
        .listActivitiesByKind(FEATURE_APP_REVIEW_SKIPPED_ACTIVITY_KIND)
        .pipe(Effect.orElseSucceed(() => []));
      const payload = skipped
        .map((activity) => activity.payload as { threadId?: unknown; reason?: unknown } | null)
        .findLast((candidate) => candidate?.threadId === threadId);
      return typeof payload?.reason === "string" ? payload.reason : null;
    },
  );

  /** The instruction the user's turn wrote: its final answer, which reviewers check against. */
  const readInstructionMarkdown = Effect.fn("FeatureWorkflowReactor.readInstructionMarkdown")(
    function* (
      threadId: ThreadId,
      runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "userMessageId">>,
    ) {
      const run = featureInstructionRun(threadId, runs);
      if (run === undefined) return null;
      const records = yield* native
        .getThreadRecords(threadId, ["messages"], { messageRoles: ["assistant"] })
        .pipe(Effect.option);
      if (Option.isNone(records)) return null;
      const text = records.value.messages.findLast(
        (message) => message.runId === run.id && !message.streaming,
      )?.text;
      return text?.trim() ? text : null;
    },
  );

  const resolveBaseBranch = Effect.fn("FeatureWorkflowReactor.resolveBaseBranch")(function* (
    thread: Pick<OrchestrationV2AppThread, "projectId" | "branch" | "worktreePath">,
    settings: ServerSettings | null,
  ) {
    if (thread.worktreePath === null) return null;
    // New worktrees record their base the way `gh` reads it; a branch rename keeps it.
    const recorded =
      thread.branch === null
        ? null
        : yield* git
            .readConfigValue(thread.worktreePath, `branch.${thread.branch}.gh-merge-base`)
            .pipe(Effect.orElseSucceed(() => null));
    if (recorded !== null && recorded.trim().length > 0) return recorded.trim();
    const development = yield* resolveProjectDevelopmentBranch({
      git,
      settings,
      cwd: thread.worktreePath,
      projectId: thread.projectId,
    });
    return development?.branch ?? null;
  });

  const isCompleted = Effect.fn("FeatureWorkflowReactor.isCompleted")(function* (
    threadId: ThreadId,
  ) {
    const completed = yield* snapshots
      .listActivitiesByKind(FEATURE_WORKFLOW_COMPLETED_ACTIVITY_KIND)
      .pipe(Effect.orElseSucceed(() => []));
    return completed.some(
      (activity) => (activity.payload as { threadId?: unknown } | null)?.threadId === threadId,
    );
  });

  /**
   * Whether the Feature's branch holds work to review and publish: uncommitted changes, or
   * commits that neither its base nor origin's copy of it has. Anything git cannot answer
   * counts as work, so a git failure never ends a Feature quietly.
   */
  const featureHasChanges = Effect.fn("FeatureWorkflowReactor.featureHasChanges")(function* (
    thread: Pick<OrchestrationV2AppThread, "projectId" | "branch" | "worktreePath">,
    settings: ServerSettings | null,
  ) {
    const cwd = thread.worktreePath;
    if (cwd === null) return true;
    const status = yield* git.statusDetailsLocal(cwd).pipe(Effect.option);
    if (Option.isNone(status) || !status.value.isRepo || status.value.hasWorkingTreeChanges) {
      return true;
    }
    const base = yield* resolveBaseBranch(thread, settings);
    if (base === null) return true;
    const runGit = (args: ReadonlyArray<string>) =>
      git
        .execute({
          operation: "FeatureWorkflowReactor.changesAheadOfBase",
          cwd,
          args,
          allowNonZeroExit: true,
        })
        .pipe(Effect.option);
    const baseRefs: string[] = [];
    for (const ref of [`origin/${base}`, base]) {
      const verified = yield* runGit(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
      if (Option.isSome(verified) && verified.value.exitCode === 0) baseRefs.push(ref);
    }
    if (baseRefs.length === 0) return true;
    const ahead = yield* runGit(["rev-list", "--count", "HEAD", "--not", ...baseRefs]);
    if (Option.isNone(ahead) || ahead.value.exitCode !== 0) return true;
    const count = Number.parseInt(ahead.value.stdout.trim(), 10);
    return !Number.isFinite(count) || count > 0;
  });

  /**
   * Starts one App Review cycle: the worktree's App Stack, then a review-only App Review
   * Workflow run that executes the project's E2E suites against it and records each test flow,
   * or, for a project without E2E suites, a reviewer that drives the stack in the preview
   * browser and records it. Returns true when the cycle cannot run, which it records so the
   * Feature moves on.
   */
  const launchAppReview = Effect.fn("FeatureWorkflowReactor.launchAppReview")(function* (input: {
    readonly cycle: number;
    readonly cycleBudget: number;
    readonly thread: OrchestrationV2AppThread;
    readonly settings: ServerSettings | null;
    readonly workflowShell: Option.Option<OrchestrationThreadShell>;
    readonly previousReportMarkdown: string | null;
    readonly instructionMarkdown: string | null;
  }) {
    const { thread, settings } = input;
    const reviewThreadId = featureAppReviewThreadId(thread.id, input.cycle);
    const launched = yield* snapshots
      .getThreadShellById(reviewThreadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    if (Option.isSome(launched)) return false;
    if (
      (yield* native.getThreadShell(reviewThreadId).pipe(Effect.orElseSucceed(() => null))) !== null
    )
      return false;

    const skip = Effect.fn("FeatureWorkflowReactor.skipAppReview")(function* (reason: string) {
      const createdAt = DateTime.formatIso(yield* DateTime.now);
      yield* workflowEngine.dispatch({
        type: "thread.activity.append",
        commandId: commandId("app-review-skipped", thread.id, input.cycle),
        threadId: thread.id,
        activity: {
          id: EventId.make(`feature-app-review-skipped:${thread.id}:${input.cycle}`),
          tone: "error",
          kind: FEATURE_APP_REVIEW_SKIPPED_ACTIVITY_KIND,
          summary: `App Review cycle ${input.cycle} could not run`,
          payload: { threadId: thread.id, cycle: input.cycle, reason },
          turnId: null,
          createdAt,
        },
        createdAt,
      });
      return true;
    });

    if (thread.worktreePath === null) {
      return yield* skip("the Feature has no worktree to start an App Stack from.");
    }
    const e2eCommands =
      settings !== null &&
      !resolveAppReviewStepParts({
        overrides: settings.workflowStepReviewParts,
        key: { workflowPromptId: APP_REVIEW_WORKFLOW_PROMPT_ID },
      }).e2e
        ? []
        : yield* projectFiles.loadStrict(thread.worktreePath).pipe(
            Effect.map((file) => resolveAppReviewE2eCommands(Option.getOrNull(file))),
            Effect.orElseSucceed((): ReadonlyArray<string> => []),
          );
    if (
      e2eCommands.length === 0 &&
      settings !== null &&
      !resolveProjectSettings(settings, thread.projectId).settings.enableAgentBrowserAccess
    ) {
      return yield* skip(
        "the project has no E2E suites and agent browser access is off, so nothing can test the app.",
      );
    }
    const workflowId =
      Option.getOrUndefined(input.workflowShell)?.workflowContext?.workflowId ??
      thread.workflowContext?.workflowId ??
      null;
    const stack = yield* appStacks
      .autoCreate({
        worktreePath: thread.worktreePath,
        displayName: `Feature ${thread.title}`.slice(0, 80).trim(),
        gitBranch: thread.branch,
        workflowId,
      })
      .pipe(Effect.result);
    if (stack._tag === "Failure") {
      return yield* skip(`its App Stack did not start (${stack.failure.message}).`);
    }
    const frontendUrl = stack.success.frontendUrl;
    if (frontendUrl === null) return yield* skip("its App Stack has no frontend to open.");

    const model = resolveWorkflowStepModelSelection({
      workflowPromptId: APP_REVIEW_PROMPT_ID,
      definition: undefined,
      stepModels: Option.getOrUndefined(input.workflowShell)?.workflowStepModels,
      workflow: "feature",
      parentModelSelection: thread.modelSelection,
      settings: settings ?? undefined,
    });
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    if (e2eCommands.length > 0) {
      // The run starts only once the Feature turn has settled in the workflow engine, which can
      // trail the native run; its next session update evaluates the Feature again.
      yield* workflowEngine
        .dispatch({
          type: "thread.app-review-workflow.launch",
          commandId: commandId("app-review", reviewThreadId),
          targetThreadId: thread.id,
          controllerThreadId: reviewThreadId,
          caller: { type: "standalone", sourceThreadId: thread.id },
          briefMarkdown: buildFeatureE2eAppReviewBrief({
            cycle: input.cycle,
            cycleBudget: input.cycleBudget,
            instructionMarkdown: input.instructionMarkdown,
            previousReportMarkdown: input.previousReportMarkdown,
          }),
          previewTargets: [frontendUrl],
          previewTargetsPinned: true,
          reviewOnly: true,
          appReviewScope: "e2e",
          cycleBudget: AppReviewWorkflowCycleBudget.make(1),
          modelSelection: model.modelSelection,
          createdAt,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logInfo("Feature E2E App Review is waiting to start", {
              threadId: thread.id,
              cycle: input.cycle,
              cause: Cause.pretty(cause),
            }),
          ),
        );
      return false;
    }
    yield* workflowEngine.dispatch({
      type: "thread.app-review.launch",
      commandId: commandId("app-review", reviewThreadId),
      sourceThreadId: thread.id,
      reviewThreadId,
      reviewId: featureAppReviewId(thread.id, input.cycle),
      appReviewScope: "browser",
      message: {
        messageId: featureAppReviewMessageId(reviewThreadId),
        role: "user",
        text: buildFeatureAppReviewMessage({
          cycle: input.cycle,
          cycleBudget: input.cycleBudget,
          frontendUrl,
          stackId: stack.success.stack?.id ?? null,
          worktreePath: thread.worktreePath,
          branch: thread.branch,
          baseBranch: yield* resolveBaseBranch(thread, settings),
          instructionMarkdown: input.instructionMarkdown,
          previousReportMarkdown: input.previousReportMarkdown,
        }),
        attachments: [],
      },
      modelSelection: model.modelSelection,
      runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
      workflowPromptId: APP_REVIEW_PROMPT_ID,
      createdAt,
    });
    return false;
  });

  const runAction = Effect.fn("FeatureWorkflowReactor.runAction")(function* (input: {
    readonly action: FeatureWorkflowAction;
    readonly thread: OrchestrationV2AppThread;
    readonly settings: ServerSettings | null;
    readonly cycleBudget: number;
    readonly appReviewCycleBudget: number;
    readonly appReviews: ReadonlyArray<FeatureAppReviewState>;
    /** The workflow engine's copy of the thread, which carries the run-local step settings. */
    readonly workflowShell: Option.Option<OrchestrationThreadShell>;
    readonly instructionMarkdown: Effect.Effect<string | null>;
  }) {
    const { action, thread, settings } = input;
    const instructions = settings?.workflowStepInstructions ?? {};
    const withSkill = (text: string, workflowPromptId: string) =>
      appendWorkflowStepInstructions(
        appendWorkflowSkillCommandSection(text, workflowPromptId),
        workflowPromptId,
        instructions,
      );
    const send = (messageId: ReturnType<typeof featureFixMessageId>, text: string) =>
      dispatch({
        type: "message.dispatch",
        commandId: commandId("message", messageId),
        threadId: thread.id,
        messageId,
        text,
        attachments: [],
        createdBy: "system",
        creationSource: "server",
        dispatchMode: { type: "start_immediately" },
      });
    switch (action.type) {
      case "answer-questions":
        return yield* dispatch({
          type: "runtime-request.respond",
          commandId: commandId("answer", thread.id, action.requestId),
          threadId: thread.id,
          requestId: action.requestId,
          answers: action.answers,
        });
      case "implement": {
        // The steps that follow run unattended, whatever mode the user's turn ran in.
        yield* dispatch({
          type: "thread.interaction-mode.set",
          commandId: commandId("implement-mode", thread.id),
          threadId: thread.id,
          interactionMode: "default",
        });
        yield* dispatch({
          type: "thread.runtime-mode.set",
          commandId: commandId("implement-runtime", thread.id),
          threadId: thread.id,
          runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
        });
        return yield* send(
          featureImplementMessageId(thread.id),
          appendWorkflowSkillCommandSection(
            withSkill(
              buildFeatureImplementMessage(),
              WORKFLOW_PROMPT_IDS.implementationFeatureCodex,
            ),
            "matt-pocock.tdd",
          ),
        );
      }
      case "app-review":
        return yield* launchAppReview({
          cycle: action.cycle,
          cycleBudget: input.appReviewCycleBudget,
          thread,
          settings,
          workflowShell: input.workflowShell,
          previousReportMarkdown:
            action.cycle > 1 ? (input.appReviews[action.cycle - 2]?.reportMarkdown ?? null) : null,
          instructionMarkdown: yield* input.instructionMarkdown,
        });
      case "app-review-fix":
        return yield* send(
          featureAppReviewFixMessageId(thread.id, action.cycle),
          buildFeatureAppReviewFixMessage({
            cycle: action.cycle,
            cycleBudget: input.appReviewCycleBudget,
            reportMarkdown: action.reportMarkdown,
          }),
        );
      case "review": {
        const reviewThreadId = featureReviewThreadId(thread.id, action.cycle);
        const existing = yield* native
          .getThreadShell(reviewThreadId)
          .pipe(Effect.orElseSucceed(() => null));
        if (existing === null) {
          const stepModels = Option.getOrUndefined(input.workflowShell)?.workflowStepModels;
          const model = resolveWorkflowStepModelSelection({
            workflowPromptId: CODE_REVIEW_PROMPT_ID,
            definition: undefined,
            stepModels,
            workflow: "feature",
            parentModelSelection: thread.modelSelection,
            settings: settings ?? undefined,
          });
          yield* dispatch({
            type: "thread.create",
            commandId: commandId("review-thread", reviewThreadId),
            threadId: reviewThreadId,
            projectId: thread.projectId,
            title: `Code Review · Cycle ${action.cycle} of ${input.cycleBudget}`,
            modelSelection: model.modelSelection,
            runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
            interactionMode: "default",
            branch: thread.branch,
            worktreePath: thread.worktreePath,
            ...(thread.ownerUserId === undefined ? {} : { ownerUserId: thread.ownerUserId }),
            parentThreadId: thread.id,
            workflowContext: thread.workflowContext ?? null,
            createdBy: "system",
            creationSource: "server",
          });
        }
        const messageId = featureReviewMessageId(reviewThreadId);
        return yield* dispatch({
          type: "message.dispatch",
          commandId: commandId("message", messageId),
          threadId: reviewThreadId,
          messageId,
          text: appendWorkflowStepInstructions(
            appendWorkflowSkillCommandSection(
              buildFeatureReviewMessage({
                cycle: action.cycle,
                cycleBudget: input.cycleBudget,
                worktreePath: thread.worktreePath,
                branch: thread.branch,
                baseBranch: yield* resolveBaseBranch(thread, settings),
                instructionMarkdown: yield* input.instructionMarkdown,
              }),
              "matt-pocock.code-review",
            ),
            CODE_REVIEW_PROMPT_ID,
            instructions,
          ),
          attachments: [],
          createdBy: "system",
          creationSource: "server",
          dispatchMode: { type: "start_immediately" },
        });
      }
      case "fix":
        return yield* send(
          featureFixMessageId(thread.id, action.cycle),
          buildFeatureFixMessage({
            cycle: action.cycle,
            cycleBudget: input.cycleBudget,
            reportMarkdown: action.reportMarkdown,
          }),
        );
      case "open-pull-request":
        return yield* send(
          featurePullRequestMessageId(thread.id),
          withSkill(
            buildFeaturePullRequestMessage({
              baseBranch: yield* resolveBaseBranch(thread, settings),
              appReview: action.appReview,
              unresolvedFindingsMarkdown: action.unresolvedFindingsMarkdown,
            }),
            WORKFLOW_PROMPT_IDS.implementationFeaturePullRequestCodex,
          ),
        );
      case "complete": {
        if (yield* isCompleted(thread.id)) return;
        const workflowId =
          Option.getOrUndefined(input.workflowShell)?.workflowContext?.workflowId ??
          thread.workflowContext?.workflowId ??
          null;
        const teardown =
          workflowId === null
            ? null
            : yield* appStacks.workflowTeardown({ workflowId }).pipe(
                Effect.tapError((error) =>
                  Effect.logWarning("Feature App Stack teardown failed", {
                    threadId: thread.id,
                    workflowId,
                    error,
                  }),
                ),
                Effect.orElseSucceed(() => null),
              );
        yield* dispatch({
          type: "thread.settle",
          commandId: commandId("settle", thread.id),
          threadId: thread.id,
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Feature thread could not be settled", {
              threadId: thread.id,
              cause: Cause.pretty(cause),
            }),
          ),
        );
        const createdAt = DateTime.formatIso(yield* DateTime.now);
        return yield* workflowEngine
          .dispatch({
            type: "thread.activity.append",
            commandId: commandId("completed", thread.id),
            threadId: thread.id,
            activity: {
              id: EventId.make(`feature-completed:${thread.id}`),
              tone: "info",
              kind: FEATURE_WORKFLOW_COMPLETED_ACTIVITY_KIND,
              summary: [
                action.reason === "no-changes"
                  ? "Finished without changes"
                  : "Feature finished: pull request linked",
                ...(teardown === null || teardown.stoppedStackIds.length === 0
                  ? []
                  : [`${teardown.stoppedStackIds.length} App Stack(s) stopped`]),
              ].join(", "),
              payload: {
                threadId: thread.id,
                reason: action.reason,
                workflowId,
                stoppedStackIds: teardown?.stoppedStackIds ?? [],
                skippedProtectedStackIds: teardown?.skippedProtectedStackIds ?? [],
                failedStackIds: teardown?.failedStackIds ?? [],
              },
              turnId: null,
              createdAt,
            },
            createdAt,
          })
          .pipe(Effect.asVoid);
      }
    }
  });

  /** Starts the steps due now. True when a skipped App Review means another step is due. */
  const evaluateOnce = Effect.fn("FeatureWorkflowReactor.evaluateOnce")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* native.getThreadShell(threadId);
    if (shell === null || shell.deletedAt !== null || !isFeatureRoot(shell)) return false;
    const records = yield* native.getThreadRecords(
      threadId,
      ["runs", "runtimeRequests", "turnItems"],
      { turnItemTypes: ["user_input_request"] },
    );
    const settings = yield* readSettings;
    const workflowShell = yield* snapshots
      .getThreadShellById(threadId)
      .pipe(Effect.orElseSucceed(() => Option.none()));
    const cycleBudget = resolveWorkflowStepCycleBudget({
      key: { workflowPromptId: CODE_REVIEW_PROMPT_ID },
      threadOverrides: Option.getOrUndefined(workflowShell)?.workflowStepCycles,
      settingsOverrides: settings?.workflowStepCycles,
    });
    const appReviewCycleBudget = resolveWorkflowStepCycleBudget({
      key: FEATURE_APP_REVIEW_CYCLE_KEY,
      threadOverrides: Option.getOrUndefined(workflowShell)?.workflowStepCycles,
      settingsOverrides: settings?.workflowStepCycles,
    });
    const runs = records.runs;
    const implemented = runs.some(
      (run) => run.userMessageId === featureImplementMessageId(threadId),
    );
    const pendingQuestions = records.runtimeRequests
      .filter((request) => request.kind === "user_input" && request.status === "pending")
      .flatMap((request) => {
        const item = records.turnItems.find(
          (candidate) =>
            candidate.type === "user_input_request" && candidate.requestId === request.id,
        );
        return item?.type === "user_input_request"
          ? [{ requestId: request.id, questions: item.questions }]
          : [];
      });
    const appReviews = implemented ? yield* readAppReviews(threadId, appReviewCycleBudget) : [];
    const actions = nextFeatureWorkflowActions({
      threadId,
      runs,
      pendingQuestions,
      appReviews,
      appReviewCycleBudget,
      appReviewSkippedReason: implemented ? yield* readAppReviewSkippedReason(threadId) : null,
      reviews: implemented ? yield* readReviews(threadId, cycleBudget) : [],
      cycleBudget,
      pullRequestLinked: visibleThreadPullRequests(records.thread.pullRequests ?? []).length > 0,
      completed: false,
    });
    // A finished Feature stays finished, even when someone keeps working in its thread.
    if (actions.length > 0 && (yield* isCompleted(threadId))) return false;
    const instructionMarkdown = yield* Effect.cached(readInstructionMarkdown(threadId, runs));
    let appReviewSkipped = false;
    for (const due of actions) {
      // A review needs something to review. When the implement or a fix turn left the branch
      // where it started, the Feature needed no change: finish without a review or pull request.
      const action: FeatureWorkflowAction =
        (due.type === "app-review" || due.type === "review") &&
        !(yield* featureHasChanges(records.thread, settings))
          ? { type: "complete", reason: "no-changes" }
          : due;
      const skipped = yield* runAction({
        action,
        thread: records.thread,
        settings,
        cycleBudget,
        appReviewCycleBudget,
        appReviews,
        workflowShell,
        instructionMarkdown,
      });
      if (skipped === true) appReviewSkipped = true;
    }
    return appReviewSkipped;
  });

  const evaluateUnsafe = Effect.fn("FeatureWorkflowReactor.evaluate")(function* (
    threadId: ThreadId,
  ) {
    // A skipped App Review produces no native event, so the next step is decided right away.
    if (yield* evaluateOnce(threadId)) yield* evaluateOnce(threadId);
  });

  const evaluate = (threadId: ThreadId) =>
    evaluateUnsafe(threadId).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("Feature workflow step failed", {
            threadId,
            cause: Cause.pretty(cause),
          }),
      ),
    );

  const worker = yield* makeDrainableWorker(evaluate);

  const onEvent = (event: OrchestrationV2DomainEvent) => {
    if (!TRIGGER_EVENT_TYPES.has(event.type)) return Effect.void;
    const rootThreadId = featureRootOfReviewThread(event.threadId) ?? event.threadId;
    return worker.enqueue(rootThreadId);
  };

  /**
   * Workflow-engine events that can move a Feature: an E2E App Review run changing, and a turn
   * settling, which a standalone App Review run waits for before it can start.
   */
  const onWorkflowEvent = (event: OrchestrationEvent) => {
    switch (event.type) {
      case "thread.app-review-workflow-launched":
      case "thread.app-review-workflow-updated": {
        const rootThreadId = featureRootOfReviewThread(event.payload.run.controllerThreadId);
        return rootThreadId === null ? Effect.void : worker.enqueue(rootThreadId);
      }
      case "thread.session-set":
        return event.payload.session.status === "running" ||
          event.payload.session.status === "starting"
          ? Effect.void
          : worker.enqueue(event.payload.threadId);
      default:
        return Effect.void;
    }
  };

  const reconcile = Effect.gen(function* () {
    const snapshot = yield* native.getShellSnapshot({ unsettledOnly: true });
    for (const thread of snapshot.threads) {
      if (thread.deletedAt === null && isFeatureRoot(thread)) yield* worker.enqueue(thread.id);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Feature workflow startup reconciliation failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  const logStreamStop = (cause: Cause.Cause<unknown>) =>
    Effect.logWarning("Feature workflow event stream stopped", { cause: Cause.pretty(cause) });

  return {
    start: Effect.fn("FeatureWorkflowReactor.start")(function* () {
      yield* forkParked(
        Stream.runForEach(native.streamDomainEvents, onEvent).pipe(
          Effect.catchCause(logStreamStop),
        ),
      );
      yield* forkParked(
        Stream.runForEach(workflowEngine.streamDomainEvents, onWorkflowEvent).pipe(
          Effect.catchCause(logStreamStop),
        ),
      );
      yield* forkParked(reconcile);
    }),
    evaluate: (threadId) => worker.enqueue(ThreadId.make(threadId)),
    drain: worker.drain,
  } satisfies FeatureWorkflowReactor["Service"];
});

export const layer = Layer.effect(FeatureWorkflowReactor, make);
