import {
  type AppDevStackStatus,
  CommandId,
  DevReviewId,
  type DevReviewRecord,
  type DevReviewWorkflowCycle,
  type DevReviewWorkflowFailureReason,
  type DevReviewWorkflowFixResult,
  type DevReviewWorkflowRun,
  type DevReviewWorkflowWorkspaceRevision,
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
  DevReviewWorkflowReactor,
  type DevReviewWorkflowReactorShape,
} from "../Services/DevReviewWorkflowReactor.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import {
  resolveWorkflowSubagentModelSelection,
  resolveWorkflowSubagentSpawnDefinition,
} from "../workflowSubagents.ts";

type DevReviewWorkflowEvent = Extract<
  OrchestrationEvent,
  {
    type:
      | "thread.dev-review-workflow-launched"
      | "thread.dev-review-workflow-resume-requested"
      | "thread.dev-review-workflow-cancel-requested"
      | "thread.dev-review-updated"
      | "thread.proposed-plan-upserted"
      | "thread.turn-diff-completed"
      | "thread.activity-appended"
      | "thread.session-set";
  }
>;

const terminalStatuses = new Set(["passed", "exhausted", "blocked", "canceled"]);

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
        ? "No App Dev Stack or fallback preview URL was found for this worktree. Start the App Dev Stack, then retry Dev Review."
        : `The App Dev Stack for this worktree could not be resolved, and no fallback preview URL is available. ${input.lookupError}`,
  };
}

export function nextDevReviewWorkflowAction(
  run: DevReviewWorkflowRun,
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
      return run.attemptsUsed < run.cycleBudget ? "review" : "none";
    case "review":
      return "reconcile-review";
    case "planning":
      return "reconcile-plan";
    case "fixing":
      return "reconcile-fix";
  }
}

export function terminalReviewAction(
  run: DevReviewWorkflowRun,
  review: DevReviewRecord,
): "passed" | "blocked" | "exhausted" | "planning" {
  if (review.status === "blocked" || review.document.verdict === "blocked") return "blocked";
  if (review.status === "passed" && review.document.verdict === "passed") return "passed";
  if (review.document.findings.length === 0) return "blocked";
  return run.attemptsUsed >= run.cycleBudget ? "exhausted" : "planning";
}

export function terminalReviewEvidenceFailure(
  action: ReturnType<typeof terminalReviewAction>,
  review: DevReviewRecord,
): string | null {
  // A blocked reviewer may be unable to open the preview at all, so requiring browser evidence
  // before preserving its block reason replaces the actionable infrastructure failure with a
  // misleading "missing evidence" error. Evidence remains mandatory for every product verdict.
  if (action === "blocked") return null;
  if (review.evidence.recording.status === "saved" && review.evidence.screenshots.length > 0) {
    return null;
  }
  return "Browser Dev Review completed without the required durable recording and screenshot evidence.";
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
    crypto.randomUUIDv4.pipe(Effect.map((uuid) => DevReviewId.make(`dev-review-${uuid}`)));

  const resolveThread = (threadId: ThreadId) =>
    projectionSnapshotQuery.getThreadDetailById(threadId).pipe(Effect.map(Option.getOrUndefined));

  const resolveTarget = Effect.fn("DevReviewWorkflowReactor.resolveTarget")(function* (
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

  const updateRun = Effect.fn("DevReviewWorkflowReactor.updateRun")(function* (
    run: DevReviewWorkflowRun,
  ) {
    yield* orchestrationEngine.dispatch({
      type: "thread.dev-review-workflow.update",
      commandId: yield* serverCommandId("dev-review-workflow-update"),
      threadId: run.controllerThreadId,
      run,
      createdAt: run.updatedAt,
    });
  });

  const computeWorkspaceRevision = Effect.fn("DevReviewWorkflowReactor.computeWorkspaceRevision")(
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
      } satisfies DevReviewWorkflowWorkspaceRevision;
    },
  );

  const blockRun = Effect.fn("DevReviewWorkflowReactor.blockRun")(function* (input: {
    readonly run: DevReviewWorkflowRun;
    readonly reason: DevReviewWorkflowFailureReason;
    readonly detailMarkdown: string;
    readonly occurredAt: string;
  }) {
    if (terminalStatuses.has(input.run.status)) return;
    const cycleNumber = input.run.cycles.at(-1)?.cycleNumber ?? null;
    yield* updateRun({
      ...input.run,
      status: "blocked",
      outcome: "blocked",
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
          ? { ...cycle, status: "blocked", completedAt: input.occurredAt }
          : cycle,
      ),
      updatedAt: input.occurredAt,
      completedAt: input.occurredAt,
    });
  });

  const assertStableRevision = Effect.fn("DevReviewWorkflowReactor.assertStableRevision")(
    function* (run: DevReviewWorkflowRun, cwd: string, occurredAt: string) {
      const current = yield* computeWorkspaceRevision(cwd);
      if (run.workspaceRevision.fingerprint === "pending") {
        const next = { ...run, workspaceRevision: current, updatedAt: occurredAt };
        yield* updateRun(next);
        return next;
      }
      if (current.fingerprint !== run.workspaceRevision.fingerprint) {
        yield* blockRun({
          run,
          reason: "workspace-stale",
          detailMarkdown:
            "The worktree changed outside the active Dev Review phase. Start a fresh run against the new workspace revision.",
          occurredAt,
        });
        return null;
      }
      return run;
    },
  );

  const resolveStandalonePreviewTargetsForRun = Effect.fn(
    "DevReviewWorkflowReactor.resolveStandalonePreviewTargetsForRun",
  )(function* (run: DevReviewWorkflowRun, cwd: string, occurredAt: string) {
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
      yield* blockRun({
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
    } satisfies DevReviewWorkflowRun;
    yield* updateRun(updatedRun);
    return updatedRun;
  });

  const modelForPrompt = Effect.fn("DevReviewWorkflowReactor.modelForPrompt")(function* (
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

  const buildReviewPrompt = (run: DevReviewWorkflowRun, cycle: DevReviewWorkflowCycle) =>
    appendWorkflowSkillCommandSection(
      [
        `Run Browser Dev Review cycle ${cycle.cycleNumber} of ${run.cycleBudget}.`,
        "",
        "The original brief is the acceptance boundary for every cycle:",
        run.briefMarkdown,
        ...(run.supportingContextMarkdown === null
          ? []
          : ["", "Supporting source context:", run.supportingContextMarkdown]),
        "",
        "Preview targets (try in order):",
        ...run.previewTargets.map((target) => `- ${target}`),
        "These preview targets are authoritative for this Dev Review cycle. Do not substitute deployment URLs from repository documentation, supporting source context, browser history, or environment conventions. If every listed target is unavailable, report the review blocked.",
        "",
        "Use the linked durable Dev Review record. Record the complete flow, capture captioned screenshots, and report every actionable finding. A missing or unavailable preview is blocked, not failed.",
      ].join("\n"),
      WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
    );

  const ensureReviewLaunch = Effect.fn("DevReviewWorkflowReactor.ensureReviewLaunch")(function* (
    run: DevReviewWorkflowRun,
    cycle: DevReviewWorkflowCycle,
  ) {
    const reviewer = yield* resolveThread(cycle.reviewerThreadId);
    if (reviewer !== undefined) return;
    const controller = yield* resolveThread(run.controllerThreadId);
    if (controller === undefined) {
      yield* blockRun({
        run,
        reason: "unknown",
        detailMarkdown: "The Dev Review controller thread is unavailable.",
        occurredAt: run.updatedAt,
      });
      return;
    }
    yield* orchestrationEngine.dispatch({
      type: "thread.dev-review.launch",
      commandId: yield* serverCommandId("dev-review-workflow-review-launch"),
      sourceThreadId: run.controllerThreadId,
      reviewThreadId: cycle.reviewerThreadId,
      reviewId: cycle.reviewId,
      planningTicketIds: [...(controller.workflowContext?.ticketScope ?? [])],
      message: {
        messageId: yield* serverMessageId("dev-review-workflow-review"),
        role: "user",
        text: buildReviewPrompt(run, cycle),
        attachments: [],
      },
      modelSelection: yield* modelForPrompt(
        WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
        controller,
      ),
      runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
      workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
      createdAt: run.updatedAt,
    });
  });

  const startReview = Effect.fn("DevReviewWorkflowReactor.startReview")(function* (
    inputRun: DevReviewWorkflowRun,
    occurredAt: string,
  ) {
    if (inputRun.status !== "running" || inputRun.attemptsUsed >= inputRun.cycleBudget) return;
    const target = yield* resolveTarget(inputRun.targetThreadId);
    if (target === null) {
      yield* blockRun({
        run: inputRun,
        reason: "unknown",
        detailMarkdown: "The target worktree is unavailable.",
        occurredAt,
      });
      return;
    }
    const cwd = target.cwd;
    const stableRun = yield* assertStableRevision(inputRun, cwd, occurredAt);
    if (stableRun === null) return;
    const run = yield* resolveStandalonePreviewTargetsForRun(stableRun, cwd, occurredAt);
    if (run === null) return;
    if (run.caller.type === "implementation") {
      const status = yield* gitWorkflow.status({ cwd });
      if (!status.isRepo || status.hasWorkingTreeChanges) {
        yield* blockRun({
          run,
          reason: "embedded-worktree-dirty",
          detailMarkdown:
            "Embedded Dev Review requires a clean Implementation orchestrator branch.",
          occurredAt,
        });
        return;
      }
    }
    const cycleNumber = run.attemptsUsed + 1;
    const cycle: DevReviewWorkflowCycle = {
      cycleNumber,
      status: "reviewing",
      reviewId: yield* serverReviewId(),
      reviewerThreadId: yield* serverThreadId("dev-review-reviewer"),
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
    const reviewingRun: DevReviewWorkflowRun = {
      ...run,
      attemptsUsed: cycleNumber,
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
    cycle: DevReviewWorkflowCycle,
  ): DevReviewRecord | null =>
    controller.devReviews.find((review) => review.id === cycle.reviewId) ?? null;

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

  const findingsMarkdown = (review: DevReviewRecord) =>
    review.document.findings
      .map(
        (finding, index) =>
          `${index + 1}. [${finding.severity}] ${finding.title}\n\n${finding.details}\n\nReproduction: ${finding.reproduction}`,
      )
      .join("\n\n");

  const finishPassed = Effect.fn("DevReviewWorkflowReactor.finishPassed")(function* (
    run: DevReviewWorkflowRun,
    review: DevReviewRecord,
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
              reviewVerdict: review.document.verdict,
              completedAt: occurredAt,
            }
          : entry,
      ),
      updatedAt: occurredAt,
      completedAt: occurredAt,
    });
  });

  const finishExhausted = Effect.fn("DevReviewWorkflowReactor.finishExhausted")(function* (
    run: DevReviewWorkflowRun,
    review: DevReviewRecord,
    actionableFindingsMarkdown: string,
    occurredAt: string,
  ) {
    const cycle = run.cycles.at(-1);
    if (cycle === undefined) return;
    yield* updateRun({
      ...run,
      status: "exhausted",
      outcome: "exhausted",
      activePhase: null,
      activeThreadId: null,
      finalHeadSha: run.workspaceRevision.headSha,
      failure: null,
      cycles: run.cycles.map((entry) =>
        entry.cycleNumber === cycle.cycleNumber
          ? {
              ...entry,
              status: "completed",
              reviewVerdict: review.document.verdict,
              actionableFindingsMarkdown,
              completedAt: occurredAt,
            }
          : entry,
      ),
      updatedAt: occurredAt,
      completedAt: occurredAt,
    });
  });

  const startPlanning = Effect.fn("DevReviewWorkflowReactor.startPlanning")(function* (input: {
    readonly run: DevReviewWorkflowRun;
    readonly review: DevReviewRecord;
    readonly actionableFindingsMarkdown: string;
    readonly occurredAt: string;
  }) {
    const controller = yield* resolveThread(input.run.controllerThreadId);
    const target = yield* resolveTarget(input.run.targetThreadId);
    const cycle = input.run.cycles.at(-1);
    if (controller === undefined || cycle === undefined || target === null) {
      yield* blockRun({
        run: input.run,
        reason: "unknown",
        detailMarkdown: "The Dev Review controller or target worktree disappeared.",
        occurredAt: input.occurredAt,
      });
      return;
    }
    const cwd = target.cwd;
    const stableRun = yield* assertStableRevision(input.run, cwd, input.occurredAt);
    if (stableRun === null) return;
    const planningRun: DevReviewWorkflowRun = {
      ...stableRun,
      activePhase: "planning",
      activeThreadId: controller.id,
      cycles: stableRun.cycles.map((entry) =>
        entry.cycleNumber === cycle.cycleNumber
          ? {
              ...entry,
              status: "planning",
              reviewVerdict: input.review.document.verdict,
              actionableFindingsMarkdown: input.actionableFindingsMarkdown,
            }
          : entry,
      ),
      updatedAt: input.occurredAt,
    };
    yield* updateRun(planningRun);
    yield* orchestrationEngine.dispatch({
      type: "thread.interaction-mode.set",
      commandId: yield* serverCommandId("dev-review-workflow-plan-mode"),
      threadId: controller.id,
      interactionMode: "plan",
      createdAt: input.occurredAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.runtime-mode.set",
      commandId: yield* serverCommandId("dev-review-workflow-plan-runtime"),
      threadId: controller.id,
      runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
      createdAt: input.occurredAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("dev-review-workflow-plan-turn"),
      threadId: controller.id,
      message: {
        messageId: yield* serverMessageId("dev-review-workflow-plan"),
        role: "user",
        text: [
          `Create one non-interactive repair plan for Dev Review cycle ${cycle.cycleNumber}.`,
          "",
          "Do not edit files. Do not ask questions. Explore the worktree as needed, cover every actionable finding together, and exit Plan mode with one ordinary persisted proposed plan.",
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

  const reconcileReview = Effect.fn("DevReviewWorkflowReactor.reconcileReview")(function* (
    run: DevReviewWorkflowRun,
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
      (review === null || !["passed", "failed", "blocked"].includes(review.status)) &&
      threadTurnFailed(reviewer)
    ) {
      yield* blockRun({
        run,
        reason: "review-blocked",
        detailMarkdown:
          reviewer.session?.lastError ??
          "Browser Dev Review stopped without producing a terminal durable review.",
        occurredAt,
      });
      return;
    }
    if (review === null || !["passed", "failed", "blocked"].includes(review.status)) return;
    if (!hasSettledCheckpoint(reviewer)) return;
    const target = yield* resolveTarget(run.targetThreadId);
    if (target === null) return;
    const stableRun = yield* assertStableRevision(run, target.cwd, occurredAt);
    if (stableRun === null) return;
    const action = terminalReviewAction(stableRun, review);
    if (action === "blocked") {
      yield* blockRun({
        run: stableRun,
        reason: "review-blocked",
        detailMarkdown: review.document.summary || "Browser Dev Review was blocked.",
        occurredAt,
      });
      return;
    }
    const evidenceFailure = terminalReviewEvidenceFailure(action, review);
    if (evidenceFailure !== null) {
      yield* blockRun({
        run: stableRun,
        reason: "review-blocked",
        detailMarkdown: evidenceFailure,
        occurredAt,
      });
      return;
    }
    if (action === "passed") {
      yield* finishPassed(stableRun, review, occurredAt);
      return;
    }
    const actionableFindingsMarkdown = findingsMarkdown(review);
    if (action === "exhausted") {
      yield* finishExhausted(stableRun, review, actionableFindingsMarkdown, occurredAt);
      return;
    }
    yield* startPlanning({
      run: stableRun,
      review,
      actionableFindingsMarkdown,
      occurredAt,
    });
  });

  const buildFixPrompt = (input: {
    readonly run: DevReviewWorkflowRun;
    readonly cycle: DevReviewWorkflowCycle;
    readonly plan: OrchestrationProposedPlan;
  }) =>
    appendWorkflowSkillCommandSection(
      [
        `Implement the persisted Dev Review repair plan '${input.plan.id}' for run '${input.run.id}'.`,
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
            type: "dev-review-fix-result",
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
      WORKFLOW_PROMPT_IDS.implementationTddCodex,
    );

  const ensureFixerLaunch = Effect.fn("DevReviewWorkflowReactor.ensureFixerLaunch")(function* (
    run: DevReviewWorkflowRun,
    cycle: DevReviewWorkflowCycle,
    plan: OrchestrationProposedPlan,
  ) {
    if (cycle.fixerThreadId === null) return;
    const existing = yield* resolveThread(cycle.fixerThreadId);
    if (existing !== undefined) return;
    const controller = yield* resolveThread(run.controllerThreadId);
    const target = yield* resolveThread(run.targetThreadId);
    if (controller === undefined || target === undefined) return;
    yield* orchestrationEngine.dispatch({
      type: "thread.create",
      commandId: yield* serverCommandId("dev-review-workflow-fixer-create"),
      threadId: cycle.fixerThreadId,
      projectId: target.projectId,
      ownerUserId: target.ownerUserId,
      parentThreadId: controller.id,
      workflowRole: "dev-review-fixer",
      workflowContext: controller.workflowContext ?? null,
      title: `Dev Review repair ${cycle.cycleNumber}`,
      modelSelection: yield* modelForPrompt(WORKFLOW_PROMPT_IDS.implementationTddCodex, controller),
      runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
      interactionMode: "default",
      workflowPreset: "dev-review",
      branch: target.branch,
      worktreePath: target.worktreePath,
      createdAt: run.updatedAt,
    });
    yield* orchestrationEngine.dispatch({
      type: "thread.turn.start",
      commandId: yield* serverCommandId("dev-review-workflow-fixer-turn"),
      threadId: cycle.fixerThreadId,
      message: {
        messageId: yield* serverMessageId("dev-review-workflow-fixer"),
        role: "user",
        text: buildFixPrompt({ run, cycle, plan }),
        attachments: [],
      },
      runtimeMode: WORKFLOW_AUTOMATION_RUNTIME_MODE,
      interactionMode: "default",
      workflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
      sourceProposedPlan: { threadId: controller.id, planId: plan.id },
      createdAt: run.updatedAt,
    });
  });

  const startFixer = Effect.fn("DevReviewWorkflowReactor.startFixer")(function* (input: {
    readonly run: DevReviewWorkflowRun;
    readonly plan: OrchestrationProposedPlan;
    readonly plannerTurnId: DevReviewWorkflowCycle["plannerTurnId"];
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
      commandId: yield* serverCommandId("dev-review-workflow-default-mode"),
      threadId: stableRun.controllerThreadId,
      interactionMode: "default",
      createdAt: input.occurredAt,
    });
    const fixerThreadId = yield* serverThreadId("dev-review-fixer");
    const fixingCycle: DevReviewWorkflowCycle = {
      ...cycle,
      status: "fixing",
      planId: input.plan.id,
      plannerTurnId: input.plannerTurnId,
      fixerThreadId,
    };
    const fixingRun: DevReviewWorkflowRun = {
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

  const reconcilePlanning = Effect.fn("DevReviewWorkflowReactor.reconcilePlanning")(function* (
    run: DevReviewWorkflowRun,
    occurredAt: string,
  ) {
    if (run.activePhase !== "planning") return;
    const controller = yield* resolveThread(run.controllerThreadId);
    if (controller === undefined) return;
    if (threadTurnFailed(controller) && !hasSettledCheckpoint(controller)) {
      yield* blockRun({
        run,
        reason: "plan-missing",
        detailMarkdown:
          controller.session?.lastError ??
          "The non-interactive planning turn stopped without a settled plan checkpoint.",
        occurredAt,
      });
      return;
    }
    if (!hasSettledCheckpoint(controller)) return;
    const turn = controller.latestTurn;
    if (turn === null) return;
    if (turn.state === "error" || turn.state === "interrupted") {
      yield* blockRun({
        run,
        reason: "plan-missing",
        detailMarkdown: "The non-interactive planning turn did not complete successfully.",
        occurredAt,
      });
      return;
    }
    const plans = controller.proposedPlans.filter((candidate) => candidate.turnId === turn.turnId);
    if (plans.length === 0) {
      yield* blockRun({
        run,
        reason: "plan-missing",
        detailMarkdown: "The controller completed Plan mode without one persisted proposed plan.",
        occurredAt,
      });
      return;
    }
    const plan = plans[0]!;
    if (plans.length !== 1 || plan.planMarkdown.trim().length === 0) {
      yield* blockRun({
        run,
        reason: "plan-malformed",
        detailMarkdown:
          "The controller must persist exactly one non-empty proposed plan for the repair cycle.",
        occurredAt,
      });
      return;
    }
    yield* startFixer({ run, plan, plannerTurnId: turn.turnId, occurredAt });
  });

  const parseFixResult = (
    thread: OrchestrationThread,
    run: DevReviewWorkflowRun,
    cycle: DevReviewWorkflowCycle,
  ): DevReviewWorkflowFixResult | null => {
    for (const activity of thread.activities.toReversed()) {
      if (activity.kind !== "dev-review-fix-result" || !Predicate.isObject(activity.payload)) {
        continue;
      }
      const payload = activity.payload as Record<string, unknown>;
      if (
        payload["type"] !== "dev-review-fix-result" ||
        payload["runId"] !== run.id ||
        payload["planId"] !== cycle.planId
      ) {
        continue;
      }
      const status = payload["status"];
      if (status !== "succeeded" && status !== "failed" && status !== "blocked") return null;
      const validations = Array.isArray(payload["validations"])
        ? (payload["validations"] as DevReviewWorkflowFixResult["validations"])
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

  const reconcileFixer = Effect.fn("DevReviewWorkflowReactor.reconcileFixer")(function* (
    run: DevReviewWorkflowRun,
    occurredAt: string,
  ) {
    const cycle = run.cycles.at(-1);
    if (run.activePhase !== "fixing" || cycle?.fixerThreadId === null || cycle === undefined)
      return;
    const fixer = yield* resolveThread(cycle.fixerThreadId);
    if (fixer === undefined) {
      const controller = yield* resolveThread(run.controllerThreadId);
      const plan = controller?.proposedPlans.find((candidate) => candidate.id === cycle.planId);
      if (plan !== undefined) yield* ensureFixerLaunch(run, cycle, plan);
      return;
    }
    const result = parseFixResult(fixer, run, cycle);
    if (result === null && threadTurnFailed(fixer)) {
      yield* blockRun({
        run,
        reason: "fixer-failed",
        detailMarkdown:
          fixer.session?.lastError ??
          "The Dev Review fixer stopped without the required result directive.",
        occurredAt,
      });
      return;
    }
    if (result === null || !hasSettledCheckpoint(fixer)) return;
    if (result.status !== "succeeded") {
      yield* blockRun({
        run,
        reason: "fixer-failed",
        detailMarkdown: result.notesMarkdown || `The Dev Review fixer ${result.status}.`,
        occurredAt,
      });
      return;
    }
    if (
      result.validations.length === 0 ||
      result.validations.some((validation) => validation.status !== "passed")
    ) {
      yield* blockRun({
        run,
        reason: "fixer-failed",
        detailMarkdown: "The Dev Review fixer did not report successful focused validation.",
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
        yield* blockRun({
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
        yield* blockRun({
          run,
          reason: "embedded-head-mismatch",
          detailMarkdown: "The embedded fixer commit does not match the orchestrator HEAD.",
          occurredAt,
        });
        return;
      }
    }
    const completedRun: DevReviewWorkflowRun = {
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
    if (completedRun.caller.type === "standalone") {
      yield* startReview(completedRun, occurredAt);
    }
  });

  const reconcileRun = Effect.fn("DevReviewWorkflowReactor.reconcileRun")(function* (
    run: DevReviewWorkflowRun,
    occurredAt: string,
  ) {
    switch (nextDevReviewWorkflowAction(run)) {
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

  const runForEvent = Effect.fn("DevReviewWorkflowReactor.runForEvent")(function* (
    event: DevReviewWorkflowEvent,
  ) {
    if (
      event.type === "thread.dev-review-workflow-launched" ||
      event.type === "thread.dev-review-workflow-resume-requested"
    ) {
      return event.payload.run;
    }
    if (event.type === "thread.dev-review-workflow-cancel-requested") return null;
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const runs = readModel.devReviewWorkflowRuns ?? [];
    if (event.type === "thread.dev-review-updated") {
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

  const processEvent = Effect.fn("DevReviewWorkflowReactor.processEvent")(function* (
    event: DevReviewWorkflowEvent,
  ) {
    if (event.type === "thread.dev-review-workflow-cancel-requested") {
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
          commandId: yield* serverCommandId("dev-review-workflow-cancel-interrupt"),
          threadId: activeThreadId,
          createdAt: event.occurredAt,
        });
      }
      return;
    }
    if (event.type === "thread.dev-review-workflow-resume-requested") {
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
        yield* blockRun({
          run,
          reason:
            event.payload.activity.kind === "approval.requested"
              ? "unexpected-approval"
              : "unexpected-user-input",
          detailMarkdown: `Unattended Dev Review received an unexpected ${event.payload.activity.kind === "approval.requested" ? "approval" : "user-input"} request.`,
          occurredAt: event.occurredAt,
        });
        return;
      }
    }
    if (event.type === "thread.session-set" && event.payload.session.status === "error") {
      const run = yield* runForEvent(event);
      if (run !== null && run.activeThreadId === event.payload.threadId) {
        yield* blockRun({
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

  const processEventSafely = (event: DevReviewWorkflowEvent) =>
    processEvent(event).pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.gen(function* () {
              const run = yield* runForEvent(event).pipe(Effect.orElseSucceed(() => null));
              if (run !== null && run.status === "running") {
                yield* blockRun({
                  run,
                  reason: "automation-unavailable",
                  detailMarkdown: `Dev Review automation failed while processing ${event.type}.\n\n${Cause.pretty(cause)}`,
                  occurredAt: event.occurredAt,
                }).pipe(Effect.catch(() => Effect.void));
                return;
              }
              yield* Effect.logWarning("Dev Review workflow reactor failed to process event", {
                eventType: event.type,
                cause: Cause.pretty(cause),
              });
            }),
      ),
    );

  const worker = yield* makeDrainableWorker(processEventSafely);

  const reconcileRuns = Effect.fn("DevReviewWorkflowReactor.reconcileRuns")(function* () {
    const readModel = yield* projectionSnapshotQuery.getCommandReadModel();
    const occurredAt = yield* nowIso;
    for (const run of readModel.devReviewWorkflowRuns ?? []) {
      if (run.status !== "running") continue;
      yield* reconcileRun(run, occurredAt).pipe(
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.failCause(cause)
            : blockRun({
                run,
                reason: "automation-unavailable",
                detailMarkdown: `Dev Review automation was unavailable during restart recovery.\n\n${Cause.pretty(cause)}`,
                occurredAt,
              }).pipe(Effect.catch(() => Effect.void)),
        ),
      );
    }
  });

  const reconcile: DevReviewWorkflowReactorShape["reconcile"] = () =>
    reconcileRuns().pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Dev Review workflow reconciliation failed", {
          cause: Cause.pretty(cause),
        }),
      ),
    );

  const start: DevReviewWorkflowReactorShape["start"] = Effect.fn("start")(function* () {
    yield* reconcile();
    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        if (
          event.type !== "thread.dev-review-workflow-launched" &&
          event.type !== "thread.dev-review-workflow-resume-requested" &&
          event.type !== "thread.dev-review-workflow-cancel-requested" &&
          event.type !== "thread.dev-review-updated" &&
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

  return { start, drain: worker.drain, reconcile } satisfies DevReviewWorkflowReactorShape;
});

export const DevReviewWorkflowReactorLive = Layer.effect(DevReviewWorkflowReactor, make);
