import {
  type AppDevStackStatus,
  CommandId,
  AppReviewId,
  hasCompleteAppReviewEvidence,
  hasScreenshotBackedAppReviewFailure,
  type AppReviewRecord,
  type AppReviewWorkflowCycle,
  type AppReviewWorkflowFailureReason,
  type AppReviewWorkflowFixResult,
  type AppReviewWorkflowRun,
  type AppReviewWorkflowWorkspaceRevision,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationProposedPlan,
  type OrchestrationThread,
  WORKFLOW_AUTOMATION_RUNTIME_MODE,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import { extractPreviewUrls } from "@t3tools/shared/preview";
import * as Cause from "effect/Cause";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { AppDevStackManager } from "../../appDevStack/AppDevStackManager.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import {
  appendWorkflowSkillCommandSection,
  WORKFLOW_PROMPT_IDS,
} from "../../provider/WorkflowPromptRegistry.ts";
import { ReviewService } from "../../review/ReviewService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  AppReviewWorkflowReactor,
  type AppReviewWorkflowReactorShape,
} from "../Services/AppReviewWorkflowReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  resolveWorkflowSubagentModelSelection,
  resolveWorkflowSubagentSpawnDefinition,
} from "../workflowSubagents.ts";

type AppReviewWorkflowEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.app-review-workflow-launched"
      | "thread.app-review-workflow-resume-requested"
      | "thread.app-review-workflow-cancel-requested"
      | "thread.app-review-updated"
      | "thread.proposed-plan-upserted"
      | "thread.turn-diff-completed"
      | "thread.activity-appended"
      | "thread.session-set";
  }
>;

const terminalStatuses = new Set(["passed", "failed", "exhausted"]);
const APP_REVIEW_IMPLEMENT_SKILL_ID = "matt-pocock.implement";

interface AppDevStackPreviewLookup {
  readonly stack: {
    readonly id: string;
    readonly displayName: string | null;
    readonly status: AppDevStackStatus;
    readonly services: ReadonlyArray<{
      readonly name: string;
      readonly status: string;
      readonly health?: string | null;
      readonly error?: string | null;
    }> | null;
  } | null;
  readonly frontendUrl: string | null;
}

export type StandalonePreviewTargetResolution =
  | { readonly _tag: "Resolved"; readonly previewTargets: ReadonlyArray<string> }
  | { readonly _tag: "Blocked"; readonly detailMarkdown: string };

export function selectStandalonePreviewTargets(input: {
  readonly lookup: AppDevStackPreviewLookup | null;
  readonly lookupError: string | null;
  readonly fallbackTargets: ReadonlyArray<string>;
}): StandalonePreviewTargetResolution {
  const fallbackTargets = Array.from(
    new Set(input.fallbackTargets.map((target) => target.trim()).filter(Boolean)),
  );
  const stackMatched = input.lookup?.stack !== null || input.lookup?.frontendUrl !== null;
  if (input.lookup !== null && stackMatched) {
    const stack = input.lookup.stack;
    if (stack !== null && stack.status !== "running") {
      return {
        _tag: "Blocked",
        detailMarkdown: `The App Dev Stack '${stack.displayName ?? stack.id}' for this worktree is '${stack.status}', not 'running'.`,
      };
    }
    const failedService = stack?.services?.find(
      (service) =>
        (service.error !== null && service.error !== undefined) ||
        service.health === "unhealthy" ||
        service.status === "error" ||
        service.status === "stopped",
    );
    if (failedService !== undefined) {
      return {
        _tag: "Blocked",
        detailMarkdown: `The App Dev Stack service '${failedService.name}' is unhealthy (${failedService.error ?? failedService.health ?? failedService.status}).`,
      };
    }
    if (input.lookup.frontendUrl === null) {
      return {
        _tag: "Blocked",
        detailMarkdown: "The App Dev Stack for this worktree has no frontend URL.",
      };
    }
    return { _tag: "Resolved", previewTargets: [input.lookup.frontendUrl] };
  }
  if (fallbackTargets.length > 0) {
    return { _tag: "Resolved", previewTargets: fallbackTargets };
  }
  return {
    _tag: "Blocked",
    detailMarkdown:
      input.lookupError === null
        ? "No App Dev Stack or fallback preview URL was found for this worktree. Start the App Dev Stack, then retry App Review."
        : `The App Dev Stack for this worktree could not be resolved, and no fallback preview URL is available. ${input.lookupError}`,
  };
}

export function nextAppReviewWorkflowAction(
  run: AppReviewWorkflowRun,
): "none" | "review" | "reconcile-review" | "reconcile-plan" | "reconcile-fix" {
  if (run.status !== "running") return "none";
  switch (run.activePhase) {
    case null:
      if (
        run.caller.type === "implementation" &&
        run.cycles.at(-1)?.fixResult?.status === "succeeded"
      ) {
        return "none";
      }
      return run.cyclesUsed < run.cycleBudget ? "review" : "none";
    case "review":
      return "reconcile-review";
    case "planning":
      return "reconcile-plan";
    case "fixing":
      return "reconcile-fix";
  }
}

export function selectReviewRunToStart(
  runId: AppReviewWorkflowRun["id"],
  runs: ReadonlyArray<AppReviewWorkflowRun>,
): AppReviewWorkflowRun | null {
  const run = runs.find((candidate) => candidate.id === runId);
  if (
    run === undefined ||
    run.status !== "running" ||
    run.activePhase !== null ||
    run.cyclesUsed >= run.cycleBudget
  ) {
    return null;
  }
  return run;
}

export function terminalReviewAction(review: AppReviewRecord): "passed" | "planning" {
  if (review.status === "passed" && review.document.verdict === "passed") return "passed";
  return "planning";
}

export function successfulFixAction(
  run: AppReviewWorkflowRun,
): "exhausted" | "review" | "await-preview-refresh" {
  if (run.cyclesUsed >= run.cycleBudget) return "exhausted";
  return run.caller.type === "standalone" ? "review" : "await-preview-refresh";
}

/**
 * A reviewer-authored verdict is not enough to close the workflow. Passing reviews must contain a
 * complete, internally consistent check matrix and must explicitly verify every actionable finding
 * from earlier cycles. This prevents a narrow happy-path rerun from silently closing a broader
 * failed review.
 */
export function terminalReviewPassFailure(input: {
  readonly run: AppReviewWorkflowRun;
  readonly review: AppReviewRecord;
  readonly priorReviews: ReadonlyArray<AppReviewRecord>;
}): string | null {
  if (input.review.status !== "passed" || input.review.document.verdict !== "passed") return null;
  const checks = input.review.document.checks;
  if (checks.length === 0) {
    return "Browser App Review reported a pass without a check matrix.";
  }
  const incompleteChecks = checks.filter((check) => check.status !== "passed");
  if (incompleteChecks.length > 0) {
    return `Browser App Review reported a pass with incomplete checks: ${incompleteChecks
      .map((check) => `${check.id}=${check.status}`)
      .join(", ")}.`;
  }
  const actionableFindings = input.review.document.findings.filter(
    (finding) => finding.severity !== "note",
  );
  if (actionableFindings.length > 0) {
    return `Browser App Review reported a pass with unresolved findings: ${actionableFindings
      .map((finding) => finding.id)
      .join(", ")}.`;
  }

  const currentCycle = input.run.cycles.at(-1)?.cycleNumber ?? 0;
  const priorReviewIds = new Set(
    input.run.cycles
      .filter((cycle) => cycle.cycleNumber < currentCycle)
      .map((cycle) => cycle.reviewId),
  );
  const priorFindingIds = input.priorReviews
    .filter((review) => priorReviewIds.has(review.id))
    .flatMap((review) => review.document.findings)
    .filter((finding) => finding.severity !== "note")
    .map((finding) => finding.id);
  const passedCheckIds = new Set(checks.map((check) => check.id));
  const missingFindingChecks = priorFindingIds.filter(
    (findingId) => !passedCheckIds.has(findingId),
  );
  if (missingFindingChecks.length > 0) {
    return `Browser App Review did not explicitly verify prior findings: ${missingFindingChecks.join(", ")}.`;
  }
  return null;
}

export function terminalReviewEvidenceFailure(
  action: ReturnType<typeof terminalReviewAction>,
  review: AppReviewRecord,
): string | null {
  if (hasCompleteAppReviewEvidence(review.evidence)) return null;
  if (
    action === "planning" &&
    hasScreenshotBackedAppReviewFailure(review.document, review.evidence)
  ) {
    return null;
  }
  return action === "passed"
    ? "Browser App Review completed without the required durable recording and screenshot evidence."
    : "Browser App Review reported product findings without a saved recording or screenshot-backed failed checks.";
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const gitWorkflow = yield* GitWorkflowService;
  const appDevStackManager = yield* AppDevStackManager;
  const reviewService = yield* ReviewService;
  const serverSettingsService = yield* ServerSettingsService;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const serverCommandId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => CommandId.make(`server:${tag}:${uuid}`)));
  const serverMessageId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => MessageId.make(`message-${tag}-${uuid}`)));
  const serverThreadId = (tag: string) =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => ThreadId.make(`thread-${tag}-${uuid}`)));
  const serverReviewId = () =>
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => AppReviewId.make(`app-review-${uuid}`)));

  const resolveThread = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrUndefined));

  const resolveTarget = Effect.fn("AppReviewWorkflowReactor.resolveTarget")(function* (
    threadId: ThreadId,
  ) {
    const [thread, readModel] = yield* Effect.all([
      resolveThread(threadId),
      projectionSnapshotQuery.getCommandReadModel(),
    ]);
    if (thread === undefined) return null;
    const project = readModel.projects.find((candidate) => candidate.id === thread.projectId);
    const cwd = thread.worktreePath ?? project?.workspaceRoot ?? null;
    return cwd === null ? null : { thread, cwd };
  });

  const updateRun = Effect.fn("AppReviewWorkflowReactor.updateRun")(function* (
    run: AppReviewWorkflowRun,
  ) {
    yield* orchestrationEngine.dispatch({
      type: "thread.app-review-workflow.update",
      commandId: yield* serverCommandId("app-review-workflow-update"),
      threadId: run.controllerThreadId,
      run,
      createdAt: run.updatedAt,
    });
  });

  const computeWorkspaceRevision = Effect.fn("AppReviewWorkflowReactor.computeWorkspaceRevision")(
    function* (cwd: string) {
      const [head, preview] = yield* Effect.all([
        gitWorkflow.resolveCommit({ cwd, ref: "HEAD" }),
        reviewService.getDiffPreview({ cwd }),
      ]);
      const workingTreeDiffHash =
        preview.sources.find((source) => source.kind === "working-tree")?.diffHash ?? "missing";
      const branchDiffHash =
        preview.sources.find((source) => source.kind === "branch-range")?.diffHash ?? "missing";
      return {
        headSha: head.commitSha,
        workingTreeDiffHash,
        branchDiffHash,
        fingerprint: `${head.commitSha}:${workingTreeDiffHash}:${branchDiffHash}`,
      } satisfies AppReviewWorkflowWorkspaceRevision;
    },
  );

  const failRun = Effect.fn("AppReviewWorkflowReactor.failRun")(function* (input: {
    readonly run: AppReviewWorkflowRun;
    readonly reason: AppReviewWorkflowFailureReason;
    readonly detailMarkdown: string;
    readonly occurredAt: string;
  }) {
    if (terminalStatuses.has(input.run.status)) return;
    const cycleNumber = input.run.cycles.at(-1)?.cycleNumber ?? null;
    yield* updateRun({
      ...input.run,
      status: "failed",
      outcome: "failed",
      activePhase: null,
      activeThreadId: null,
      finalHeadSha:
        input.run.workspaceRevision.headSha === "pending"
          ? null
          : input.run.workspaceRevision.headSha,
      failure: {
        reason: input.reason,
        phase: input.run.activePhase,
        cycleNumber,
        detailMarkdown: input.detailMarkdown,
        failedAt: input.occurredAt,
      },
      cycles: input.run.cycles.map((cycle) =>
        cycle.cycleNumber === cycleNumber
          ? {
              ...cycle,
              status: "completed",
              reviewVerdict: cycle.reviewVerdict === "passed" ? "passed" : "failed",
              completedAt: input.occurredAt,
            }
          : cycle,
      ),
      updatedAt: input.occurredAt,
      completedAt: input.occurredAt,
    });
  });

  const assertStableRevision = Effect.fn("AppReviewWorkflowReactor.assertStableRevision")(
    function* (run: AppReviewWorkflowRun, cwd: string, occurredAt: string) {
      const current = yield* computeWorkspaceRevision(cwd);
      if (run.workspaceRevision.fingerprint === "pending") {
        const next = { ...run, workspaceRevision: current, updatedAt: occurredAt };
        yield* updateRun(next);
        return next;
      }
      if (current.fingerprint !== run.workspaceRevision.fingerprint) {
        yield* failRun({
          run,
          reason: "workspace-stale",
          detailMarkdown:
            "The worktree changed outside the active App Review phase. Start a fresh run against the new workspace revision.",
          occurredAt,
        });
        return null;
      }
      return run;
    },
  );

  const resolveStandalonePreviewTargetsForRun = Effect.fn(
    "AppReviewWorkflowReactor.resolveStandalonePreviewTargetsForRun",
  )(function* (run: AppReviewWorkflowRun, cwd: string, occurredAt: string) {
    if (run.caller.type !== "standalone") return run;
    const lookupResult = yield* appDevStackManager
      .getByWorktree({ worktreePath: cwd })
      .pipe(Effect.result);
    const resolution = selectStandalonePreviewTargets({
      lookup: lookupResult._tag === "Success" ? lookupResult.success : null,
      lookupError:
        lookupResult._tag === "Failure"
          ? lookupResult.failure instanceof Error
            ? lookupResult.failure.message
            : String(lookupResult.failure)
          : null,
      fallbackTargets: [...extractPreviewUrls(run.briefMarkdown), ...run.previewTargets],
    });
    if (resolution._tag === "Blocked") {
      yield* failRun({
        run,
        reason: "preview-unavailable",
        detailMarkdown: resolution.detailMarkdown,
        occurredAt,
      });
      return null;
    }
    if (
      resolution.previewTargets.length === run.previewTargets.length &&
      resolution.previewTargets.every((target, index) => target === run.previewTargets[index])
    ) {
      return run;
    }
    const updatedRun = {
      ...run,
      previewTargets: [...resolution.previewTargets],
      updatedAt: occurredAt,
    } satisfies AppReviewWorkflowRun;
    yield* updateRun(updatedRun);
    return updatedRun;
  });

  const modelForPrompt = Effect.fn("AppReviewWorkflowReactor.modelForPrompt")(function* (
    workflowPromptId: string,
    parent: OrchestrationThread,
  ) {
    const settings = yield* serverSettingsService.getSettings.pipe(
      Effect.orElseSucceed(() => undefined),
    );
    return resolveWorkflowSubagentModelSelection({
      definition: resolveWorkflowSubagentSpawnDefinition(workflowPromptId),
      parentModelSelection: parent.modelSelection,
      settings,
    }).modelSelection;
  });

  const buildReviewPrompt = (
    run: AppReviewWorkflowRun,
    cycle: AppReviewWorkflowCycle,
    priorFindingIds: ReadonlyArray<string>,
  ) =>
    appendWorkflowSkillCommandSection(
      [
        `Run Browser App Review cycle ${cycle.cycleNumber} of ${run.cycleBudget}.`,
        "",
        "The original brief is the acceptance boundary for every cycle:",
        run.briefMarkdown,
        ...(run.supportingContextMarkdown === null
          ? []
          : ["", "Supporting source context:", run.supportingContextMarkdown]),
        "",
        "Preview targets (try in order):",
        ...run.previewTargets.map((target) => `- ${target}`),
        "These preview targets are authoritative for this App Review cycle. Do not substitute deployment URLs from repository documentation, supporting source context, browser history, or environment conventions. If every listed target is unavailable, report the review failed with concrete details.",
        "",
        "Use the linked durable App Review record. Record the complete flow, capture captioned screenshots, and report every actionable finding. A missing or unavailable preview is a failed review.",
        "A passed verdict requires a non-empty check matrix in which every check is passed. Do not mark required or deferred acceptance work not-applicable; use failed or blocked with concrete detail.",
        ...(priorFindingIds.length === 0
          ? []
          : [
              "",
              "This is a repair verification cycle. Add one passed check with the exact same id for every prior actionable finding before reporting passed:",
              ...priorFindingIds.map((findingId) => `- ${findingId}`),
            ]),
      ].join("\n"),
      WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
    );

  const ensureReviewLaunch = Effect.fn("AppReviewWorkflowReactor.ensureReviewLaunch")(function* (
    run: AppReviewWorkflowRun,
    cycle: AppReviewWorkflowCycle,
  ) {
    const reviewer = yield* resolveThread(cycle.reviewerThreadId);
    if (reviewer !== undefined) return;
    const controller = yield* resolveThread(run.controllerThreadId);
    if (controller === undefined) {
      yield* failRun({
        run,
        reason: "unknown",
        detailMarkdown: "The App Review controller thread is unavailable.",
        occurredAt: run.updatedAt,
      });
      return;
    }
    const priorReviewIds = new Set(
      run.cycles
        .filter((candidate) => candidate.cycleNumber < cycle.cycleNumber)
        .map((candidate) => candidate.reviewId),
    );
    const priorFindingIds = controller.appReviews
      .filter((review) => priorReviewIds.has(review.id))
      .flatMap((review) => review.document.findings)
      .filter((finding) => finding.severity !== "note")
      .map((finding) => finding.id);
    yield* orchestrationEngine.dispatch({
      type: "thread.app-review.launch",
      commandId: yield* serverCommandId("app-review-workflow-review-launch"),
      sourceThreadId: run.controllerThreadId,
      reviewThreadId: cycle.reviewerThreadId,
      reviewId: cycle.reviewId,
      planningTicketIds: [...(controller.workflowContext?.ticketScope ?? [])],
      message: {
        messageId: yield* serverMessageId("app-review-workflow-review"),
        role: "user",
        text: buildReviewPrompt(run, cycle, priorFindingIds),
        attachments: [],
      },
      modelSelection: yield* modelForPrompt(
        WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
        controller,
      ),
      runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
      workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
      createdAt: run.updatedAt,
    });
  });

  const startReview = Effect.fn("AppReviewWorkflowReactor.startReview")(function* (
    inputRun: AppReviewWorkflowRun,
    occurredAt: string,
  ) {
    // Resume/launch requests can be duplicated while projections and sibling reactors settle. Use
    // the latest persisted run, not the event's stale payload, so only one reviewer can claim the
    // next cycle.
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const currentRun = selectReviewRunToStart(inputRun.id, readModel.appReviewWorkflowRuns ?? []);
    if (currentRun === null) return;
    const target = yield* resolveTarget(currentRun.targetThreadId);
    if (target === null) {
      yield* failRun({
        run: currentRun,
        reason: "unknown",
        detailMarkdown: "The target worktree is unavailable.",
        occurredAt,
      });
      return;
    }
    const cwd = target.cwd;
    const stableRun = yield* assertStableRevision(currentRun, cwd, occurredAt);
    if (stableRun === null) return;
    const run = yield* resolveStandalonePreviewTargetsForRun(stableRun, cwd, occurredAt);
    if (run === null) return;
    if (run.caller.type === "implementation") {
      const status = yield* gitWorkflow.status({ cwd });
      if (!status.isRepo || status.hasWorkingTreeChanges) {
        yield* failRun({
          run,
          reason: "embedded-worktree-dirty",
          detailMarkdown:
            "Embedded App Review requires a clean Implementation orchestrator branch.",
          occurredAt,
        });
        return;
      }
    }
    const cycleNumber = run.cyclesUsed + 1;
    const cycle: AppReviewWorkflowCycle = {
      cycleNumber,
      status: "reviewing",
      reviewId: yield* serverReviewId(),
      reviewerThreadId: yield* serverThreadId("app-review-reviewer"),
      reviewVerdict: null,
      actionableFindingsMarkdown: null,
      planId: null,
      plannerTurnId: null,
      fixerThreadId: null,
      fixResult: null,
      workspaceRevision: run.workspaceRevision,
      startedAt: occurredAt,
      completedAt: null,
    };
    const reviewingRun: AppReviewWorkflowRun = {
      ...run,
      cyclesUsed: cycleNumber,
      cycles: [...run.cycles, cycle],
      activePhase: "review",
      activeThreadId: cycle.reviewerThreadId,
      updatedAt: occurredAt,
    };
    yield* updateRun(reviewingRun);
    yield* ensureReviewLaunch(reviewingRun, cycle);
  });

  const reviewRecordForCycle = (
    controller: OrchestrationThread,
    cycle: AppReviewWorkflowCycle,
  ): AppReviewRecord | null =>
    controller.appReviews.find((review) => review.id === cycle.reviewId) ?? null;

  const hasSettledCheckpoint = (thread: OrchestrationThread): boolean => {
    const turn = thread.latestTurn;
    return (
      turn !== null &&
      turn.state !== "running" &&
      thread.checkpoints.some((checkpoint) => checkpoint.turnId === turn.turnId)
    );
  };

  const threadTurnFailed = (thread: OrchestrationThread): boolean =>
    thread.latestTurn?.state === "error" ||
    thread.latestTurn?.state === "interrupted" ||
    thread.session?.status === "error" ||
    thread.session?.status === "stopped";

  const findingsMarkdown = (review: AppReviewRecord) =>
    review.document.findings
      .map(
        (finding, index) =>
          `${index + 1}. [${finding.severity}] ${finding.title}\n\n${finding.details}\n\nReproduction: ${finding.reproduction}`,
      )
      .join("\n\n");

  const finishPassed = Effect.fn("AppReviewWorkflowReactor.finishPassed")(function* (
    run: AppReviewWorkflowRun,
    review: AppReviewRecord,
    occurredAt: string,
  ) {
    const cycle = run.cycles.at(-1);
    if (cycle === undefined) return;
    yield* updateRun({
      ...run,
      status: "passed",
      outcome: "passed",
      activePhase: null,
      activeThreadId: null,
      finalHeadSha: run.workspaceRevision.headSha,
      failure: null,
      cycles: run.cycles.map((entry) =>
        entry.cycleNumber === cycle.cycleNumber
          ? {
              ...entry,
              status: "completed",
              reviewVerdict: "passed",
              completedAt: occurredAt,
            }
          : entry,
      ),
      updatedAt: occurredAt,
      completedAt: occurredAt,
    });
  });

  const finishExhausted = Effect.fn("AppReviewWorkflowReactor.finishExhausted")(function* (
    run: AppReviewWorkflowRun,
    occurredAt: string,
  ) {
    yield* updateRun({
      ...run,
      status: "exhausted",
      outcome: "exhausted",
      activePhase: null,
      activeThreadId: null,
      finalHeadSha: run.workspaceRevision.headSha,
      failure: null,
      updatedAt: occurredAt,
      completedAt: occurredAt,
    });
  });

  const startPlanning = Effect.fn("AppReviewWorkflowReactor.startPlanning")(function* (input: {
    readonly run: AppReviewWorkflowRun;
    readonly review: AppReviewRecord;
    readonly actionableFindingsMarkdown: string;
    readonly occurredAt: string;
  }) {
    const reviewer = yield* resolveThread(input.review.reviewThreadId);
    const target = yield* resolveTarget(input.run.targetThreadId);
    const cycle = input.run.cycles.at(-1);
    if (reviewer === undefined || cycle === undefined || target === null) {
      yield* failRun({
        run: input.run,
        reason: "unknown",
        detailMarkdown: "The App Review thread or target worktree disappeared.",
        occurredAt: input.occurredAt,
      });
      return;
    }
    const cwd = target.cwd;
    const stableRun = yield* assertStableRevision(input.run, cwd, input.occurredAt);
    if (stableRun === null) return;
    const planningRun: AppReviewWorkflowRun = {
      ...stableRun,
      activePhase: "planning",
      activeThreadId: reviewer.id,
      cycles: stableRun.cycles.map((entry) =>
        entry.cycleNumber === cycle.cycleNumber
          ? {
              ...entry,
              status: "planning",
              reviewVerdict: "failed",
              actionableFindingsMarkdown: input.actionableFindingsMarkdown,
            }
          : entry,
      ),
      updatedAt: input.occurredAt,
    };
    yield* updateRun(planningRun);
    yield* orchestrationEngine.dispatch({
      type: "thread.interaction-mode.set",
      commandId: yield* serverCommandId("app-review-workflow-plan-mode"),
      threadId: reviewer.id,
      interactionMode: "plan",
      createdAt: input.occurredAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.runtime-mode.set",
      commandId: yield* serverCommandId("app-review-workflow-plan-runtime"),
      threadId: reviewer.id,
      runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
      createdAt: input.occurredAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("app-review-workflow-plan-turn"),
      threadId: reviewer.id,
      message: {
        messageId: yield* serverMessageId("app-review-workflow-plan"),
        role: "user",
        text: [
          `Analyze the product gap and create one non-interactive repair plan for App Review cycle ${cycle.cycleNumber}.`,
          "",
          "Stay in this App Review thread so the browser evidence, gap analysis, and plan share one history. Do not edit files. Do not ask questions. Compare the original acceptance brief with the observed UI behavior, cover every actionable finding together, and exit Plan mode with exactly one ordinary persisted proposed plan.",
          "",
          "Original acceptance brief:",
          planningRun.briefMarkdown,
          "",
          "Complete actionable findings:",
          input.actionableFindingsMarkdown,
        ].join("\n"),
        attachments: [],
      },
      runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
      interactionMode: "plan",
      createdAt: input.occurredAt,
    });
  });

  const reconcileReview = Effect.fn("AppReviewWorkflowReactor.reconcileReview")(function* (
    run: AppReviewWorkflowRun,
    occurredAt: string,
  ) {
    const cycle = run.cycles.at(-1);
    if (run.activePhase !== "review" || cycle === undefined) return;
    const [controller, reviewer] = yield* Effect.all([
      resolveThread(run.controllerThreadId),
      resolveThread(cycle.reviewerThreadId),
    ]);
    if (reviewer === undefined) {
      yield* ensureReviewLaunch(run, cycle);
      return;
    }
    const review = controller === undefined ? null : reviewRecordForCycle(controller, cycle);
    if (
      (review === null || !["passed", "failed"].includes(review.status)) &&
      threadTurnFailed(reviewer)
    ) {
      yield* failRun({
        run,
        reason: "review-blocked",
        detailMarkdown:
          reviewer.session?.lastError ??
          "Browser App Review stopped without producing a terminal durable review.",
        occurredAt,
      });
      return;
    }
    if (review === null || !["passed", "failed"].includes(review.status)) return;
    if (!hasSettledCheckpoint(reviewer)) return;
    const target = yield* resolveTarget(run.targetThreadId);
    if (target === null) return;
    const stableRun = yield* assertStableRevision(run, target.cwd, occurredAt);
    if (stableRun === null) return;
    const action = terminalReviewAction(review);
    const passFailure = terminalReviewPassFailure({
      run: stableRun,
      review,
      priorReviews: controller?.appReviews ?? [],
    });
    if (passFailure !== null) {
      yield* startPlanning({
        run: stableRun,
        review,
        actionableFindingsMarkdown: passFailure,
        occurredAt,
      });
      return;
    }
    const evidenceFailure = terminalReviewEvidenceFailure(action, review);
    if (evidenceFailure !== null) {
      yield* startPlanning({
        run: stableRun,
        review,
        actionableFindingsMarkdown: evidenceFailure,
        occurredAt,
      });
      return;
    }
    if (action === "passed") {
      yield* finishPassed(stableRun, review, occurredAt);
      return;
    }
    const actionableFindingsMarkdown =
      findingsMarkdown(review) ||
      review.document.summary ||
      "The App Review failed without details.";
    yield* startPlanning({
      run: stableRun,
      review,
      actionableFindingsMarkdown,
      occurredAt,
    });
  });

  const buildFixPrompt = (input: {
    readonly run: AppReviewWorkflowRun;
    readonly cycle: AppReviewWorkflowCycle;
    readonly plan: OrchestrationProposedPlan;
  }) =>
    appendWorkflowSkillCommandSection(
      [
        `Implement the persisted App Review repair plan '${input.plan.id}' for run '${input.run.id}'.`,
        "",
        "Use TDD. Address every actionable finding together, preserve unrelated work, and run focused validation. Do not ask the user questions.",
        input.run.caller.type === "implementation"
          ? "Commit the complete repair, leave the orchestrator worktree clean, and report a commit SHA matching HEAD."
          : "Edit the selected worktree in place. A commit and initially clean worktree are not required; preserve unrelated WIP and rely on T3 checkpoints for recovery.",
        "",
        "Original acceptance brief:",
        input.run.briefMarkdown,
        "",
        "Actionable findings:",
        input.cycle.actionableFindingsMarkdown ?? "Missing findings",
        "",
        "Persisted proposed plan:",
        input.plan.planMarkdown,
        "",
        "Finish with exactly one fenced JSON block:",
        "```json",
        JSON.stringify(
          {
            type: "app-review-fix-result",
            runId: input.run.id,
            planId: input.plan.id,
            status: "succeeded",
            commitSha: input.run.caller.type === "implementation" ? "required-HEAD-sha" : undefined,
            validations: [
              {
                command: "vp test run focused-test",
                status: "passed",
                outputMarkdown: "Important output or empty string.",
                completedAt: "2026-01-01T00:00:00.000Z",
              },
            ],
            notesMarkdown: "What changed and what remains.",
          },
          null,
          2,
        ),
        "```",
      ].join("\n"),
      APP_REVIEW_IMPLEMENT_SKILL_ID,
    );

  const ensureFixerLaunch = Effect.fn("AppReviewWorkflowReactor.ensureFixerLaunch")(function* (
    run: AppReviewWorkflowRun,
    cycle: AppReviewWorkflowCycle,
    plan: OrchestrationProposedPlan,
  ) {
    if (cycle.fixerThreadId === null) return;
    const existing = yield* resolveThread(cycle.fixerThreadId);
    if (existing !== undefined) return;
    const reviewer = yield* resolveThread(cycle.reviewerThreadId);
    const target = yield* resolveThread(run.targetThreadId);
    if (reviewer === undefined || target === undefined) return;
    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: yield* serverCommandId("app-review-workflow-fixer-create"),
      threadId: cycle.fixerThreadId,
      projectId: target.projectId,
      ownerUserId: target.ownerUserId,
      parentThreadId: reviewer.id,
      workflowRole: "app-review-fixer",
      workflowContext: reviewer.workflowContext ?? null,
      title: `App Review implementation ${cycle.cycleNumber}`,
      modelSelection: yield* modelForPrompt(APP_REVIEW_IMPLEMENT_SKILL_ID, reviewer),
      runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
      interactionMode: "default",
      workflowPreset: "app-review",
      branch: target.branch,
      worktreePath: target.worktreePath,
      createdAt: run.updatedAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("app-review-workflow-fixer-turn"),
      threadId: cycle.fixerThreadId,
      message: {
        messageId: yield* serverMessageId("app-review-workflow-fixer"),
        role: "user",
        text: buildFixPrompt({ run, cycle, plan }),
        attachments: [],
      },
      runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
      interactionMode: "default",
      workflowPromptId: APP_REVIEW_IMPLEMENT_SKILL_ID,
      sourceProposedPlan: { threadId: reviewer.id, planId: plan.id },
      createdAt: run.updatedAt,
    });
  });

  const startFixer = Effect.fn("AppReviewWorkflowReactor.startFixer")(function* (input: {
    readonly run: AppReviewWorkflowRun;
    readonly plan: OrchestrationProposedPlan;
    readonly plannerTurnId: AppReviewWorkflowCycle["plannerTurnId"];
    readonly occurredAt: string;
  }) {
    const target = yield* resolveTarget(input.run.targetThreadId);
    const cycle = input.run.cycles.at(-1);
    if (target === null || cycle === undefined) {
      return;
    }
    const stableRun = yield* assertStableRevision(input.run, target.cwd, input.occurredAt);
    if (stableRun === null) return;
    yield* orchestrationEngine.dispatch({
      type: "thread.interaction-mode.set",
      commandId: yield* serverCommandId("app-review-workflow-default-mode"),
      threadId: cycle.reviewerThreadId,
      interactionMode: "default",
      createdAt: input.occurredAt,
    });
    const fixerThreadId = yield* serverThreadId("app-review-fixer");
    const fixingCycle: AppReviewWorkflowCycle = {
      ...cycle,
      status: "fixing",
      planId: input.plan.id,
      plannerTurnId: input.plannerTurnId,
      fixerThreadId,
    };
    const fixingRun: AppReviewWorkflowRun = {
      ...stableRun,
      activePhase: "fixing",
      activeThreadId: fixerThreadId,
      cycles: stableRun.cycles.map((entry) =>
        entry.cycleNumber === cycle.cycleNumber ? fixingCycle : entry,
      ),
      updatedAt: input.occurredAt,
    };
    yield* updateRun(fixingRun);
    yield* ensureFixerLaunch(fixingRun, fixingCycle, input.plan);
  });

  const reconcilePlanning = Effect.fn("AppReviewWorkflowReactor.reconcilePlanning")(function* (
    run: AppReviewWorkflowRun,
    occurredAt: string,
  ) {
    if (run.activePhase !== "planning") return;
    const cycle = run.cycles.at(-1);
    if (cycle === undefined) return;
    const reviewer = yield* resolveThread(cycle.reviewerThreadId);
    if (reviewer === undefined) return;
    if (threadTurnFailed(reviewer) && !hasSettledCheckpoint(reviewer)) {
      yield* failRun({
        run,
        reason: "plan-missing",
        detailMarkdown:
          reviewer.session?.lastError ??
          "The non-interactive planning turn stopped without a settled plan checkpoint.",
        occurredAt,
      });
      return;
    }
    if (!hasSettledCheckpoint(reviewer)) return;
    const turn = reviewer.latestTurn;
    if (turn === null) return;
    if (turn.state === "error" || turn.state === "interrupted") {
      yield* failRun({
        run,
        reason: "plan-missing",
        detailMarkdown: "The non-interactive planning turn did not complete successfully.",
        occurredAt,
      });
      return;
    }
    const plans = reviewer.proposedPlans.filter((candidate) => candidate.turnId === turn.turnId);
    if (plans.length === 0) {
      yield* failRun({
        run,
        reason: "plan-missing",
        detailMarkdown:
          "The App Review thread completed gap analysis without one persisted proposed plan.",
        occurredAt,
      });
      return;
    }
    const plan = plans[0]!;
    if (plans.length !== 1 || plan.planMarkdown.trim().length === 0) {
      yield* failRun({
        run,
        reason: "plan-malformed",
        detailMarkdown:
          "The App Review thread must persist exactly one non-empty proposed plan for the repair cycle.",
        occurredAt,
      });
      return;
    }
    yield* startFixer({ run, plan, plannerTurnId: turn.turnId, occurredAt });
  });

  const parseFixResult = (
    thread: OrchestrationThread,
    run: AppReviewWorkflowRun,
    cycle: AppReviewWorkflowCycle,
  ): AppReviewWorkflowFixResult | null => {
    for (const activity of thread.activities.toReversed()) {
      if (activity.kind !== "app-review-fix-result" || !Predicate.isObject(activity.payload)) {
        continue;
      }
      const payload = activity.payload as Record<string, unknown>;
      if (
        payload["type"] !== "app-review-fix-result" ||
        payload["runId"] !== run.id ||
        payload["planId"] !== cycle.planId
      ) {
        continue;
      }
      const status = payload["status"];
      if (status !== "succeeded" && status !== "failed" && status !== "blocked") return null;
      const validations = Array.isArray(payload["validations"])
        ? (payload["validations"] as AppReviewWorkflowFixResult["validations"])
        : [];
      return {
        runId: run.id,
        planId: cycle.planId ?? "missing",
        status,
        ...(Predicate.isString(payload["commitSha"]) ? { commitSha: payload["commitSha"] } : {}),
        validations,
        notesMarkdown: Predicate.isString(payload["notesMarkdown"]) ? payload["notesMarkdown"] : "",
      };
    }
    return null;
  };

  const reconcileFixer = Effect.fn("AppReviewWorkflowReactor.reconcileFixer")(function* (
    run: AppReviewWorkflowRun,
    occurredAt: string,
  ) {
    const cycle = run.cycles.at(-1);
    if (run.activePhase !== "fixing" || cycle?.fixerThreadId === null || cycle === undefined)
      return;
    const fixer = yield* resolveThread(cycle.fixerThreadId);
    if (fixer === undefined) {
      const reviewer = yield* resolveThread(cycle.reviewerThreadId);
      const plan = reviewer?.proposedPlans.find((candidate) => candidate.id === cycle.planId);
      if (plan !== undefined) yield* ensureFixerLaunch(run, cycle, plan);
      return;
    }
    const result = parseFixResult(fixer, run, cycle);
    if (result === null && threadTurnFailed(fixer)) {
      yield* failRun({
        run,
        reason: "fixer-failed",
        detailMarkdown:
          fixer.session?.lastError ??
          "The App Review implementation thread stopped without the required result directive.",
        occurredAt,
      });
      return;
    }
    if (result === null || !hasSettledCheckpoint(fixer)) return;
    if (result.status !== "succeeded") {
      yield* failRun({
        run,
        reason: "fixer-failed",
        detailMarkdown: result.notesMarkdown || `The App Review implementation ${result.status}.`,
        occurredAt,
      });
      return;
    }
    if (
      result.validations.length === 0 ||
      result.validations.some((validation) => validation.status !== "passed")
    ) {
      yield* failRun({
        run,
        reason: "fixer-failed",
        detailMarkdown:
          "The App Review implementation thread did not report successful focused validation.",
        occurredAt,
      });
      return;
    }
    const target = yield* resolveTarget(run.targetThreadId);
    if (target === null) return;
    const revision = yield* computeWorkspaceRevision(target.cwd);
    if (run.caller.type === "implementation") {
      const status = yield* gitWorkflow.status({ cwd: target.cwd });
      if (!status.isRepo || status.hasWorkingTreeChanges) {
        yield* failRun({
          run,
          reason: "embedded-worktree-dirty",
          detailMarkdown: "The embedded fixer did not leave a clean orchestrator worktree.",
          occurredAt,
        });
        return;
      }
      if (
        result.commitSha === null ||
        result.commitSha === undefined ||
        result.commitSha !== revision.headSha
      ) {
        yield* failRun({
          run,
          reason: "embedded-head-mismatch",
          detailMarkdown: "The embedded fixer commit does not match the orchestrator HEAD.",
          occurredAt,
        });
        return;
      }
    }
    const completedRun: AppReviewWorkflowRun = {
      ...run,
      activePhase: null,
      activeThreadId: null,
      workspaceRevision: revision,
      cycles: run.cycles.map((entry) =>
        entry.cycleNumber === cycle.cycleNumber
          ? { ...entry, status: "completed", fixResult: result, completedAt: occurredAt }
          : entry,
      ),
      updatedAt: occurredAt,
    };
    yield* updateRun(completedRun);
    switch (successfulFixAction(completedRun)) {
      case "exhausted":
        yield* finishExhausted(completedRun, occurredAt);
        return;
      case "review":
        yield* startReview(completedRun, occurredAt);
        return;
      case "await-preview-refresh":
        return;
    }
  });

  const reconcileRun = Effect.fn("AppReviewWorkflowReactor.reconcileRun")(function* (
    run: AppReviewWorkflowRun,
    occurredAt: string,
  ) {
    switch (nextAppReviewWorkflowAction(run)) {
      case "none":
        return;
      case "review":
        yield* startReview(run, occurredAt);
        return;
      case "reconcile-review":
        yield* reconcileReview(run, occurredAt);
        return;
      case "reconcile-plan":
        yield* reconcilePlanning(run, occurredAt);
        return;
      case "reconcile-fix":
        yield* reconcileFixer(run, occurredAt);
        return;
    }
  });

  const runForEvent = Effect.fn("AppReviewWorkflowReactor.runForEvent")(function* (
    event: AppReviewWorkflowEvent,
  ) {
    if (
      event.type === "thread.app-review-workflow-launched" ||
      event.type === "thread.app-review-workflow-resume-requested"
    ) {
      return event.payload.run;
    }
    if (event.type === "thread.app-review-workflow-cancel-requested") return null;
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const runs = readModel.appReviewWorkflowRuns ?? [];
    if (event.type === "thread.app-review-updated") {
      return (
        runs.find((run) => run.cycles.some((cycle) => cycle.reviewId === event.payload.reviewId)) ??
        null
      );
    }
    const threadId = event.payload.threadId;
    return (
      runs.find(
        (run) =>
          run.status === "running" &&
          (run.controllerThreadId === threadId ||
            run.activeThreadId === threadId ||
            run.cycles.some(
              (cycle) => cycle.reviewerThreadId === threadId || cycle.fixerThreadId === threadId,
            )),
      ) ?? null
    );
  });

  const processEvent = Effect.fn("AppReviewWorkflowReactor.processEvent")(function* (
    event: AppReviewWorkflowEvent,
  ) {
    if (event.type === "thread.app-review-workflow-cancel-requested") {
      const cycle = event.payload.run.cycles.at(-1);
      const activeThreadId =
        cycle?.status === "reviewing"
          ? cycle.reviewerThreadId
          : cycle?.status === "fixing"
            ? cycle.fixerThreadId
            : cycle?.status === "planning"
              ? event.payload.run.controllerThreadId
              : null;
      if (activeThreadId !== null && activeThreadId !== undefined) {
        yield* orchestrationEngine.dispatch({
          type: "thread.turn.interrupt",
          commandId: yield* serverCommandId("app-review-workflow-cancel-interrupt"),
          threadId: activeThreadId,
          createdAt: event.occurredAt,
        });
      }
      return;
    }
    if (event.type === "thread.app-review-workflow-resume-requested") {
      yield* startReview(event.payload.run, event.occurredAt);
      return;
    }
    if (event.type === "thread.activity-appended") {
      const run = yield* runForEvent(event);
      if (run === null) return;
      if (
        event.payload.activity.kind === "approval.requested" ||
        event.payload.activity.kind === "user-input.requested"
      ) {
        yield* failRun({
          run,
          reason:
            event.payload.activity.kind === "approval.requested"
              ? "unexpected-approval"
              : "unexpected-user-input",
          detailMarkdown: `Unattended App Review received an unexpected ${event.payload.activity.kind === "approval.requested" ? "approval" : "user-input"} request.`,
          occurredAt: event.occurredAt,
        });
        return;
      }
    }
    if (event.type === "thread.session-set" && event.payload.session.status === "error") {
      const run = yield* runForEvent(event);
      if (run !== null && run.activeThreadId === event.payload.threadId) {
        yield* failRun({
          run,
          reason:
            run.activePhase === "fixing"
              ? "fixer-failed"
              : run.activePhase === "review"
                ? "review-blocked"
                : "unknown",
          detailMarkdown:
            event.payload.session.lastError ??
            `The ${run.activePhase ?? "workflow"} provider session failed.`,
          occurredAt: event.occurredAt,
        });
        return;
      }
    }
    const run = yield* runForEvent(event);
    if (run !== null) yield* reconcileRun(run, event.occurredAt);
  });

  const processEventSafely = (event: AppReviewWorkflowEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.gen(function* () {
              const run = yield* runForEvent(event).pipe(Effect.orElseSucceed(() => null));
              if (run !== null && run.status === "running") {
                yield* failRun({
                  run,
                  reason: "automation-unavailable",
                  detailMarkdown: `App Review automation failed while processing ${event.type}.\n\n${Cause.pretty(cause)}`,
                  occurredAt: event.occurredAt,
                }).pipe(Effect.catch(() => Effect.void));
                return;
              }
              yield* Effect.logWarning("App Review workflow reactor failed to process event", {
                eventType: event.type,
                cause: Cause.pretty(cause),
              });
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const reconcileRuns = Effect.fn("AppReviewWorkflowReactor.reconcileRuns")(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const occurredAt = yield* nowIso;
    for (const run of readModel.appReviewWorkflowRuns ?? []) {
      if (run.status !== "running") continue;
      yield* reconcileRun(run, occurredAt).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : failRun({
                run,
                reason: "automation-unavailable",
                detailMarkdown: `App Review automation was unavailable during restart recovery.\n\n${Cause.pretty(cause)}`,
                occurredAt,
              }).pipe(Effect.catch(() => Effect.void)),
        ),
      );
    }
  });

  const reconcile: AppReviewWorkflowReactorShape["reconcile"] = () =>
    reconcileRuns().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("App Review workflow reconciliation failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const start: AppReviewWorkflowReactorShape["start"] = Effect.fn("start")(function* () {
    yield* reconcile();
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.app-review-workflow-launched" &&
          event.type !== "thread.app-review-workflow-resume-requested" &&
          event.type !== "thread.app-review-workflow-cancel-requested" &&
          event.type !== "thread.app-review-updated" &&
          event.type !== "thread.proposed-plan-upserted" &&
          event.type !== "thread.turn-diff-completed" &&
          event.type !== "thread.activity-appended" &&
          event.type !== "thread.session-set"
        ) {
          return Effect.void;
        }
        return worker.enqueue(event);
      }),
    );
  });

  return { start, drain: worker.drain, reconcile } satisfies AppReviewWorkflowReactorShape;
});

export const AppReviewWorkflowReactorLive = Layer.effect(AppReviewWorkflowReactor, make);
