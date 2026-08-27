import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AppDevStackError,
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  AppReviewId,
  type AppReviewWorkflowCycle,
  type AppReviewWorkflowFailure,
  type AppReviewWorkflowRun,
  EventId,
  GitCommandError,
  IMPLEMENTATION_RUN_MAX_QA_REPAIRS,
  IMPLEMENTATION_RUN_MAX_REVIEW_GATE_CYCLES,
  IMPLEMENTATION_STAGE_MAX_LAUNCHES,
  MessageId,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  TurnId,
  type ModelSelection,
  OrchestrationImplementationRun,
  type OrchestrationImplementationSkipTarget,
  type OrchestrationImplementationTicketState,
  type OrchestrationImplementationValidationResult,
  type OrchestrationReadModel,
  type ServerSettings,
  type T3ProjectFile,
  type VcsCreateWorktreeInput,
  type VcsRemoveWorktreeInput,
} from "@t3tools/contracts";
import { type DeepPartial } from "@t3tools/shared/Struct";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";

import { AppDevStackManager } from "../../appDevStack/AppDevStackManager.ts";
import { ServerConfig } from "../../config.ts";
import { GitWorkflowService, type GitMergeRefInput } from "../../git/GitWorkflowService.ts";
import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
import { WORKFLOW_PROMPT_IDS } from "../../provider/WorkflowPromptRegistry.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { T3ProjectFileLoader } from "../../project/T3ProjectFileLoader.ts";
import {
  appDevStackBackendHealthUrl,
  automationHaltMatchesTicketRerun,
  fastFeatureBuildContractProblems,
  implementationTicketReviewWarningLines,
  implementationTicketStateIsTerminal,
  implementationRunRerunIsPaused,
  isImplementationWorkflowActivityKind,
  isLegacyDirtyWorkerLaunchHalt,
  isRecoverableInterruptedWorktreeHalt,
  failImplementationTickets,
  findAwaitingNestedAppReview,
  ImplementationWorkflowReactorLive,
  nestedAppReviewAwaitsPreviewRefresh,
  ticketAppReviewClaimIsAhead,
  workflowIdForRun,
} from "./ImplementationWorkflowReactor.ts";
import {
  WORKFLOW_INTERRUPTION_ERROR_MESSAGE,
  WORKFLOW_NUDGE_EXHAUSTED_MESSAGE,
} from "../workflowNudge.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import * as ThreadBackgroundLiveness from "../ThreadBackgroundLiveness.ts";
import * as ThreadPlanProgress from "../ThreadPlanProgress.ts";
import {
  ImplementationWorkflowReactor,
  type ImplementationWorkflowReactorShape,
} from "../Services/ImplementationWorkflowReactor.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../Services/ProjectionSnapshotQuery.ts";

const now = "2026-01-01T00:00:00.000Z";
const decodeImplementationRun = Schema.decodeUnknownEffect(OrchestrationImplementationRun);

it("queues only implementation directive activities", () => {
  expect(isImplementationWorkflowActivityKind("implementation-worker-result")).toBe(true);
  expect(isImplementationWorkflowActivityKind("implementation-merge-gate-result")).toBe(true);
  expect(isImplementationWorkflowActivityKind("implementation-fix-result")).toBe(true);
  expect(isImplementationWorkflowActivityKind("implementation-code-review-result")).toBe(true);
  expect(isImplementationWorkflowActivityKind("implementation-fast-build-result")).toBe(true);
  expect(isImplementationWorkflowActivityKind("implementation-change-request-babysit-result")).toBe(
    true,
  );
  expect(isImplementationWorkflowActivityKind("tool.updated")).toBe(false);
  expect(isImplementationWorkflowActivityKind("context-window.updated")).toBe(false);
});

it("treats reviewed successes and best-effort failures as terminal tickets", () => {
  expect(implementationTicketStateIsTerminal("succeeded")).toBe(true);
  expect(implementationTicketStateIsTerminal("failed")).toBe(true);
  expect(implementationTicketStateIsTerminal("app-reviewing")).toBe(false);
  expect(implementationTicketStateIsTerminal("code-reviewing")).toBe(false);
});

it("detects a paused ancestor before handling an implementation re-run", () => {
  const rootId = ThreadId.make("thread-paused-root");
  const orchestratorThreadId = ThreadId.make("thread-paused-orchestrator");
  const threads = [
    { id: rootId, parentThreadId: null, workflowPausedAt: now },
    { id: orchestratorThreadId, parentThreadId: rootId, workflowPausedAt: null },
  ] as unknown as OrchestrationReadModel["threads"];

  expect(
    implementationRunRerunIsPaused({
      threads,
      sourceThreadId: rootId,
      orchestratorThreadId,
    }),
  ).toBe(true);
});

it("matches legacy ticket final Code Review halts to the Code Review stage", () => {
  const halt = {
    ticketId: "ticket-1",
    stage: "final-code-review",
    category: "structural-invariant",
    detail: "Ticket Code Review worktree is dirty.",
    haltedAt: now,
  } as const;

  expect(
    automationHaltMatchesTicketRerun({
      halt,
      ticketId: "ticket-1",
      stage: "code-review",
    }),
  ).toBe(true);
  expect(
    automationHaltMatchesTicketRerun({
      halt,
      ticketId: "ticket-2",
      stage: "code-review",
    }),
  ).toBe(false);
});

it("identifies only the obsolete dirty worker launch halt", () => {
  const dirtyWorkerHalt = {
    ticketId: "ticket-1",
    stage: "implementation",
    category: "structural-invariant",
    detail:
      "Git command failed: Existing worker worktree on 'checkout-ticket-1' is dirty before implementation launch.",
    haltedAt: now,
  } as const;

  expect(isLegacyDirtyWorkerLaunchHalt(dirtyWorkerHalt)).toBe(true);
  expect(
    isLegacyDirtyWorkerLaunchHalt({
      ...dirtyWorkerHalt,
      detail: "Existing worker worktree is on the wrong branch.",
    }),
  ).toBe(false);
  expect(
    isLegacyDirtyWorkerLaunchHalt({
      ...dirtyWorkerHalt,
      stage: "integration",
    }),
  ).toBe(false);
});

it("keeps dirty App Review and wrong-branch halts stopped", () => {
  const appReviewHalt = {
    ticketId: "ticket-1",
    stage: "app-review",
    category: "structural-invariant",
    detail:
      "Embedded App Review requires clean expected branch 'ticket-1', but Git reports 'ticket-1' with uncommitted changes.",
    haltedAt: now,
  } as const;

  expect(isRecoverableInterruptedWorktreeHalt(appReviewHalt)).toBe(false);
  expect(
    isRecoverableInterruptedWorktreeHalt({
      ...appReviewHalt,
      category: "review-blocked",
      detail: WORKFLOW_INTERRUPTION_ERROR_MESSAGE,
    }),
  ).toBe(true);
  expect(
    isRecoverableInterruptedWorktreeHalt({
      ...appReviewHalt,
      detail: "Existing worker worktree is not on expected branch 'ticket-1'.",
    }),
  ).toBe(false);
});

it("knows when an embedded App Review is parked awaiting a preview refresh", () => {
  const parked = {
    caller: { type: "implementation", implementationRunId: "run-1", ticketId: "ticket-1" },
    status: "running",
    activePhase: null,
    cycles: [{ cycleNumber: 1, status: "completed", fixResult: { status: "succeeded" } }],
  } as unknown as Parameters<typeof nestedAppReviewAwaitsPreviewRefresh>[0];
  expect(nestedAppReviewAwaitsPreviewRefresh(parked)).toBe(true);
  expect(
    nestedAppReviewAwaitsPreviewRefresh({
      ...parked,
      caller: { type: "standalone", sourceThreadId: "thread-1" },
    } as unknown as Parameters<typeof nestedAppReviewAwaitsPreviewRefresh>[0]),
  ).toBe(false);
  expect(nestedAppReviewAwaitsPreviewRefresh({ ...parked, activePhase: "review" })).toBe(false);
  expect(nestedAppReviewAwaitsPreviewRefresh({ ...parked, status: "passed" })).toBe(false);
  expect(
    nestedAppReviewAwaitsPreviewRefresh({
      ...parked,
      cycles: [{ cycleNumber: 1, status: "failed", fixResult: null }],
    } as unknown as Parameters<typeof nestedAppReviewAwaitsPreviewRefresh>[0]),
  ).toBe(false);
  expect(
    nestedAppReviewAwaitsPreviewRefresh({
      ...parked,
      cycles: [],
    } as unknown as Parameters<typeof nestedAppReviewAwaitsPreviewRefresh>[0]),
  ).toBe(false);
});

it("does not resolve a stale embedded App Review update as awaiting a preview refresh", () => {
  const parked = {
    id: "app-review-workflow-1",
    caller: { type: "implementation", implementationRunId: "run-1", ticketId: "ticket-1" },
    status: "running",
    activePhase: null,
    cycles: [{ cycleNumber: 1, status: "completed", fixResult: { status: "succeeded" } }],
  } as unknown as AppReviewWorkflowRun;

  expect(findAwaitingNestedAppReview([parked], parked.id)).toBe(parked);
  expect(
    findAwaitingNestedAppReview(
      [{ ...parked, status: "exhausted", outcome: "exhausted" }],
      parked.id,
    ),
  ).toBeNull();
});

it("recognizes a ticket App Review claim hidden by projection lag", () => {
  const observed = {
    ticketStates: [
      {
        ticketId: "ticket-1",
        appReviewGeneration: 2,
        appReviewLaunchCount: 0,
        appReviewWorkflowRunId: null,
      },
    ],
  } as unknown as OrchestrationImplementationRun;
  const local = {
    ticketStates: [
      {
        ticketId: "ticket-1",
        appReviewGeneration: 2,
        appReviewLaunchCount: 1,
        appReviewWorkflowRunId: "app-review-workflow-1",
      },
    ],
  } as unknown as OrchestrationImplementationRun;

  expect(ticketAppReviewClaimIsAhead({ local, observed, ticketId: "ticket-1" })).toBe(true);
  expect(
    ticketAppReviewClaimIsAhead({
      local,
      observed: {
        ...observed,
        ticketStates: [
          {
            ...observed.ticketStates[0]!,
            appReviewGeneration: 3,
          },
        ],
      },
      ticketId: "ticket-1",
    }),
  ).toBe(false);
});

it("formats ticket review problems for pull request publication", () => {
  const lines = implementationTicketReviewWarningLines({
    ticketStates: [
      { ticketId: "ticket-pass", status: "succeeded", warningMarkdown: null },
      { ticketId: "ticket-review", status: "succeeded", warningMarkdown: "App Review exhausted." },
      { ticketId: "ticket-failed", status: "failed", warningMarkdown: null },
    ],
  } as unknown as Pick<OrchestrationImplementationRun, "ticketStates">);
  expect(lines).toEqual([
    "- ⚠️ ticket-review: App Review exhausted.",
    "- ⚠️ ticket-failed: implementation did not complete",
  ]);
});

it("turns ticket setup failures and their dependents into terminal warnings", () => {
  const run = {
    ticketStates: [
      { ticketId: "ticket-a", dependencyTicketIds: [], status: "ready", warningMarkdown: null },
      {
        ticketId: "ticket-b",
        dependencyTicketIds: ["ticket-a"],
        status: "blocked",
        warningMarkdown: null,
      },
      { ticketId: "ticket-c", dependencyTicketIds: [], status: "running", warningMarkdown: null },
    ],
    retryableFailure: { stage: "worker-setup" },
  } as unknown as OrchestrationImplementationRun;

  const continued = failImplementationTickets(
    run,
    new Map([["ticket-a", "Ticket worker setup failed: worktree unavailable"]]),
    now,
  );

  expect(continued.ticketStates).toEqual([
    expect.objectContaining({
      ticketId: "ticket-a",
      status: "failed",
      warningMarkdown: "Ticket worker setup failed: worktree unavailable",
    }),
    expect.objectContaining({
      ticketId: "ticket-b",
      status: "failed",
      warningMarkdown: "Blocked by failed dependency: 'ticket-a'.",
    }),
    expect.objectContaining({ ticketId: "ticket-c", status: "running" }),
  ]);
  expect(continued.retryableFailure).toBeNull();
});
const projectId = ProjectId.make("project-implementation-reactor");
const sourceThreadId = ThreadId.make("thread-implementation-source");
const decodeBuildContractExample = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({
      validations: Schema.Array(Schema.Struct({ command: Schema.String })),
    }),
  ),
);

interface ImplementationCalls {
  readonly autoCreateInputs: Ref.Ref<
    ReadonlyArray<{
      readonly worktreePath: string;
      readonly displayName: string;
      readonly workflowId?: string | null | undefined;
    }>
  >;
  readonly workflowTeardownInputs: Ref.Ref<ReadonlyArray<{ readonly workflowId: string }>>;
  readonly stopStackIds: Ref.Ref<ReadonlyArray<string>>;
  readonly deleteStackIds: Ref.Ref<ReadonlyArray<string>>;
  readonly deletedStackIds: Ref.Ref<ReadonlySet<string>>;
  readonly protectionInputs: Ref.Ref<
    ReadonlyArray<{ readonly stackId: string; readonly protected: boolean }>
  >;
  readonly createOrOpenChangeRequestCount: Ref.Ref<number>;
  readonly createOrOpenChangeRequestInputs: Ref.Ref<
    ReadonlyArray<{
      readonly cwd: string;
      readonly baseRefName: string;
      readonly headRefName: string;
      readonly expectedHeadSha: string;
      readonly commitMessage?: string;
      readonly pullRequestBodyNote?: string;
    }>
  >;
  readonly createWorktreeInputs: Ref.Ref<ReadonlyArray<VcsCreateWorktreeInput>>;
  readonly removeWorktreeInputs: Ref.Ref<ReadonlyArray<VcsRemoveWorktreeInput>>;
  readonly activeWorktreePaths: Ref.Ref<ReadonlySet<string>>;
  readonly removeWorktreeFailuresRemaining: Ref.Ref<number>;
  readonly mergeRefInputs: Ref.Ref<ReadonlyArray<GitMergeRefInput>>;
  readonly localStatusCount: Ref.Ref<number>;
  readonly dirtyWorkerWorktrees: Ref.Ref<boolean>;
  readonly advancedBranchRefs: Ref.Ref<ReadonlySet<string>>;
  readonly frontendProbeUrls: Ref.Ref<ReadonlyArray<string>>;
}

/**
 * Holds `autoCreate` open until the requested number of calls have entered, then parks every call
 * on `release`.
 */
interface AutoCreateGate {
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
  readonly entryCount: Ref.Ref<number>;
  readonly requiredEntries: number;
}

interface ChangeRequestGate {
  readonly entered: Deferred.Deferred<void>;
  readonly release: Deferred.Deferred<void>;
}

interface ImplementationSystem extends ImplementationCalls {
  readonly engine: OrchestrationEngineShape;
  readonly query: ProjectionSnapshotQueryShape;
  readonly reactor: ImplementationWorkflowReactorShape;
}

function commandId(value: string) {
  return CommandId.make(`cmd-${value}`);
}

function messageId(value: string) {
  return MessageId.make(`message-${value}`);
}

function eventId(value: string) {
  return EventId.make(`event-${value}`);
}

function requiredValidations(completedAt = "2026-01-01T00:00:02.000Z") {
  return ["vp test run src/feature.test.ts"].map((command) => ({
    command,
    status: "passed" as const,
    outputMarkdown: "ok",
    completedAt,
  }));
}

function completeValidations(completedAt = "2026-01-01T00:00:06.000Z") {
  return ["vp check", "vp run typecheck"].map((command) => ({
    command,
    status: "passed" as const,
    outputMarkdown: "ok",
    completedAt,
  }));
}

function planningTicket(key: string, dependencyKeys: ReadonlyArray<string> = []) {
  return {
    key,
    title: key,
    bodyMarkdown: `Implement ${key}.`,
    plannedFileChanges: [{ path: `src/${key.toLowerCase()}.ts`, action: "update" as const }],
    dependencyKeys,
  };
}

function makeTestLayer(
  calls: ImplementationCalls,
  serverSettings: DeepPartial<ServerSettings> = {},
  failCreateWorktreeAfter?: number,
  failAutoCreate = false,
  failAutoCreateAttempts = 0,
  autoCreateFailureMessage = "compose file missing",
  conflictMergeRefName?: string,
  failMergeRefName?: string,
  resolvedCommitSha = "def456",
  dirtySourceStatusChecks = 0,
  autoCreateFrontendUrls?: ReadonlyArray<string | null>,
  sourceRefName = "main",
  autoCreateGate?: AutoCreateGate,
  autoCreateStackStatus: "running" | "starting" | "error" = "running",
  frontendProbeStatus = 200,
  backendProbeStatus = frontendProbeStatus,
  backendProbeStatuses: ReadonlyArray<number> = [backendProbeStatus],
  inheritedStackMissing = false,
  nonAncestorCommitSha?: string,
  changeRequestGate?: ChangeRequestGate,
  projectFile?: T3ProjectFile,
) {
  const coreLayer = Layer.mergeAll(
    OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationProjectionPipelineLive),
    ),
    OrchestrationProjectionSnapshotQueryLive,
  ).pipe(
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    Layer.provide(RepositoryIdentityResolver.layer),
    Layer.provide(SqlitePersistenceMemory),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "implementation-reactor-" }),
    ),
    Layer.provideMerge(NodeServices.layer),
    Layer.provideMerge(ThreadBackgroundLiveness.layer),
    Layer.provideMerge(ThreadPlanProgress.layer),
  );

  return Layer.mergeAll(
    coreLayer,
    ImplementationWorkflowReactorLive.pipe(
      Layer.provide(coreLayer),
      Layer.provide(serverSettingsLayerTest(serverSettings)),
      Layer.provide(
        Layer.succeed(
          T3ProjectFileLoader,
          T3ProjectFileLoader.of({
            load: () =>
              Effect.succeed(projectFile === undefined ? Option.none() : Option.some(projectFile)),
          }),
        ),
      ),
      // The reactor probes the frontend URL before App Review; answer it without real network I/O.
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Ref.modify(calls.frontendProbeUrls, (urls) => {
              const backendProbeIndex = urls.filter((url) => url.endsWith("/api/health")).length;
              const backendStatus =
                backendProbeStatuses[
                  Math.min(backendProbeIndex, backendProbeStatuses.length - 1)
                ] ?? backendProbeStatus;
              return [
                HttpClientResponse.fromWeb(
                  request,
                  new Response("ok", {
                    status: request.url.endsWith("/api/health")
                      ? backendStatus
                      : frontendProbeStatus,
                  }),
                ),
                [...urls, request.url],
              ] as const;
            }),
          ),
        ),
      ),
      Layer.provide(
        Layer.mock(GitWorkflowService)({
          createWorktree: (input) =>
            Ref.updateAndGet(calls.createWorktreeInputs, (inputs) => [...inputs, input]).pipe(
              Effect.flatMap((inputs) =>
                failCreateWorktreeAfter !== undefined && inputs.length > failCreateWorktreeAfter
                  ? Effect.fail(
                      new GitCommandError({
                        operation: "GitVcsDriver.createWorktree",
                        command: "git",
                        cwd: input.cwd,
                        detail: "git worktree add failed",
                      }),
                    )
                  : Effect.succeed({
                      worktree: {
                        path: input.path ?? "/tmp/generated-worktree",
                        refName: input.newRefName ?? "HEAD",
                      },
                    }),
              ),
              Effect.tap((result) =>
                Ref.update(calls.activeWorktreePaths, (paths) =>
                  new Set(paths).add(result.worktree.path),
                ),
              ),
            ),
          removeWorktree: (input) =>
            Ref.update(calls.removeWorktreeInputs, (inputs) => [...inputs, input]).pipe(
              Effect.andThen(
                Ref.modify(
                  calls.removeWorktreeFailuresRemaining,
                  (remaining) => [remaining > 0, Math.max(0, remaining - 1)] as const,
                ),
              ),
              Effect.flatMap((shouldFail) =>
                shouldFail
                  ? Effect.fail(
                      new GitCommandError({
                        operation: "GitWorkflowService.removeWorktree",
                        command: "git worktree remove",
                        cwd: input.cwd,
                        detail: "git worktree remove failed",
                      }),
                    )
                  : Ref.update(calls.activeWorktreePaths, (paths) => {
                      const active = new Set(paths);
                      active.delete(input.path);
                      return active;
                    }),
              ),
            ),
          resolveCommit: (input) =>
            Effect.gen(function* () {
              const advancedBranchRefs = yield* Ref.get(calls.advancedBranchRefs);
              if (
                input.ref === "HEAD" &&
                (input.cwd.includes(".worktrees/") || input.cwd.includes("-ticket-"))
              ) {
                const activeWorktreePaths = yield* Ref.get(calls.activeWorktreePaths);
                if (!activeWorktreePaths.has(input.cwd)) {
                  return yield* new GitCommandError({
                    operation: "GitWorkflowService.resolveCommit",
                    command: "git rev-parse",
                    cwd: input.cwd,
                    detail: "worktree does not exist",
                  });
                }
              }
              if (input.ref.endsWith("@commit")) {
                return { commitSha: input.ref };
              }
              if (input.ref.includes("-ticket-")) {
                return {
                  commitSha:
                    resolvedCommitSha === "def456"
                      ? `${input.ref}@${advancedBranchRefs.has(input.ref) ? "advanced" : "commit"}`
                      : resolvedCommitSha,
                };
              }
              if (input.ref === "HEAD" && input.cwd.includes("-ticket-")) {
                const created = yield* Ref.get(calls.createWorktreeInputs);
                const branch = created.find(
                  (candidate) => candidate.path === input.cwd,
                )?.newRefName;
                return {
                  commitSha:
                    resolvedCommitSha === "def456" && branch
                      ? `${branch}@${advancedBranchRefs.has(branch) ? "advanced" : "commit"}`
                      : resolvedCommitSha,
                };
              }
              return { commitSha: resolvedCommitSha };
            }),
          localStatus: (input) =>
            Effect.all([
              Ref.get(calls.createWorktreeInputs),
              Ref.updateAndGet(calls.localStatusCount, (count) => count + 1),
              Ref.get(calls.dirtyWorkerWorktrees),
            ]).pipe(
              Effect.map(([created, statusCheck, dirtyWorkerWorktrees]) => ({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: input.cwd === "/tmp/implementation-reactor",
                refName:
                  created.find((candidate) => candidate.path === input.cwd)?.newRefName ??
                  (input.cwd === "/tmp/implementation-reactor" ? sourceRefName : "main"),
                hasWorkingTreeChanges:
                  (input.cwd === "/tmp/implementation-reactor" &&
                    statusCheck <= dirtySourceStatusChecks) ||
                  (dirtyWorkerWorktrees && input.cwd.includes("-ticket-")),
                workingTree: { files: [], insertions: 0, deletions: 0 },
              })),
            ),
          listChangedFiles: () => Effect.succeed([]),
          isAncestor: (input) => Effect.succeed(input.ancestorRef !== nonAncestorCommitSha),
          mergeRef: (input) =>
            Ref.update(calls.mergeRefInputs, (inputs) => [...inputs, input]).pipe(
              Effect.flatMap(() =>
                input.refName ===
                (failMergeRefName?.includes("-ticket-")
                  ? `${failMergeRefName}@commit`
                  : failMergeRefName)
                  ? Effect.fail(
                      new GitCommandError({
                        operation: "GitWorkflowService.mergeRef",
                        command: "git merge",
                        cwd: input.cwd,
                        detail: "programmatic merge failed",
                      }),
                    )
                  : Effect.succeed(
                      input.refName ===
                        (conflictMergeRefName?.includes("-ticket-")
                          ? `${conflictMergeRefName}@commit`
                          : conflictMergeRefName)
                        ? {
                            status: "conflicted" as const,
                            conflictedFiles: ["conflicted.ts"],
                          }
                        : { status: "merged" as const },
                    ),
              ),
            ),
          createOrOpenChangeRequest: (input) =>
            Ref.update(calls.createOrOpenChangeRequestInputs, (inputs) => [...inputs, input]).pipe(
              Effect.andThen(
                Ref.update(calls.createOrOpenChangeRequestCount, (count) => count + 1),
              ),
              Effect.tap(() =>
                changeRequestGate === undefined
                  ? Effect.void
                  : Deferred.succeed(changeRequestGate.entered, undefined).pipe(
                      Effect.andThen(Deferred.await(changeRequestGate.release)),
                    ),
              ),
              Effect.as({
                provider: "github" as const,
                number: 1,
                title: "Implementation PR",
                url: "https://example.test/pr/1",
                baseRefName: "main",
                headRefName: "implementation/checkout",
                state: "open" as const,
                updatedAt: Option.none(),
              }),
            ),
        }),
      ),
      Layer.provide(
        Layer.mock(AppDevStackManager)({
          getByWorktree: (input) =>
            Effect.gen(function* () {
              const stackId = input.worktreePath.includes("-ticket-") ? "stack-ticket" : "stack-1";
              const deletedStackIds = yield* Ref.get(calls.deletedStackIds);
              const autoCreateInputs = yield* Ref.get(calls.autoCreateInputs);
              const workflowId = autoCreateInputs.findLast(
                (candidate) => candidate.worktreePath === input.worktreePath,
              )?.workflowId;
              const missing = inheritedStackMissing || deletedStackIds.has(stackId);
              return {
                stack: missing
                  ? null
                  : {
                      id: stackId,
                      uuid: input.worktreePath.includes("-ticket-")
                        ? "stack-ticket-uuid"
                        : "stack-uuid-1",
                      userId: "user-1",
                      worktreePath: input.worktreePath,
                      ...(workflowId == null ? {} : { workflowId }),
                      composePath: "/tmp/compose.yml",
                      displayName: "Implementation test",
                      description: null,
                      status: autoCreateStackStatus,
                      services: null,
                      serviceCount: 0,
                      lastError: null,
                      errorCount: 0,
                      createdAt: now,
                      updatedAt: now,
                    },
                frontendUrl: missing ? null : "http://127.0.0.1:5173",
                frontendServiceName: missing ? null : "frontend",
              };
            }),
          get: (input) =>
            Effect.succeed({
              id: input.stackId,
              uuid: "stack-uuid-1",
              userId: "user-1",
              worktreePath: "/tmp/implementation-reactor.worktrees/checkout",
              composePath: "/tmp/compose.yml",
              displayName: "Implementation test",
              description: null,
              status: autoCreateStackStatus,
              services: null,
              serviceCount: 0,
              lastError: null,
              errorCount: 0,
              createdAt: now,
              updatedAt: now,
            }),
          getStackPodLogs: (input) =>
            Effect.succeed({
              stackId: input.stackId,
              namespace: "test",
              tailLines: input.tailLines ?? 300,
              pods: [],
              entries: [],
              fetchedAt: now,
            }),
          workflowTeardown: (input) =>
            Ref.update(calls.workflowTeardownInputs, (inputs) => [...inputs, input]).pipe(
              Effect.as({
                stoppedStackIds: ["stack-ticket-finished"],
                skippedProtectedStackIds: ["stack-1", "stack-protected"],
                failedStackIds: [],
              }),
            ),
          stop: (input) =>
            Ref.update(calls.stopStackIds, (stackIds) => [...stackIds, input.stackId]).pipe(
              Effect.as({
                id: input.stackId,
                uuid: `${input.stackId}-uuid`,
                userId: "user-1",
                worktreePath: "/tmp/implementation-reactor-ticket-1",
                composePath: "/tmp/compose.yml",
                displayName: "Implementation ticket",
                description: null,
                status: "stopped" as const,
                services: null,
                serviceCount: 0,
                lastError: null,
                errorCount: 0,
                createdAt: now,
                updatedAt: now,
              }),
            ),
          delete: (input) =>
            Ref.update(calls.deleteStackIds, (stackIds) => [...stackIds, input.stackId]).pipe(
              Effect.andThen(
                Ref.update(calls.deletedStackIds, (stackIds) =>
                  new Set(stackIds).add(input.stackId),
                ),
              ),
              Effect.as({ deleted: true as const }),
            ),
          setProtected: (input) =>
            Ref.update(calls.protectionInputs, (inputs) => [...inputs, input]).pipe(
              Effect.as({
                id: input.stackId,
                uuid: `${input.stackId}-uuid`,
                userId: "user-1",
                worktreePath: "/tmp/implementation-reactor",
                composePath: "/tmp/compose.yml",
                displayName: "Implementation test",
                description: null,
                status: "running" as const,
                services: null,
                serviceCount: 0,
                lastError: null,
                errorCount: 0,
                createdAt: now,
                updatedAt: now,
                protected: input.protected,
              }),
            ),
          autoCreate: (input) =>
            Ref.updateAndGet(calls.autoCreateInputs, (inputs) => [...inputs, input]).pipe(
              Effect.tap(() =>
                autoCreateGate === undefined
                  ? Effect.void
                  : Ref.updateAndGet(autoCreateGate.entryCount, (count) => count + 1).pipe(
                      Effect.flatMap((count) =>
                        count >= autoCreateGate.requiredEntries
                          ? Deferred.succeed(autoCreateGate.entered, undefined)
                          : Effect.void,
                      ),
                      Effect.andThen(Deferred.await(autoCreateGate.release)),
                    ),
              ),
              Effect.flatMap((inputs) => {
                const configuredFrontendUrl = autoCreateFrontendUrls?.[inputs.length - 1];
                const frontendUrl =
                  configuredFrontendUrl === undefined
                    ? "http://127.0.0.1:5173"
                    : configuredFrontendUrl;
                return failAutoCreate || inputs.length <= failAutoCreateAttempts
                  ? Effect.fail(
                      new AppDevStackError({
                        operation: "autoCreate",
                        reason: "request_failed",
                        message: autoCreateFailureMessage,
                      }),
                    )
                  : Effect.succeed({
                      created: true,
                      frontendUrl,
                      frontendServiceName: frontendUrl === null ? null : "frontend",
                      stack: {
                        id: "stack-1",
                        uuid: "stack-uuid-1",
                        userId: "user-1",
                        worktreePath: input.worktreePath,
                        composePath: "/tmp/compose.yml",
                        displayName: input.displayName,
                        description: null,
                        status: autoCreateStackStatus,
                        services: null,
                        serviceCount: 0,
                        lastError: null,
                        errorCount: 0,
                        createdAt: now,
                        updatedAt: now,
                      },
                    });
              }),
            ),
        }),
      ),
    ),
  );
}

function withSystem<A, E>(
  use: (system: ImplementationSystem) => Effect.Effect<A, E, Scope.Scope>,
  options?: {
    readonly serverSettings?: DeepPartial<ServerSettings>;
    readonly failCreateWorktreeAfter?: number;
    readonly failAutoCreate?: boolean;
    readonly failAutoCreateAttempts?: number;
    readonly autoCreateFailureMessage?: string;
    readonly conflictMergeRefName?: string;
    readonly failMergeRefName?: string;
    readonly resolvedCommitSha?: string;
    readonly dirtySourceStatusChecks?: number;
    readonly autoCreateFrontendUrls?: ReadonlyArray<string | null>;
    readonly sourceRefName?: string;
    readonly autoCreateGate?: AutoCreateGate;
    /** Leave the reactor stopped so a test can dispatch events it must recover from on start. */
    readonly startReactor?: boolean;
    /** Stack status the controller reports from `autoCreate`; only "running" is actually serving. */
    readonly autoCreateStackStatus?: "running" | "starting" | "error";
    /** HTTP status the frontend URL answers with when the reactor probes it before App Review. */
    readonly frontendProbeStatus?: number;
    /** HTTP status the same-origin backend health route answers with. */
    readonly backendProbeStatus?: number;
    /** Successive backend health statuses, held at the final value after exhaustion. */
    readonly backendProbeStatuses?: ReadonlyArray<number>;
    readonly inheritedStackMissing?: boolean;
    /** Commit `git merge-base --is-ancestor` reports as missing from every descendant. */
    readonly nonAncestorCommitSha?: string;
    readonly changeRequestGate?: ChangeRequestGate;
    readonly dirtyWorkerWorktrees?: boolean;
    readonly failRemoveWorktreeAttempts?: number;
    readonly projectFile?: T3ProjectFile;
  },
) {
  return Effect.gen(function* () {
    const autoCreateInputs = yield* Ref.make<
      ReadonlyArray<{
        readonly worktreePath: string;
        readonly displayName: string;
        readonly workflowId?: string | null | undefined;
      }>
    >([]);
    const workflowTeardownInputs = yield* Ref.make<ReadonlyArray<{ readonly workflowId: string }>>(
      [],
    );
    const stopStackIds = yield* Ref.make<ReadonlyArray<string>>([]);
    const deleteStackIds = yield* Ref.make<ReadonlyArray<string>>([]);
    const deletedStackIds = yield* Ref.make<ReadonlySet<string>>(new Set());
    const protectionInputs = yield* Ref.make<
      ReadonlyArray<{ readonly stackId: string; readonly protected: boolean }>
    >([]);
    const createOrOpenChangeRequestCount = yield* Ref.make(0);
    const createOrOpenChangeRequestInputs = yield* Ref.make<
      ReadonlyArray<{
        readonly cwd: string;
        readonly baseRefName: string;
        readonly headRefName: string;
        readonly expectedHeadSha: string;
        readonly commitMessage?: string;
        readonly pullRequestBodyNote?: string;
      }>
    >([]);
    const createWorktreeInputs = yield* Ref.make<ReadonlyArray<VcsCreateWorktreeInput>>([]);
    const removeWorktreeInputs = yield* Ref.make<ReadonlyArray<VcsRemoveWorktreeInput>>([]);
    const activeWorktreePaths = yield* Ref.make<ReadonlySet<string>>(new Set());
    const removeWorktreeFailuresRemaining = yield* Ref.make(
      options?.failRemoveWorktreeAttempts ?? 0,
    );
    const mergeRefInputs = yield* Ref.make<ReadonlyArray<GitMergeRefInput>>([]);
    const localStatusCount = yield* Ref.make(0);
    const dirtyWorkerWorktrees = yield* Ref.make(options?.dirtyWorkerWorktrees ?? false);
    const advancedBranchRefs = yield* Ref.make<ReadonlySet<string>>(new Set());
    const frontendProbeUrls = yield* Ref.make<ReadonlyArray<string>>([]);
    const calls = {
      autoCreateInputs,
      workflowTeardownInputs,
      stopStackIds,
      deleteStackIds,
      deletedStackIds,
      protectionInputs,
      createOrOpenChangeRequestCount,
      createOrOpenChangeRequestInputs,
      createWorktreeInputs,
      removeWorktreeInputs,
      activeWorktreePaths,
      removeWorktreeFailuresRemaining,
      mergeRefInputs,
      localStatusCount,
      dirtyWorkerWorktrees,
      advancedBranchRefs,
      frontendProbeUrls,
    } satisfies ImplementationCalls;

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const query = yield* ProjectionSnapshotQuery;
        const reactor = yield* ImplementationWorkflowReactor;
        if (options?.startReactor !== false) yield* reactor.start();
        return yield* use({
          ...calls,
          engine,
          query,
          reactor,
        });
      }),
    ).pipe(
      Effect.provide(
        makeTestLayer(
          calls,
          options?.serverSettings,
          options?.failCreateWorktreeAfter,
          options?.failAutoCreate,
          options?.failAutoCreateAttempts,
          options?.autoCreateFailureMessage,
          options?.conflictMergeRefName,
          options?.failMergeRefName,
          options?.resolvedCommitSha,
          options?.dirtySourceStatusChecks,
          options?.autoCreateFrontendUrls,
          options?.sourceRefName,
          options?.autoCreateGate,
          options?.autoCreateStackStatus,
          options?.frontendProbeStatus,
          options?.backendProbeStatus,
          options?.backendProbeStatuses,
          options?.inheritedStackMissing,
          options?.nonAncestorCommitSha,
          options?.changeRequestGate,
          options?.projectFile,
        ),
      ),
    );
  });
}

function seedPlanning(
  system: ImplementationSystem,
  options?: {
    readonly modelSelection?: ModelSelection;
    readonly sourceBranch?: string;
    readonly tickets?: ReadonlyArray<{
      readonly key: string;
      readonly title: string;
      readonly bodyMarkdown: string;
      readonly plannedFileChanges: ReadonlyArray<{
        readonly path: string;
        readonly action: "create" | "update" | "delete";
      }>;
      readonly dependencyKeys: ReadonlyArray<string>;
      readonly appReviewEligible?: boolean;
      readonly appReviewPlanMarkdown?: string;
    }>;
  },
) {
  return Effect.gen(function* () {
    yield* system.engine.dispatch({
      type: "project.create",
      commandId: commandId("project-create"),
      projectId,
      title: "Implementation Reactor",
      workspaceRoot: "/tmp/implementation-reactor",
      createdAt: now,
    });
    yield* system.engine.dispatch({
      type: "thread.create",
      commandId: commandId("thread-create"),
      threadId: sourceThreadId,
      projectId,
      ownerUserId: DEFAULT_WORKSPACE_USER_ID,
      parentThreadId: null,
      workflowRole: null,
      title: "Planning",
      modelSelection: options?.modelSelection ?? {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5-codex",
      },
      runtimeMode: "full-access",
      interactionMode: "planning-workflow",
      branch: options?.sourceBranch ?? "main",
      worktreePath: "/tmp/implementation-reactor",
      createdAt: now,
    });
    yield* system.engine.dispatch({
      type: "thread.planning-spec.apply",
      commandId: commandId("spec-apply"),
      threadId: sourceThreadId,
      sourceMessageId: messageId("spec-source"),
      title: "Checkout",
      summaryMarkdown: "Build checkout.",
      createdAt: now,
    });
    const snapshotAfterSpec = yield* system.query.getSnapshot();
    const spec = snapshotAfterSpec.threads.find((thread) => thread.id === sourceThreadId)
      ?.planningWorkflow?.spec;
    if (!spec) throw new Error("Spec missing.");
    yield* system.engine.dispatch({
      type: "thread.planning-tickets.apply",
      commandId: commandId("tickets-apply"),
      threadId: sourceThreadId,
      sourceMessageId: messageId("tickets-source"),
      specId: spec.id,
      tickets: options?.tickets ?? [planningTicket("TICKET-1")],
      createdAt: now,
    });
    const snapshot = yield* system.query.getSnapshot();
    const tickets =
      snapshot.threads.find((thread) => thread.id === sourceThreadId)?.planningWorkflow?.tickets ??
      [];
    const ticket = tickets[0];
    if (!ticket) throw new Error("Ticket missing.");
    return { spec, ticket, tickets };
  });
}

function launchRun(
  system: ImplementationSystem,
  options?: Parameters<typeof seedPlanning>[1] & {
    readonly appReviewStrategy?: "legacy-inline" | "nested-workflow";
    readonly skips?: ReadonlyArray<OrchestrationImplementationSkipTarget>;
  },
) {
  return Effect.gen(function* () {
    const { ticket, tickets, spec } = yield* seedPlanning(system, options);
    yield* system.engine.dispatch({
      type: "thread.implementation-run.launch",
      commandId: commandId("implementation-launch"),
      threadId: sourceThreadId,
      specId: spec.id,
      baseBranch: "main",
      pinnedCommit: "abc123",
      orchestratorBranch: "implementation/checkout",
      orchestratorWorktreePath: "/tmp/implementation-reactor.worktrees/checkout",
      validationCommands: ["vp check", "vp run typecheck"],
      skips: options?.skips ? [...options.skips] : [],
      createdAt: now,
    });
    yield* system.reactor.drain;
    const snapshot = yield* system.query.getSnapshot();
    const run = snapshot.implementationRuns[0];
    if (!run) throw new Error("Run missing.");
    const legacyRun = {
      ...run,
      appReviewStrategy: options?.appReviewStrategy ?? ("legacy-inline" as const),
    };
    yield* system.engine.dispatch({
      type: "thread.implementation-run.update",
      commandId: commandId("implementation-mark-legacy-inline"),
      threadId: sourceThreadId,
      run: legacyRun,
      createdAt: now,
    });
    yield* system.reactor.drain;
    return { ticket, tickets, run: legacyRun };
  });
}

function appendWorkerResult(
  system: ImplementationSystem,
  input: {
    readonly run: OrchestrationImplementationRun;
    readonly status: "succeeded" | "failed";
    readonly ticketId?: string | undefined;
    readonly tag?: string;
    readonly commitSha?: string;
    readonly completeTicketReview?: boolean;
    readonly notesMarkdown?: string;
  },
) {
  return Effect.gen(function* () {
    const snapshot = yield* system.query.getSnapshot();
    const currentRun = snapshot.implementationRuns.find(
      (candidate) => candidate.id === input.run.id,
    );
    const state = input.ticketId
      ? currentRun?.ticketStates.find((candidate) => candidate.ticketId === input.ticketId)
      : currentRun?.ticketStates[0];
    if (!state?.workerThreadId || !state.branch || !state.worktreePath) {
      throw new Error("Worker was not started.");
    }
    yield* system.engine.dispatch({
      type: "thread.activity.append",
      commandId: commandId(`worker-${state.ticketId}-${input.status}-${input.tag ?? "initial"}`),
      threadId: state.workerThreadId,
      activity: {
        id: eventId(`worker-${state.ticketId}-${input.status}-${input.tag ?? "initial"}`),
        tone: input.status === "succeeded" ? "info" : "error",
        kind: "implementation-worker-result",
        summary: `Worker ${input.status}`,
        payload: {
          type: "implementation-worker-result",
          ticketId: state.ticketId,
          workerThreadId: state.workerThreadId,
          branch: state.branch,
          worktreePath: state.worktreePath,
          status: input.status,
          commitSha:
            input.status === "succeeded" ? (input.commitSha ?? `${state.branch}@commit`) : null,
          validations: requiredValidations(),
          notesMarkdown: input.notesMarkdown ?? input.status,
          reportedAt: "2026-01-01T00:00:01.000Z",
        },
        turnId: null,
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    yield* system.reactor.drain;
    if (
      input.status === "succeeded" &&
      input.completeTicketReview !== false &&
      input.run.appReviewStrategy === "nested-workflow"
    ) {
      const reviewingSnapshot = yield* system.query.getSnapshot();
      const reviewingRun = reviewingSnapshot.implementationRuns.find(
        (candidate) => candidate.id === input.run.id,
      );
      const reviewingState = reviewingRun?.ticketStates.find(
        (candidate) => candidate.ticketId === state.ticketId,
      );
      if (!reviewingState?.codeReviewThreadId) {
        throw new Error("Ticket Code Review was not started.");
      }
      yield* system.engine.dispatch({
        type: "thread.activity.append",
        commandId: commandId(`ticket-code-review-${state.ticketId}-${input.tag ?? "initial"}`),
        threadId: reviewingState.codeReviewThreadId,
        activity: {
          id: eventId(`ticket-code-review-${state.ticketId}-${input.tag ?? "initial"}`),
          tone: "info",
          kind: "implementation-code-review-result",
          summary: "Ticket code review clean",
          payload: {
            type: "implementation-code-review-result",
            runId: input.run.id,
            ticketId: state.ticketId,
            status: "clean",
            validations: requiredValidations("2026-01-01T00:00:01.500Z"),
            reportMarkdown: "## Standards\n- clean\n\n## Spec\n- clean",
          },
          turnId: null,
          createdAt: "2026-01-01T00:00:01.500Z",
        },
        createdAt: "2026-01-01T00:00:01.500Z",
      });
      yield* system.reactor.drain;
    }
  });
}

/** A run whose one ticket has passed its worker and is waiting on a live nested App Review. */
function launchTicketAppReview(system: ImplementationSystem) {
  return Effect.gen(function* () {
    const { run, ticket } = yield* launchRun(system, {
      appReviewStrategy: "nested-workflow",
      tickets: [
        {
          ...planningTicket("TICKET-1"),
          appReviewEligible: true,
          appReviewPlanMarkdown: "Open the page and check the header.",
        },
      ],
    });
    yield* appendWorkerResult(system, { run, status: "succeeded", completeTicketReview: false });
    const snapshot = yield* system.query.getSnapshot();
    const nestedRun = (snapshot.appReviewWorkflowRuns ?? [])[0];
    const state = snapshot.implementationRuns
      .find((entry) => entry.id === run.id)
      ?.ticketStates.find((entry) => entry.ticketId === ticket.id);
    if (!nestedRun || state?.appReviewWorkflowRunId !== nestedRun.id) {
      throw new Error("Ticket App Review was not launched.");
    }
    return { run, ticket, nestedRun };
  });
}

function failedReviewRecoveryState(run: AppReviewWorkflowRun, failedAt: string, idSuffix: string) {
  const failure: AppReviewWorkflowFailure = {
    reason: "review-blocked",
    phase: "review",
    cycleNumber: 1,
    detailMarkdown:
      "review exhausted its 2 phase launches.\n\nWorkflow nudges exhausted before App Review reported a verdict.",
    failedAt,
  };
  const cycle: AppReviewWorkflowCycle = {
    cycleNumber: 1,
    status: "failed",
    reviewId: AppReviewId.make(`app-review-recovery-${idSuffix}`),
    reviewerThreadId: ThreadId.make(`thread-app-review-recovery-${idSuffix}`),
    reviewLaunchCount: 2,
    planningLaunchCount: 0,
    fixingLaunchCount: 0,
    supersededThreadIds: [],
    reviewVerdict: null,
    actionableFindingsMarkdown: null,
    planId: null,
    plannerThreadId: null,
    plannerTurnId: null,
    fixerThreadId: null,
    repairTickets: [],
    ticketingTurnId: null,
    fixResult: null,
    failure,
    workspaceRevision: run.workspaceRevision,
    startedAt: now,
    completedAt: failedAt,
  };
  return { cycle, failure };
}

function passMergeGate(system: ImplementationSystem, run: OrchestrationImplementationRun) {
  return Effect.gen(function* () {
    const snapshot = yield* system.query.getSnapshot();
    const activeValidatorThreadId = snapshot.implementationRuns.find(
      (candidate) => candidate.id === run.id,
    )?.activeValidatorThreadId;
    const validator = snapshot.threads.find((thread) => thread.id === activeValidatorThreadId);
    if (!validator) throw new Error("Validator missing.");
    yield* system.engine.dispatch({
      type: "thread.activity.append",
      commandId: commandId(`merge-gate-pass-${validator.id}`),
      threadId: validator.id,
      activity: {
        id: eventId(`merge-gate-pass-${validator.id}`),
        tone: "info",
        kind: "implementation-merge-gate-result",
        summary: "Merge gate passed",
        payload: {
          type: "implementation-merge-gate-result",
          runId: run.id,
          status: "passed",
          validations: requiredValidations("2026-01-01T00:00:05.000Z"),
          summaryMarkdown: "ok",
        },
        turnId: null,
        createdAt: "2026-01-01T00:00:02.000Z",
      },
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    yield* system.reactor.drain;
    if (run.appReviewStrategy === "legacy-inline") {
      const reviewingSnapshot = yield* system.query.getSnapshot();
      const reviewingRun = reviewingSnapshot.implementationRuns.find(
        (candidate) => candidate.id === run.id,
      );
      if (
        reviewingRun?.status === "code-reviewing" &&
        reviewingRun.activeCodeReviewThreadId !== null
      ) {
        yield* appendCodeReviewResult(system, {
          run,
          threadId: reviewingRun.activeCodeReviewThreadId,
          status: "clean",
          tag: "combined-before-app-review",
        });
      }
    }
  });
}

function passFinalGate(system: ImplementationSystem, run: OrchestrationImplementationRun) {
  return Effect.gen(function* () {
    let snapshot = yield* system.query.getSnapshot();
    let currentRun = snapshot.implementationRuns.find((candidate) => candidate.id === run.id);
    if (currentRun?.status === "completed") return;
    if (currentRun?.status === "babysitting-change-request") {
      yield* passChangeRequestBabysit(system, run, "2026-01-01T00:00:07.000Z");
      return;
    }
    if (
      currentRun?.activeValidatorThreadId === null &&
      currentRun.activeCodeReviewThreadId !== null
    ) {
      yield* appendCodeReviewResult(system, {
        run,
        threadId: currentRun.activeCodeReviewThreadId,
        status: "clean",
        tag: "final-after-app-review",
      });
      snapshot = yield* system.query.getSnapshot();
      currentRun = snapshot.implementationRuns.find((candidate) => candidate.id === run.id);
    }
    if (currentRun?.status === "babysitting-change-request") {
      yield* passChangeRequestBabysit(system, run, "2026-01-01T00:00:07.000Z");
      return;
    }
    const activeValidatorThreadId = currentRun?.activeValidatorThreadId;
    const validator = snapshot.threads.find((thread) => thread.id === activeValidatorThreadId);
    if (!validator) throw new Error("Final validator missing.");
    yield* system.engine.dispatch({
      type: "thread.activity.append",
      commandId: commandId(`final-gate-pass-${validator.id}`),
      threadId: validator.id,
      activity: {
        id: eventId(`final-gate-pass-${validator.id}`),
        tone: "info",
        kind: "implementation-merge-gate-result",
        summary: "Final gate passed",
        payload: {
          type: "implementation-merge-gate-result",
          runId: run.id,
          status: "passed",
          validations: completeValidations(),
          summaryMarkdown: "Reviewed HEAD passed complete validation.",
        },
        turnId: null,
        createdAt: "2026-01-01T00:00:06.000Z",
      },
      createdAt: "2026-01-01T00:00:06.000Z",
    });
    yield* system.reactor.drain;
    yield* passChangeRequestBabysit(system, run, "2026-01-01T00:00:07.000Z");
  });
}

/**
 * Report green PR checks so a published run reaches `completed`.
 *
 * Publishing a change request no longer ends a run: it hands off to the
 * babysitter that watches the pull request's checks. Any test that publishes
 * and then expects a completed run has to walk that last stage.
 */
function passChangeRequestBabysit(
  system: ImplementationSystem,
  run: OrchestrationImplementationRun,
  createdAt: string,
) {
  return Effect.gen(function* () {
    const snapshot = yield* system.query.getSnapshot();
    const currentRun = snapshot.implementationRuns.find((candidate) => candidate.id === run.id);
    if (
      currentRun?.status !== "babysitting-change-request" ||
      currentRun.activeChangeRequestBabysitterThreadId === null
    ) {
      return;
    }
    const babysitterThreadId = currentRun.activeChangeRequestBabysitterThreadId;
    yield* system.engine.dispatch({
      type: "thread.activity.append",
      commandId: commandId(`pr-babysit-pass-${babysitterThreadId}`),
      threadId: babysitterThreadId,
      activity: {
        id: eventId(`pr-babysit-pass-${babysitterThreadId}`),
        tone: "info",
        kind: "implementation-change-request-babysit-result",
        summary: "Pull request checks passed",
        payload: {
          type: "implementation-change-request-babysit-result",
          runId: run.id,
          status: "passed",
          headSha: currentRun.validatedHeadSha ?? currentRun.codeReviewedHeadSha,
          summaryMarkdown: "All checks passed on the latest commit.",
        },
        turnId: null,
        createdAt,
      },
      createdAt,
    });
    yield* system.reactor.drain;
  });
}

function passAppReview(system: ImplementationSystem, run: OrchestrationImplementationRun) {
  return Effect.gen(function* () {
    const snapshot = yield* system.query.getSnapshot();
    const reviewingRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
    const reviewId = reviewingRun?.appReviewIds.at(-1);
    if (reviewId === undefined) throw new Error("App review missing.");
    yield* system.engine.dispatch({
      type: "thread.app-review.update",
      commandId: commandId(`app-review-pass-${reviewId}`),
      threadId: run.orchestratorThreadId,
      reviewId: AppReviewId.make(reviewId),
      status: "passed",
      updatedAt: "2026-01-01T00:00:03.000Z",
      createdAt: "2026-01-01T00:00:03.000Z",
    });
    yield* system.reactor.drain;
  });
}

function failAppReview(system: ImplementationSystem, run: OrchestrationImplementationRun) {
  const status = "failed" as const;
  return Effect.gen(function* () {
    const snapshot = yield* system.query.getSnapshot();
    const reviewingRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
    const reviewId = reviewingRun?.appReviewIds.at(-1);
    if (reviewId === undefined) throw new Error("App review missing.");
    yield* system.engine.dispatch({
      type: "thread.app-review.update",
      commandId: commandId(`app-review-${status}-${reviewId}`),
      threadId: run.orchestratorThreadId,
      reviewId: AppReviewId.make(reviewId),
      status,
      updatedAt: "2026-01-01T00:00:03.000Z",
      createdAt: "2026-01-01T00:00:03.000Z",
    });
    yield* system.reactor.drain;
  });
}

function appendBrowserFixResult(
  system: ImplementationSystem,
  input: {
    readonly run: OrchestrationImplementationRun;
    readonly validations: ReadonlyArray<ReturnType<typeof requiredValidations>[number]>;
  },
) {
  return Effect.gen(function* () {
    const snapshot = yield* system.query.getSnapshot();
    const fixer = snapshot.threads.find((thread) => thread.workflowRole === "implementation-fixer");
    if (fixer === undefined) throw new Error("Fixer missing.");
    yield* system.engine.dispatch({
      type: "thread.activity.append",
      commandId: commandId(`browser-fix-${input.validations.length}`),
      threadId: fixer.id,
      activity: {
        id: eventId(`browser-fix-${input.validations.length}`),
        tone: "info",
        kind: "implementation-fix-result",
        summary: "Browser fix succeeded",
        payload: {
          type: "implementation-fix-result",
          runId: input.run.id,
          status: "succeeded",
          validations: input.validations,
          notesMarkdown: "Applied Browser App Review findings.",
        },
        turnId: null,
        createdAt: "2026-01-01T00:00:04.000Z",
      },
      createdAt: "2026-01-01T00:00:04.000Z",
    });
    yield* system.reactor.drain;
  });
}

function appendCodeReviewResult(
  system: ImplementationSystem,
  input: {
    readonly run: OrchestrationImplementationRun;
    readonly threadId: ThreadId;
    readonly status: "clean" | "findings" | "blocked";
    readonly tag: string;
    /** Code Review lands its own fixes, so a "findings" result names the commit it produced. */
    readonly commitSha?: string;
    readonly validations?: ReadonlyArray<OrchestrationImplementationValidationResult>;
    readonly ticketId?: OrchestrationImplementationTicketState["ticketId"];
    readonly reportMarkdown?: string;
  },
) {
  return Effect.gen(function* () {
    const snapshot = yield* system.query.getSnapshot();
    const currentRun = snapshot.implementationRuns.find(
      (candidate) => candidate.id === input.run.id,
    );
    const ticketHead =
      input.ticketId === undefined
        ? undefined
        : currentRun?.ticketStates.find((state) => state.ticketId === input.ticketId)?.workerResult
            ?.commitSha;
    const commitSha =
      input.commitSha ?? (input.status === "findings" ? (ticketHead ?? "def456") : undefined);
    const validations =
      input.validations ??
      (input.status === "blocked"
        ? []
        : input.ticketId === undefined && input.status === "clean"
          ? completeValidations("2026-01-01T00:00:04.000Z")
          : requiredValidations("2026-01-01T00:00:04.000Z"));
    yield* system.engine.dispatch({
      type: "thread.activity.append",
      commandId: commandId(`code-review-${input.tag}`),
      threadId: input.threadId,
      activity: {
        id: eventId(`code-review-${input.tag}`),
        tone: input.status === "blocked" ? "error" : "info",
        kind: "implementation-code-review-result",
        summary: `Implementation code review ${input.status}`,
        payload: {
          type: "implementation-code-review-result",
          runId: input.run.id,
          ...(input.ticketId === undefined ? {} : { ticketId: input.ticketId }),
          status: input.status,
          ...(commitSha === undefined ? {} : { commitSha }),
          validations,
          reportMarkdown: input.reportMarkdown ?? "## Standards\n- finding\n\n## Spec\n- finding",
        },
        turnId: null,
        createdAt: "2026-01-01T00:00:04.000Z",
      },
      createdAt: "2026-01-01T00:00:04.000Z",
    });
    yield* system.reactor.drain;
  });
}

function nextThreadForRole(
  system: ImplementationSystem,
  role: "implementation-code-reviewer" | "implementation-fixer",
  seen: Set<string>,
) {
  return Effect.gen(function* () {
    const snapshot = yield* system.query.getSnapshot();
    const thread = snapshot.threads.find(
      (candidate) => candidate.workflowRole === role && !seen.has(candidate.id),
    );
    if (!thread) {
      throw new Error(
        `No new ${role} thread found. Seen: ${[...seen].join(", ")}. Available: ${snapshot.threads
          .filter((candidate) => candidate.workflowRole === role)
          .map((candidate) => candidate.id)
          .join(", ")}.`,
      );
    }
    seen.add(thread.id);
    return thread;
  });
}

const claudeParentSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-4-8",
};

function dispatchFastFeatureLaunch(
  system: ImplementationSystem,
  options?: { readonly reusePreparedWorkspace?: boolean },
) {
  return Effect.gen(function* () {
    const sourceBranch = options?.reusePreparedWorkspace
      ? "workflow/fast-feature-checkout"
      : "main";
    yield* system.engine.dispatch({
      type: "project.create",
      commandId: commandId("fast-project-create"),
      projectId,
      title: "Fast feature reactor",
      workspaceRoot: "/tmp/implementation-reactor",
      createdAt: now,
    });
    yield* system.engine.dispatch({
      type: "thread.create",
      commandId: commandId("fast-source-create"),
      threadId: sourceThreadId,
      projectId,
      ownerUserId: DEFAULT_WORKSPACE_USER_ID,
      parentThreadId: null,
      workflowRole: null,
      title: "Fast checkout",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5-codex" },
      runtimeMode: "full-access",
      interactionMode: "plan",
      workflowPreset: "fast-feature",
      branch: sourceBranch,
      worktreePath: "/tmp/implementation-reactor",
      createdAt: now,
    });
    yield* system.engine.dispatch({
      type: "thread.activity.append",
      commandId: commandId("fast-intent"),
      threadId: sourceThreadId,
      activity: {
        id: eventId("fast-intent"),
        tone: "info",
        kind: "product-intent-locked",
        summary: "Fast checkout",
        payload: {
          intentKind: "feature",
          title: "Fast checkout",
          summaryMarkdown: "Add a fast checkout path.",
        },
        turnId: null,
        createdAt: now,
      },
      createdAt: now,
    });
    yield* system.engine.dispatch({
      type: "thread.proposed-plan.upsert",
      commandId: commandId("fast-plan"),
      threadId: sourceThreadId,
      proposedPlan: {
        id: "plan-fast",
        turnId: null,
        planMarkdown: "# Fast checkout\nImplement the focused checkout change.",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: now,
        updatedAt: now,
      },
      createdAt: now,
    });
    yield* system.engine.dispatch({
      type: "thread.fast-feature-run.launch",
      commandId: commandId("fast-launch"),
      threadId: sourceThreadId,
      proposedPlanId: "plan-fast",
      baseBranch: "main",
      pinnedCommit: "abc123",
      orchestratorBranch: options?.reusePreparedWorkspace
        ? sourceBranch
        : "fast-feature/fast-checkout",
      orchestratorWorktreePath: options?.reusePreparedWorkspace
        ? "/tmp/implementation-reactor"
        : "/tmp/implementation-reactor.worktrees/fast-checkout",
      validationCommands: ["vp check", "vp run typecheck"],
      createdAt: now,
    });
  });
}

function launchFastFeatureRun(system: ImplementationSystem) {
  return Effect.gen(function* () {
    yield* dispatchFastFeatureLaunch(system);
    yield* system.reactor.drain;
    const snapshot = yield* system.query.getSnapshot();
    const run = snapshot.implementationRuns[0];
    if (!run) throw new Error("Fast feature run missing.");
    const legacyRun = { ...run, appReviewStrategy: "legacy-inline" as const };
    yield* system.engine.dispatch({
      type: "thread.implementation-run.update",
      commandId: commandId("fast-feature-mark-legacy-inline"),
      threadId: sourceThreadId,
      run: legacyRun,
      createdAt: now,
    });
    yield* system.reactor.drain;
    return legacyRun;
  });
}

function launchFastFeatureNestedReview(system: ImplementationSystem) {
  return Effect.gen(function* () {
    yield* dispatchFastFeatureLaunch(system);
    yield* system.reactor.drain;
    let snapshot = yield* system.query.getSnapshot();
    const run = snapshot.implementationRuns[0];
    const implementer = snapshot.threads.find(
      (thread) => thread.workflowRole === "fast-feature-implementer",
    );
    if (!run || !implementer) throw new Error("Fast feature Build did not start.");
    yield* system.engine.dispatch({
      type: "thread.activity.append",
      commandId: commandId("nested-fast-build-result"),
      threadId: implementer.id,
      activity: {
        id: eventId("nested-fast-build-result"),
        tone: "info",
        kind: "implementation-fast-build-result",
        summary: "Fast Build succeeded",
        payload: {
          type: "implementation-fast-build-result",
          runId: run.id,
          status: "succeeded",
          commitSha: "def456",
          validations: requiredValidations(),
          notesMarkdown: "Implemented and committed.",
        },
        turnId: null,
        createdAt: "2026-01-01T00:00:02.000Z",
      },
      createdAt: "2026-01-01T00:00:02.000Z",
    });
    yield* system.reactor.drain;
    snapshot = yield* system.query.getSnapshot();
    const nestedRun = snapshot.appReviewWorkflowRuns?.[0];
    const currentRun = snapshot.implementationRuns[0];
    if (!nestedRun || !currentRun) throw new Error("Nested App Review did not launch.");
    return { run: currentRun, nestedRun };
  });
}

it("omits workflow ownership for legacy orchestrator threads without workflow context", () => {
  const orchestratorThreadId = ThreadId.make("thread-legacy-orchestrator");

  expect(
    workflowIdForRun({ threads: [{ id: orchestratorThreadId }] }, { orchestratorThreadId }),
  ).toBeUndefined();
});

describe("ImplementationWorkflowReactor", () => {
  it("derives backend health from the authoritative frontend origin", () => {
    expect(
      appDevStackBackendHealthUrl("https://feature-frontend.example.test/calendar?view=month"),
    ).toBe("https://feature-frontend.example.test/api/health");
  });

  it.effect("gives an Implementation run its own workflow identity and parent link", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        const snapshot = yield* system.query.getSnapshot();
        const source = snapshot.threads.find((thread) => thread.id === sourceThreadId);
        const orchestrator = snapshot.threads.find(
          (thread) => thread.id === run.orchestratorThreadId,
        );
        const worker = snapshot.threads.find(
          (thread) => thread.workflowRole === "implementation-worker",
        );

        expect(orchestrator?.workflowContext).toMatchObject({
          workflowId: run.id,
          parentWorkflowId: source?.workflowContext?.workflowId,
          rootThreadId: sourceThreadId,
        });
        expect(worker?.workflowContext?.workflowId).toBe(run.id);
      }),
    ),
  );

  it.effect("decodes historical implementation runs with safe execution-state defaults", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        const historical = { ...run } as Record<string, unknown>;
        delete historical["finalCodeReviewGeneration"];
        delete historical["finalCodeReviewLaunchCount"];
        delete historical["finalCodeReviewPassCount"];
        delete historical["codeReviewExhaustedAt"];
        delete historical["codeReviewExhaustionReason"];
        delete historical["automationHalt"];
        historical["ticketStates"] = run.ticketStates.map((state) => {
          const ticket = { ...state } as Record<string, unknown>;
          delete ticket["implementationGeneration"];
          delete ticket["appReviewGeneration"];
          delete ticket["appReviewLaunchCount"];
          delete ticket["codeReviewGeneration"];
          delete ticket["codeReviewLaunchCount"];
          delete ticket["codeReviewPassCount"];
          return ticket;
        });

        const decoded = yield* decodeImplementationRun(historical);
        expect(decoded.finalCodeReviewGeneration).toBe(0);
        expect(decoded.finalCodeReviewLaunchCount).toBe(0);
        expect(decoded.finalCodeReviewPassCount).toBe(0);
        expect(decoded.codeReviewExhaustedAt).toBeNull();
        expect(decoded.codeReviewExhaustionReason).toBeNull();
        expect(decoded.automationHalt).toBeNull();
        expect(decoded.ticketStates[0]).toMatchObject({
          implementationGeneration: 0,
          appReviewGeneration: 0,
          appReviewLaunchCount: 0,
          codeReviewGeneration: 0,
          codeReviewLaunchCount: 0,
          codeReviewPassCount: 0,
        });
      }),
    ),
  );

  it.effect("composes new Fast Feature runs through a distinct nested App Review workflow", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, nestedRun } = yield* launchFastFeatureNestedReview(system);
        const snapshot = yield* system.query.getSnapshot();

        expect(run.appReviewStrategy).toBe("nested-workflow");
        expect(run.appReviewWorkflowRunIds).toEqual([nestedRun.id]);
        expect(nestedRun.caller).toEqual({
          type: "implementation",
          implementationRunId: run.id,
          orchestratorThreadId: run.orchestratorThreadId,
        });
        const source = snapshot.threads.find((thread) => thread.id === sourceThreadId);
        const implementer = snapshot.threads.find(
          (thread) => thread.workflowRole === "fast-feature-implementer",
        );
        const reviewController = snapshot.threads.find(
          (thread) => thread.workflowRole === "app-review-orchestrator",
        );
        expect(source?.workflowContext).toMatchObject({
          workflowId: `workflow-${sourceThreadId}`,
          parentWorkflowId: null,
          rootThreadId: sourceThreadId,
        });
        expect(implementer?.workflowContext?.workflowId).toBe(source?.workflowContext?.workflowId);
        expect(reviewController?.workflowContext).toMatchObject({
          workflowId: nestedRun.id,
          parentWorkflowId: source?.workflowContext?.workflowId,
          rootThreadId: sourceThreadId,
        });
        expect(
          snapshot.threads.some((thread) => thread.workflowRole === "implementation-qa-reviewer"),
        ).toBe(false);
      }),
    ),
  );

  it.effect("reconnects a halted Fast Feature run to its manually rerun App Review thread", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, nestedRun } = yield* launchFastFeatureNestedReview(system);
        const failedAt = "2026-01-01T00:04:00.000Z";
        const { cycle, failure } = failedReviewRecoveryState(nestedRun, failedAt, "fast-feature");
        const failedRun = {
          ...nestedRun,
          status: "failed" as const,
          outcome: "failed" as const,
          activePhase: null,
          activeThreadId: null,
          failure,
          cycles: [
            {
              ...cycle,
              status: "failed" as const,
              reviewLaunchCount: 2,
              failure,
              completedAt: failedAt,
            },
          ],
          updatedAt: failedAt,
          completedAt: failedAt,
        };
        yield* system.engine.dispatch({
          type: "thread.app-review-workflow.update",
          commandId: commandId("fail-fast-feature-review-before-recovery"),
          threadId: nestedRun.controllerThreadId,
          run: failedRun,
          createdAt: failedAt,
        });
        yield* system.reactor.drain;

        let current = (yield* system.query.getSnapshot()).implementationRuns.find(
          (candidate) => candidate.id === run.id,
        );
        expect(current?.status).toBe("needs-human-attention");
        expect(current?.automationHalt).toMatchObject({
          stage: "app-review",
          category: "review-blocked",
        });

        if (current === undefined) throw new Error("Halted Fast Feature run missing.");
        yield* system.engine.dispatch({
          type: "thread.implementation-run.update",
          commandId: commandId("replace-fast-feature-review-halt"),
          threadId: sourceThreadId,
          run: {
            ...current,
            automationHalt: {
              stage: "app-review",
              category: "structural-invariant",
              detail: "A stale parent worktree check halted the active nested review.",
              haltedAt: "2026-01-01T00:04:30.000Z",
            },
            updatedAt: "2026-01-01T00:04:30.000Z",
          },
          createdAt: "2026-01-01T00:04:30.000Z",
        });
        yield* system.reactor.drain;

        yield* system.engine.dispatch({
          type: "thread.app-review-workflow.update",
          commandId: commandId("recover-fast-feature-review-in-place"),
          threadId: nestedRun.controllerThreadId,
          run: {
            ...failedRun,
            status: "running",
            outcome: null,
            activePhase: "review",
            activeThreadId: cycle.reviewerThreadId,
            failure: null,
            cycles: [
              {
                ...cycle,
                status: "reviewing",
                recoveryContinuationCount: 0,
                failure: null,
                completedAt: null,
              },
            ],
            updatedAt: "2026-01-01T00:05:00.000Z",
            completedAt: null,
          },
          createdAt: "2026-01-01T00:05:00.000Z",
        });
        yield* system.reactor.drain;

        current = (yield* system.query.getSnapshot()).implementationRuns.find(
          (candidate) => candidate.id === run.id,
        );
        expect(current?.status).toBe("qa-reviewing");
        expect(current?.automationHalt).toBeNull();
        expect(current?.appReviewWorkflowRunIds.at(-1)).toBe(nestedRun.id);
      }),
    ),
  );

  it.effect("continues after a nested pass and halts after exhaustion", () =>
    Effect.all(
      (["passed", "exhausted"] as const).map((outcome) =>
        withSystem((system) =>
          Effect.gen(function* () {
            const { run, nestedRun } = yield* launchFastFeatureNestedReview(system);
            yield* system.engine.dispatch({
              type: "thread.app-review-workflow.update",
              commandId: commandId(`nested-${outcome}`),
              threadId: nestedRun.controllerThreadId,
              run: {
                ...nestedRun,
                status: outcome,
                cyclesUsed: outcome === "passed" ? 1 : nestedRun.cycleBudget,
                activePhase: null,
                activeThreadId: null,
                outcome,
                finalHeadSha: "def456",
                updatedAt: "2026-01-01T00:00:03.000Z",
                completedAt: "2026-01-01T00:00:03.000Z",
              },
              createdAt: "2026-01-01T00:00:03.000Z",
            });
            yield* system.reactor.drain;

            const snapshot = yield* system.query.getSnapshot();
            const updated = snapshot.implementationRuns.find(
              (candidate) => candidate.id === run.id,
            );
            expect(updated?.latestAppReviewWorkflowOutcome).toBe(outcome);
            expect(
              snapshot.threads.some(
                (thread) => thread.workflowRole === "implementation-code-reviewer",
              ),
            ).toBe(true);
            if (outcome === "exhausted") {
              expect(updated?.status).toBe("code-reviewing");
              expect(updated?.qaExhaustionReason).toBe("app-review");
              expect(updated?.automationHalt).toBeNull();
            } else {
              expect(updated?.status).toBe("code-reviewing");
            }
          }),
        ),
      ),
      { concurrency: 1 },
    ),
  );

  it.effect("sets up Fast feature Build and starts App Review only after a verified result", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const run = yield* launchFastFeatureRun(system);
        let snapshot = yield* system.query.getSnapshot();
        const implementer = snapshot.threads.find(
          (thread) => thread.workflowRole === "fast-feature-implementer",
        );
        if (!implementer) throw new Error("Fast feature implementer missing.");
        expect(run.status).toBe("running");
        expect(run.specId).toBeNull();
        expect(implementer.messages.at(-1)?.text).toContain("# Fast checkout");
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-qa-reviewer"),
        ).toHaveLength(0);
        expect(yield* Ref.get(system.createWorktreeInputs)).toHaveLength(1);
        const firstAutoCreateInputs = yield* Ref.get(system.autoCreateInputs);
        expect(firstAutoCreateInputs).toHaveLength(0);

        yield* system.engine.dispatch({
          type: "thread.activity.append",
          commandId: commandId("fast-build-result"),
          threadId: implementer.id,
          activity: {
            id: eventId("fast-build-result"),
            tone: "info",
            kind: "implementation-fast-build-result",
            summary: "Fast Build succeeded",
            payload: {
              type: "implementation-fast-build-result",
              runId: run.id,
              status: "succeeded",
              commitSha: "def456",
              validations: requiredValidations(),
              notesMarkdown: "Implemented and committed.",
            },
            turnId: null,
            createdAt: "2026-01-01T00:00:02.000Z",
          },
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        const reviewingRun = snapshot.implementationRuns[0];
        expect(reviewingRun?.status).toBe("qa-reviewing");
        expect(reviewingRun?.fastBuildResult?.commitSha).toBe("def456");
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-qa-reviewer"),
        ).toHaveLength(1);
        expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(1);
        expect((yield* Ref.get(system.autoCreateInputs)).map((input) => input.workflowId)).toEqual([
          snapshot.threads.find((thread) => thread.id === run.orchestratorThreadId)?.workflowContext
            ?.workflowId,
        ]);
      }),
    ),
  );

  it.effect("uses a fresh TDD child for Fast feature App Review findings", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const run = yield* launchFastFeatureRun(system);
        let snapshot = yield* system.query.getSnapshot();
        const implementer = snapshot.threads.find(
          (thread) => thread.workflowRole === "fast-feature-implementer",
        );
        if (!implementer) throw new Error("Fast feature implementer missing.");
        yield* system.engine.dispatch({
          type: "thread.activity.append",
          commandId: commandId("fast-build-before-review-failure"),
          threadId: implementer.id,
          activity: {
            id: eventId("fast-build-before-review-failure"),
            tone: "info",
            kind: "implementation-fast-build-result",
            summary: "Fast Build succeeded",
            payload: {
              type: "implementation-fast-build-result",
              runId: run.id,
              status: "succeeded",
              commitSha: "def456",
              validations: requiredValidations(),
              notesMarkdown: "Implemented and committed.",
            },
            turnId: null,
            createdAt: "2026-01-01T00:00:02.000Z",
          },
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        yield* system.reactor.drain;
        yield* failAppReview(system, run);

        snapshot = yield* system.query.getSnapshot();
        const repairingRun = snapshot.implementationRuns[0];
        const repair = snapshot.threads.find(
          (thread) => thread.workflowRole === "implementation-fixer",
        );
        expect(repairingRun?.status).toBe("fixing");
        expect(repairingRun?.fixOrigin).toBe("app-review");
        expect(repairingRun?.qaCycleCount).toBe(1);
        expect(repair?.parentThreadId).toBe(run.orchestratorThreadId);
        expect(repair?.messages.at(-1)?.text).toContain("Orchestrated QA Repair Result");
        expect(repair?.messages.at(-1)?.text).toContain("Canonical proposed plan");
        expect(
          snapshot.threads.find((thread) => thread.id === implementer.id)?.messages,
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("accepts a Build result that lands after the run was blocked at Build", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const run = yield* launchFastFeatureRun(system);
        const implementer = (yield* system.query.getSnapshot()).threads.find(
          (thread) => thread.workflowRole === "fast-feature-implementer",
        );
        if (!implementer) throw new Error("Fast feature implementer missing.");

        // The spurious "Build finished without a directive" that used to fire minutes into a
        // build that was still running.
        yield* system.engine.dispatch({
          type: "thread.activity.append",
          commandId: commandId("fast-build-missing"),
          threadId: implementer.id,
          activity: {
            id: eventId("fast-build-missing"),
            tone: "error",
            kind: "implementation-fast-build-result",
            summary: "Fast feature Build result was missing or malformed",
            payload: {
              type: "implementation-fast-build-result",
              runId: run.id,
              status: "blocked",
              validations: [],
              notesMarkdown: "Fast feature Build completed without the required directive.",
            },
            turnId: null,
            createdAt: "2026-01-01T00:00:01.000Z",
          },
          createdAt: "2026-01-01T00:00:01.000Z",
        });
        yield* system.reactor.drain;

        let snapshot = yield* system.query.getSnapshot();
        expect(snapshot.implementationRuns[0]?.status).toBe("needs-human-attention");
        expect(snapshot.implementationRuns[0]?.retryableFailure?.stage).toBe("build");

        // Build then finishes for real, long after the retry budget was spent.
        yield* system.engine.dispatch({
          type: "thread.activity.append",
          commandId: commandId("fast-build-late-success"),
          threadId: implementer.id,
          activity: {
            id: eventId("fast-build-late-success"),
            tone: "info",
            kind: "implementation-fast-build-result",
            summary: "Fast Build succeeded",
            payload: {
              type: "implementation-fast-build-result",
              runId: run.id,
              status: "succeeded",
              commitSha: "def456",
              validations: requiredValidations(),
              notesMarkdown: "Implemented and committed.",
            },
            turnId: null,
            createdAt: "2026-01-01T00:00:02.000Z",
          },
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        const reviewingRun = snapshot.implementationRuns[0];
        expect(reviewingRun?.status).toBe("qa-reviewing");
        expect(reviewingRun?.fastBuildResult?.status).toBe("succeeded");
        expect(reviewingRun?.fastBuildResult?.commitSha).toBe("def456");
        expect(reviewingRun?.retryableFailure).toBeNull();
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-qa-reviewer"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("re-prompts Build on retry after a succeeded result was rejected", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const run = yield* launchFastFeatureRun(system);
        const implementer = (yield* system.query.getSnapshot()).threads.find(
          (thread) => thread.workflowRole === "fast-feature-implementer",
        );
        if (!implementer) throw new Error("Fast feature implementer missing.");
        expect(implementer.messages).toHaveLength(1);

        // Build reports success after running launch-level complete commands, so the run is
        // blocked at Build while `fastBuildResult.status` stays "succeeded".
        yield* system.engine.dispatch({
          type: "thread.activity.append",
          commandId: commandId("fast-build-mismatched-validations"),
          threadId: implementer.id,
          activity: {
            id: eventId("fast-build-mismatched-validations"),
            tone: "info",
            kind: "implementation-fast-build-result",
            summary: "Fast Build succeeded",
            payload: {
              type: "implementation-fast-build-result",
              runId: run.id,
              status: "succeeded",
              commitSha: "def456",
              validations: completeValidations(),
              notesMarkdown: "Implemented and committed.",
            },
            turnId: null,
            createdAt: "2026-01-01T00:00:02.000Z",
          },
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        yield* system.reactor.drain;

        let snapshot = yield* system.query.getSnapshot();
        const blocked = snapshot.implementationRuns[0];
        expect(blocked?.status).toBe("needs-human-attention");
        expect(blocked?.retryableFailure?.stage).toBe("build");
        expect(blocked?.fastBuildResult?.status).toBe("succeeded");

        yield* system.engine.dispatch({
          type: "thread.implementation-run.retry",
          commandId: commandId("fast-build-retry"),
          threadId: sourceThreadId,
          runId: run.id,
          createdAt: "2026-01-01T00:00:03.000Z",
        });
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        const retried = snapshot.threads.find((thread) => thread.id === implementer.id);
        expect(snapshot.implementationRuns[0]?.status).toBe("running");
        // A retry that starts no turn is the bug: Build must actually be asked again, and told why.
        expect(retried?.messages).toHaveLength(2);
        expect(retried?.messages.at(-1)?.role).toBe("user");
        expect(retried?.messages.at(-1)?.text).toContain("Your last result was rejected");
        expect(retried?.messages.at(-1)?.text).toContain(
          "must not run launch-level complete commands before Code Review",
        );
      }),
    ),
  );

  it.effect("keeps the Build contract and the Build gate in lockstep", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const run = yield* launchFastFeatureRun(system);
        // The example directive the prompt tells Build to copy must itself pass the gate that
        // judges the real one. If a prompt edit ever breaks that round trip, it fails here rather
        // than by rejecting a finished build in production.
        expect(fastFeatureBuildContractProblems(run)).toEqual([]);

        const prompt = (yield* system.query.getSnapshot()).threads.find(
          (thread) => thread.workflowRole === "fast-feature-implementer",
        )?.messages[0]?.text;
        if (prompt === undefined) throw new Error("Build handover missing.");
        for (const command of run.launchSummary.validationCommands) {
          expect(prompt).toContain(`- ${command}`);
        }
        expect(prompt).toContain("Do not run the launch-level complete validation commands");

        // The embedded example is generated from the run's own commands, not hardcoded.
        const fence = /```json\s*([\s\S]*?)```/.exec(prompt)?.[1] ?? "";
        const example = yield* decodeBuildContractExample(fence);
        expect(example.validations.map((validation) => validation.command)).toEqual([
          "<focused test or documented sub-minute fast check actually run>",
        ]);
      }),
    ),
  );

  it.effect("blocks App Review instead of reviewing a stack that is not running", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const run = yield* launchFastFeatureRun(system);
          expect(run.appDevStack.status).toBe("not-requested");

          const implementer = (yield* system.query.getSnapshot()).threads.find(
            (thread) => thread.workflowRole === "fast-feature-implementer",
          );
          if (!implementer) throw new Error("Fast feature implementer missing.");

          yield* system.engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId("fast-build-stack-starting"),
            threadId: implementer.id,
            activity: {
              id: eventId("fast-build-stack-starting"),
              tone: "info",
              kind: "implementation-fast-build-result",
              summary: "Fast Build succeeded",
              payload: {
                type: "implementation-fast-build-result",
                runId: run.id,
                status: "succeeded",
                commitSha: "def456",
                validations: requiredValidations(),
                notesMarkdown: "Implemented and committed.",
              },
              turnId: null,
              createdAt: "2026-01-01T00:00:02.000Z",
            },
            createdAt: "2026-01-01T00:00:02.000Z",
          });
          yield* system.reactor.drain;

          const snapshot = yield* system.query.getSnapshot();
          const blocked = snapshot.implementationRuns[0];
          expect(blocked?.status).toBe("needs-human-attention");
          expect(blocked?.retryableFailure?.stage).toBe("app-dev-stack");
          expect(blocked?.retryableFailure?.detail).toContain("not 'running'");
          // No reviewer is sent at a URL that cannot serve it.
          expect(
            snapshot.threads.filter(
              (thread) => thread.workflowRole === "implementation-qa-reviewer",
            ),
          ).toHaveLength(0);
          expect(blocked?.qaAttemptCount).toBe(0);
          const orchestrator = snapshot.threads.find(
            (thread) => thread.id === run.orchestratorThreadId,
          );
          const waiting = orchestrator?.activities.find(
            (activity) => activity.kind === "implementation-app-dev-stack-waiting",
          );
          expect(waiting?.tone).toBe("info");
          expect(waiting?.summary).toBe("Waiting for App Dev Stack");
        }),
      { autoCreateStackStatus: "starting" },
    ),
  );

  it.effect("re-ensures AppDevStack directly after a focused repair", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const run = yield* launchFastFeatureRun(system);
          const implementer = (yield* system.query.getSnapshot()).threads.find(
            (thread) => thread.workflowRole === "fast-feature-implementer",
          );
          if (!implementer) throw new Error("Fast feature implementer missing.");

          yield* system.engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId("fast-build-stack-repair"),
            threadId: implementer.id,
            activity: {
              id: eventId("fast-build-stack-repair"),
              tone: "info",
              kind: "implementation-fast-build-result",
              summary: "Fast Build succeeded",
              payload: {
                type: "implementation-fast-build-result",
                runId: run.id,
                status: "succeeded",
                commitSha: "def456",
                validations: requiredValidations(),
                notesMarkdown: "Implemented and committed.",
              },
              turnId: null,
              createdAt: "2026-01-01T00:00:02.000Z",
            },
            createdAt: "2026-01-01T00:00:02.000Z",
          });
          yield* system.reactor.drain;
          yield* appendBrowserFixResult(system, { run, validations: requiredValidations() });

          const snapshot = yield* system.query.getSnapshot();
          const reviewing = snapshot.implementationRuns.find((entry) => entry.id === run.id);
          expect(reviewing?.status).toBe("qa-reviewing");
          expect(reviewing?.fixOrigin).toBeNull();
          expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(2);
          expect(
            snapshot.threads.filter((thread) => thread.workflowRole === "implementation-validator"),
          ).toHaveLength(0);
          expect(reviewing?.appReviewIds).toHaveLength(1);
        }),
      { failAutoCreateAttempts: 1 },
    ),
  );

  it.effect("starts TDD repair when the frontend shell is up but backend health is down", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const run = yield* launchFastFeatureRun(system);
          expect(run.appDevStack.status).toBe("not-requested");

          const implementer = (yield* system.query.getSnapshot()).threads.find(
            (thread) => thread.workflowRole === "fast-feature-implementer",
          );
          if (!implementer) throw new Error("Fast feature implementer missing.");

          yield* system.engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId("fast-build-edge-down"),
            threadId: implementer.id,
            activity: {
              id: eventId("fast-build-edge-down"),
              tone: "info",
              kind: "implementation-fast-build-result",
              summary: "Fast Build succeeded",
              payload: {
                type: "implementation-fast-build-result",
                runId: run.id,
                status: "succeeded",
                commitSha: "def456",
                validations: requiredValidations(),
                notesMarkdown: "Implemented and committed.",
              },
              turnId: null,
              createdAt: "2026-01-01T00:00:02.000Z",
            },
            createdAt: "2026-01-01T00:00:02.000Z",
          });
          yield* system.reactor.drain;

          const snapshot = yield* system.query.getSnapshot();
          const repairing = snapshot.implementationRuns[0];
          expect(repairing?.status).toBe("fixing");
          expect(repairing?.fixOrigin).toBe("app-dev-stack");
          expect(repairing?.lastQaFailure?.detailMarkdown).toContain("returned HTTP 503");
          expect(repairing?.lastQaFailure?.detailMarkdown).toContain("backend health");
          expect(repairing?.qaCycleCount).toBe(1);
          // Both the static frontend shell and its same-origin backend must be ready.
          const probeUrls = yield* Ref.get(system.frontendProbeUrls);
          expect(probeUrls).toContain("http://127.0.0.1:5173");
          expect(probeUrls).toContain("http://127.0.0.1:5173/api/health");
          // No reviewer launched, no App Review attempt burned.
          expect(
            snapshot.threads.filter(
              (thread) => thread.workflowRole === "implementation-qa-reviewer",
            ),
          ).toHaveLength(0);
          expect(repairing?.qaAttemptCount).toBe(0);
        }),
      { frontendProbeStatus: 200, backendProbeStatus: 503 },
    ),
  );

  it.effect(
    "terminally blocks a canonical review when its reviewer completes without updating it",
    () =>
      withSystem((system) =>
        Effect.gen(function* () {
          const run = yield* launchFastFeatureRun(system);
          const implementer = (yield* system.query.getSnapshot()).threads.find(
            (thread) => thread.workflowRole === "fast-feature-implementer",
          );
          if (!implementer) throw new Error("Fast feature implementer missing.");

          yield* system.engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId("fast-build-for-idle-reviewer"),
            threadId: implementer.id,
            activity: {
              id: eventId("fast-build-for-idle-reviewer"),
              tone: "info",
              kind: "implementation-fast-build-result",
              summary: "Fast Build succeeded",
              payload: {
                type: "implementation-fast-build-result",
                runId: run.id,
                status: "succeeded",
                commitSha: "def456",
                validations: requiredValidations(),
                notesMarkdown: "Implemented and committed.",
              },
              turnId: null,
              createdAt: "2026-01-01T00:00:02.000Z",
            },
            createdAt: "2026-01-01T00:00:02.000Z",
          });
          yield* system.reactor.drain;

          let snapshot = yield* system.query.getSnapshot();
          const reviewer = snapshot.threads.find(
            (thread) => thread.workflowRole === "implementation-qa-reviewer",
          );
          if (!reviewer) throw new Error("App Review thread missing.");
          expect(snapshot.implementationRuns[0]?.qaAttemptCount).toBe(1);

          // The reviewer completed without terminally updating its canonical record.
          yield* system.engine.dispatch({
            type: "thread.session.set",
            commandId: commandId("reviewer-session-ready"),
            threadId: reviewer.id,
            session: {
              threadId: reviewer.id,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt: "2026-01-01T00:00:03.000Z",
            },
            createdAt: "2026-01-01T00:00:03.000Z",
          });

          yield* system.reactor.start();
          yield* system.reactor.drain;

          snapshot = yield* system.query.getSnapshot();
          expect(
            snapshot.threads.filter(
              (thread) => thread.workflowRole === "implementation-qa-reviewer",
            ),
          ).toHaveLength(1);
          expect(snapshot.implementationRuns[0]?.qaAttemptCount).toBe(1);
          expect(snapshot.implementationRuns[0]?.qaCycleCount).toBe(1);
          expect(snapshot.implementationRuns[0]?.status).toBe("fixing");
          expect(
            snapshot.threads.filter((thread) => thread.workflowRole === "implementation-fixer"),
          ).toHaveLength(1);
        }),
      ),
  );

  it.effect("ignores a Build result once the run has moved past Build", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const run = yield* launchFastFeatureRun(system);
        const implementer = (yield* system.query.getSnapshot()).threads.find(
          (thread) => thread.workflowRole === "fast-feature-implementer",
        );
        if (!implementer) throw new Error("Fast feature implementer missing.");

        const reportBuild = (tag: string, createdAt: string) =>
          system.engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId(tag),
            threadId: implementer.id,
            activity: {
              id: eventId(tag),
              tone: "info",
              kind: "implementation-fast-build-result",
              summary: "Fast Build succeeded",
              payload: {
                type: "implementation-fast-build-result",
                runId: run.id,
                status: "succeeded",
                commitSha: "def456",
                validations: requiredValidations(),
                notesMarkdown: "Implemented and committed.",
              },
              turnId: null,
              createdAt,
            },
            createdAt,
          });

        yield* reportBuild("fast-build-first", "2026-01-01T00:00:02.000Z");
        yield* system.reactor.drain;
        const reviewing = (yield* system.query.getSnapshot()).implementationRuns[0];
        expect(reviewing?.status).toBe("qa-reviewing");
        expect(reviewing?.qaAttemptCount).toBe(1);

        yield* reportBuild("fast-build-repeat", "2026-01-01T00:00:03.000Z");
        yield* system.reactor.drain;
        const snapshot = yield* system.query.getSnapshot();
        expect(snapshot.implementationRuns[0]?.qaAttemptCount).toBe(1);
        expect(snapshot.implementationRuns[0]?.updatedAt).toBe(reviewing?.updatedAt);
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-qa-reviewer"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("reconciles an earlier running canonical review after a later attempt terminated", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const run = yield* launchFastFeatureRun(system);
        const implementer = (yield* system.query.getSnapshot()).threads.find(
          (thread) => thread.workflowRole === "fast-feature-implementer",
        );
        if (!implementer) throw new Error("Fast feature implementer missing.");

        yield* system.engine.dispatch({
          type: "thread.activity.append",
          commandId: commandId("fast-build-for-legacy-running-review"),
          threadId: implementer.id,
          activity: {
            id: eventId("fast-build-for-legacy-running-review"),
            tone: "info",
            kind: "implementation-fast-build-result",
            summary: "Fast Build succeeded",
            payload: {
              type: "implementation-fast-build-result",
              runId: run.id,
              status: "succeeded",
              commitSha: "def456",
              validations: requiredValidations(),
              notesMarkdown: "Implemented and committed.",
            },
            turnId: null,
            createdAt: "2026-01-01T00:00:02.000Z",
          },
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        yield* system.reactor.drain;

        let snapshot = yield* system.query.getSnapshot();
        const reviewingRun = snapshot.implementationRuns[0];
        const canonicalReviewId = reviewingRun?.appReviewIds[0];
        const canonicalReviewer = snapshot.threads.find(
          (thread) => thread.workflowRole === "implementation-qa-reviewer",
        );
        if (!reviewingRun || canonicalReviewId === undefined || !canonicalReviewer) {
          throw new Error("Canonical App Review missing.");
        }

        const nestedReviewId = AppReviewId.make("app-review-legacy-nested");
        const nestedReviewerId = ThreadId.make("thread-app-review-legacy-nested");
        yield* system.engine.dispatch({
          type: "thread.app-review.launch",
          commandId: commandId("legacy-nested-review-launch"),
          sourceThreadId: canonicalReviewer.id,
          reviewThreadId: nestedReviewerId,
          reviewId: nestedReviewId,
          message: {
            messageId: messageId("legacy-nested-review-launch"),
            role: "user",
            text: "Run the nested full review.",
            attachments: [],
          },
          modelSelection: canonicalReviewer.modelSelection,
          runtimeMode: "full-access",
          workflowPromptId: "implementation.browser-app-review.codex",
          createdAt: "2026-01-01T00:00:03.000Z",
        });
        const nestedEvidence = {
          recording: {
            status: "failed" as const,
            path: null,
            mimeType: null,
            sizeBytes: null,
            startedAt: null,
            completedAt: null,
            error: "Mailbox fixtures unavailable.",
          },
          screenshots: [],
        };
        yield* system.engine.dispatch({
          type: "thread.app-review.evidence.update",
          commandId: commandId("legacy-nested-review-evidence"),
          threadId: canonicalReviewer.id,
          reviewId: nestedReviewId,
          evidence: nestedEvidence,
          updatedAt: "2026-01-01T00:00:04.000Z",
          createdAt: "2026-01-01T00:00:04.000Z",
        });
        yield* system.engine.dispatch({
          type: "thread.app-review.update",
          commandId: commandId("legacy-nested-review-blocked"),
          threadId: canonicalReviewer.id,
          reviewId: nestedReviewId,
          status: "failed",
          document: {
            verdict: "failed",
            summary: "Connected-account and mailbox fixtures are unavailable.",
            checks: [],
            findings: [],
            questions: [],
            nextSteps: ["Seed the missing fixtures."],
          },
          updatedAt: "2026-01-01T00:00:04.000Z",
          createdAt: "2026-01-01T00:00:04.000Z",
        });

        const laterReviewId = AppReviewId.make("app-review-later-terminal");
        const laterReviewerId = ThreadId.make("thread-app-review-later-terminal");
        yield* system.engine.dispatch({
          type: "thread.app-review.launch",
          commandId: commandId("later-terminal-review-launch"),
          sourceThreadId: run.orchestratorThreadId,
          reviewThreadId: laterReviewerId,
          reviewId: laterReviewId,
          message: {
            messageId: messageId("later-terminal-review-launch"),
            role: "user",
            text: "Run the later review attempt.",
            attachments: [],
          },
          modelSelection: canonicalReviewer.modelSelection,
          runtimeMode: "full-access",
          workflowPromptId: "implementation.browser-app-review.codex",
          createdAt: "2026-01-01T00:00:05.000Z",
        });
        yield* system.engine.dispatch({
          type: "thread.app-review.update",
          commandId: commandId("later-terminal-review-failed"),
          threadId: run.orchestratorThreadId,
          reviewId: laterReviewId,
          status: "failed",
          updatedAt: "2026-01-01T00:00:06.000Z",
          createdAt: "2026-01-01T00:00:06.000Z",
        });
        yield* system.engine.dispatch({
          type: "thread.implementation-run.update",
          commandId: commandId("record-later-terminal-review"),
          threadId: sourceThreadId,
          run: {
            ...reviewingRun,
            appReviewIds: [...reviewingRun.appReviewIds, laterReviewId],
            updatedAt: "2026-01-01T00:00:06.000Z",
          },
          createdAt: "2026-01-01T00:00:06.000Z",
        });
        yield* system.engine.dispatch({
          type: "thread.session.set",
          commandId: commandId("legacy-canonical-reviewer-ready"),
          threadId: canonicalReviewer.id,
          session: {
            threadId: canonicalReviewer.id,
            status: "ready",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:07.000Z",
          },
          createdAt: "2026-01-01T00:00:07.000Z",
        });

        yield* system.reactor.start();
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        const orchestrator = snapshot.threads.find(
          (thread) => thread.id === run.orchestratorThreadId,
        );
        const canonicalReview = orchestrator?.appReviews.find(
          (review) => review.id === canonicalReviewId,
        );
        expect(canonicalReview?.status).toBe("failed");
        expect(canonicalReview?.document.summary).toContain("mailbox fixtures");
        expect(canonicalReview?.evidence).toEqual(nestedEvidence);
        expect(orchestrator?.appReviews.find((review) => review.id === laterReviewId)?.status).toBe(
          "failed",
        );
      }),
    ),
  );

  it.effect("recovers a blocked run whose Build result was never consumed", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          // With the reactor stopped, the Build result lands on the thread with nobody to apply
          // it — exactly what a spent retry budget or a restart mid-dispatch leaves behind.
          yield* dispatchFastFeatureLaunch(system);
          let snapshot = yield* system.query.getSnapshot();
          const run = snapshot.implementationRuns[0];
          const implementer = snapshot.threads.find(
            (thread) => thread.workflowRole === "fast-feature-implementer",
          );
          if (!run || !implementer) throw new Error("Fast feature run missing.");

          // Build ran to completion before the run was stranded, so its worktree exists.
          yield* Ref.update(system.createWorktreeInputs, (inputs) => [
            ...inputs,
            {
              cwd: "/tmp/implementation-reactor",
              refName: "main",
              newRefName: run.orchestratorBranch,
              path: run.orchestratorWorktreePath,
            },
          ]);
          yield* Ref.update(system.activeWorktreePaths, (paths) =>
            new Set(paths).add(run.orchestratorWorktreePath),
          );

          yield* system.engine.dispatch({
            type: "thread.implementation-run.update",
            commandId: commandId("fast-run-blocked"),
            threadId: sourceThreadId,
            run: {
              ...run,
              appReviewStrategy: "legacy-inline",
              status: "needs-human-attention",
              retryableFailure: {
                stage: "build",
                detail: "Fast feature Build completed without the required directive.",
                failedAt: "2026-01-01T00:00:01.000Z",
                attemptCount: 3,
                maxAttempts: 3,
                humanBlocked: false,
              },
              updatedAt: "2026-01-01T00:00:01.000Z",
            },
            createdAt: "2026-01-01T00:00:01.000Z",
          });
          yield* system.engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId("fast-build-unconsumed"),
            threadId: implementer.id,
            activity: {
              id: eventId("fast-build-unconsumed"),
              tone: "info",
              kind: "implementation-fast-build-result",
              summary: "Fast Build succeeded",
              payload: {
                type: "implementation-fast-build-result",
                runId: run.id,
                status: "succeeded",
                commitSha: "def456",
                validations: requiredValidations(),
                notesMarkdown: "Implemented and committed.",
              },
              turnId: null,
              createdAt: "2026-01-01T00:00:02.000Z",
            },
            createdAt: "2026-01-01T00:00:02.000Z",
          });

          yield* system.reactor.start();
          yield* system.reactor.drain;

          snapshot = yield* system.query.getSnapshot();
          const recovered = snapshot.implementationRuns[0];
          expect(recovered?.automationHalt).toBeNull();
          expect(recovered?.retryableFailure).toBeNull();
          expect(recovered?.status).toBe("qa-reviewing");
          expect(recovered?.fastBuildResult?.status).toBe("succeeded");
          expect(recovered?.retryableFailure).toBeNull();
          // The run is now stamped at the activity it consumed, so the sweep's
          // `activity.createdAt > run.updatedAt` guard cannot match it again.
          expect(recovered?.updatedAt).toBe("2026-01-01T00:00:02.000Z");
          expect(
            snapshot.threads.filter(
              (thread) => thread.workflowRole === "implementation-qa-reviewer",
            ),
          ).toHaveLength(1);

          // `activity.createdAt > run.updatedAt` is the whole termination argument: a run blocked
          // again at or after the activity it already consumed must not have it re-applied.
          if (!recovered) throw new Error("Recovered run missing.");
          yield* system.engine.dispatch({
            type: "thread.implementation-run.update",
            commandId: commandId("fast-run-blocked-again"),
            threadId: sourceThreadId,
            run: {
              ...recovered,
              status: "needs-human-attention",
              fastBuildResult: null,
              retryableFailure: {
                stage: "app-review",
                detail: "App Review could not run.",
                failedAt: "2026-01-01T00:00:02.000Z",
                attemptCount: 3,
                maxAttempts: 3,
                humanBlocked: false,
              },
              updatedAt: "2026-01-01T00:00:02.000Z",
            },
            createdAt: "2026-01-01T00:00:02.000Z",
          });
          yield* system.reactor.start();
          yield* system.reactor.drain;
          const settled = (yield* system.query.getSnapshot()).implementationRuns[0];
          expect(settled?.status).toBe("needs-human-attention");
          expect(settled?.fastBuildResult).toBeNull();
        }),
      { startReactor: false },
    ),
  );

  it.effect("starts Fast Build before requesting the app dev stack", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* dispatchFastFeatureLaunch(system);
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const implementer = snapshot.threads.find(
          (thread) => thread.workflowRole === "fast-feature-implementer",
        );
        if (!implementer) throw new Error("Fast feature implementer missing.");
        expect(implementer.messages.at(-1)?.text).toContain("# Fast checkout");
        expect(implementer.messages.at(-1)?.role).toBe("user");
        expect(snapshot.implementationRuns[0]?.appDevStack.status).toBe("not-requested");
        expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(0);
      }),
    ),
  );

  it.effect("runs Fast Build directly in the prepared workflow workspace", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          yield* dispatchFastFeatureLaunch(system, { reusePreparedWorkspace: true });
          yield* system.reactor.drain;

          const snapshot = yield* system.query.getSnapshot();
          const run = snapshot.implementationRuns[0];
          const implementer = snapshot.threads.find(
            (thread) => thread.workflowRole === "fast-feature-implementer",
          );
          expect(run?.status).toBe("running");
          expect(run?.orchestratorBranch).toBe("workflow/fast-feature-checkout");
          expect(run?.orchestratorWorktreePath).toBe("/tmp/implementation-reactor");
          expect(implementer?.messages.at(-1)?.text).toContain("# Fast checkout");
          expect(yield* Ref.get(system.createWorktreeInputs)).toHaveLength(0);
          expect(run?.appDevStack.status).toBe("not-requested");
          expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(0);
        }),
      { sourceRefName: "workflow/fast-feature-checkout" },
    ),
  );

  it.effect("starts planning-spec workers before requesting the shared app dev stack", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { spec } = yield* seedPlanning(system);
        yield* system.engine.dispatch({
          type: "thread.implementation-run.launch",
          commandId: commandId("implementation-deferred-stack-launch"),
          threadId: sourceThreadId,
          specId: spec.id,
          baseBranch: "main",
          pinnedCommit: "abc123",
          orchestratorBranch: "implementation/checkout",
          orchestratorWorktreePath: "/tmp/implementation-reactor.worktrees/checkout",
          validationCommands: ["vp check", "vp run typecheck"],
          createdAt: now,
        });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const worker = snapshot.threads.find(
          (thread) => thread.workflowRole === "implementation-worker",
        );
        expect(worker?.messages.at(-1)?.role).toBe("user");
        expect(snapshot.implementationRuns[0]?.status).toBe("running");
        expect(snapshot.implementationRuns[0]?.appDevStack.status).toBe("not-requested");
        expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(0);
      }),
    ),
  );

  it.effect("reuses the Planning worktree and only creates TDD child worktrees", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { spec } = yield* seedPlanning(system, {
            sourceBranch: "workflow/planning-checkout",
          });
          yield* system.engine.dispatch({
            type: "thread.implementation-run.launch",
            commandId: commandId("implementation-reuse-planning-workspace"),
            threadId: sourceThreadId,
            specId: spec.id,
            baseBranch: "main",
            pinnedCommit: "abc123",
            orchestratorBranch: "workflow/planning-checkout",
            orchestratorWorktreePath: "/tmp/implementation-reactor",
            validationCommands: ["vp test run focused.test.ts"],
            createdAt: now,
          });
          yield* system.reactor.drain;

          const snapshot = yield* system.query.getSnapshot();
          const run = snapshot.implementationRuns[0];
          expect(run?.orchestratorBranch).toBe("workflow/planning-checkout");
          expect(run?.orchestratorWorktreePath).toBe("/tmp/implementation-reactor");
          expect(run?.appDevStack.status).toBe("not-requested");

          const worktrees = yield* Ref.get(system.createWorktreeInputs);
          expect(worktrees).toHaveLength(1);
          expect(worktrees[0]?.cwd).toBe("/tmp/implementation-reactor");
          expect(worktrees[0]?.path).toBe("/tmp/implementation-reactor-ticket-1");
          expect(worktrees[0]?.newRefName).toContain("-ticket-1");
        }),
      { sourceRefName: "workflow/planning-checkout" },
    ),
  );

  it.effect(
    "does not provision the app dev stack when implementation is canceled before review",
    () =>
      withSystem((system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          yield* system.engine.dispatch({
            type: "thread.implementation-run.cancel",
            commandId: commandId("implementation-cancel-before-review"),
            threadId: sourceThreadId,
            runId: run.id,
            reason: "Stop before review.",
            createdAt: "2026-01-01T00:00:01.000Z",
          });
          yield* system.reactor.drain;

          const settled = (yield* system.query.getSnapshot()).implementationRuns[0];
          expect(settled?.status).toBe("canceled");
          expect(settled?.appDevStack.status).toBe("not-requested");
          expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(0);

          const rerun = yield* system.engine.dispatch({
            type: "thread.implementation-run.rerun",
            commandId: commandId("implementation-rerun-canceled-before-review"),
            threadId: sourceThreadId,
            runId: run.id,
            target: { kind: "run", stage: "code-review" },
            createdAt: "2026-01-01T00:00:02.000Z",
          });
          expect(rerun.outcome).toMatchObject({
            type: "rejected",
            reasonCode: "wrong-stage",
          });
        }),
      ),
  );

  it.effect("does not re-ensure the inherited stack before Fast Build completes", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const run = yield* launchFastFeatureRun(system);
          expect(run.status).toBe("running");
          expect(run.appDevStack.status).toBe("not-requested");

          let snapshot = yield* system.query.getSnapshot();
          const implementer = snapshot.threads.find(
            (thread) => thread.workflowRole === "fast-feature-implementer",
          );
          if (!implementer) throw new Error("Fast feature implementer missing.");
          expect(implementer.messages.at(-1)?.text).toContain("# Fast checkout");
          expect(implementer.messages.at(-1)?.text).toContain(
            "App Dev Stack: created by workflow workspace bootstrap after dependency setup; Build reuses it",
          );
          expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(0);

          // Startup recovery must leave a run that already reached Build alone.
          yield* system.reactor.start();
          yield* system.reactor.drain;
          snapshot = yield* system.query.getSnapshot();
          expect(snapshot.implementationRuns[0]?.status).toBe("running");
          expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(0);
        }),
      { failAutoCreate: true },
    ),
  );

  it.effect("re-seeds a Fast feature Build thread that was stranded without a turn", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          // The decider creates the Build thread and the run; the reactor seeds the turn. With the
          // reactor stopped, only startup recovery can close that gap — the live event stream does
          // not replay what was dispatched before `start`.
          yield* dispatchFastFeatureLaunch(system);
          let snapshot = yield* system.query.getSnapshot();
          const stranded = snapshot.threads.find(
            (thread) => thread.workflowRole === "fast-feature-implementer",
          );
          if (!stranded) throw new Error("Fast feature implementer missing.");
          expect(stranded.messages).toHaveLength(0);
          expect(stranded.latestTurn).toBeNull();
          expect(snapshot.implementationRuns[0]?.status).toBe("launch-pending");

          yield* system.reactor.start();
          yield* system.reactor.drain;

          snapshot = yield* system.query.getSnapshot();
          const recovered = snapshot.threads.find(
            (thread) => thread.workflowRole === "fast-feature-implementer",
          );
          expect(snapshot.implementationRuns[0]?.retryableFailure).toBeNull();
          expect(recovered?.id).toBe(stranded.id);
          expect(recovered?.messages).toHaveLength(1);
          expect(recovered?.messages.at(-1)?.text).toContain("# Fast checkout");
          expect(snapshot.implementationRuns[0]?.status).toBe("running");
        }),
      { startReactor: false },
    ),
  );

  it.effect("hands over a short instruction and the full plan, with no filler sections", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* launchFastFeatureRun(system);
        const snapshot = yield* system.query.getSnapshot();
        const prompt = snapshot.threads.find(
          (thread) => thread.workflowRole === "fast-feature-implementer",
        )?.messages[0]?.text;
        expect(prompt).toContain("Implement the canonical plan");
        expect(prompt).toContain("## Canonical proposed plan");
        expect(prompt).toContain("# Fast checkout\nImplement the focused checkout change.");
        // Sections that could only ever render as "unavailable" have no business in the handover.
        expect(prompt).not.toContain("unavailable");
        expect(prompt).not.toContain("Locked product intent");
      }),
    ),
  );

  it.effect("blocks instead of starting Build when the proposed plan is gone", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          yield* dispatchFastFeatureLaunch(system);
          // The plan is the whole payload of the handover. Point the run at one that is not on the
          // source thread before the reactor gets a chance to seed Build.
          const launched = (yield* system.query.getSnapshot()).implementationRuns[0];
          if (!launched) throw new Error("Fast feature run missing.");
          yield* system.engine.dispatch({
            type: "thread.implementation-run.update",
            commandId: commandId("fast-plan-detach"),
            threadId: sourceThreadId,
            run: {
              ...launched,
              sourceProposedPlan: { threadId: sourceThreadId, planId: "plan-missing" },
            },
            createdAt: now,
          });
          yield* system.reactor.start();
          yield* system.reactor.drain;

          const snapshot = yield* system.query.getSnapshot();
          const implementer = snapshot.threads.find(
            (thread) => thread.workflowRole === "fast-feature-implementer",
          );
          expect(implementer?.messages).toHaveLength(0);
          const run = snapshot.implementationRuns[0];
          expect(run?.status).toBe("needs-human-attention");
          expect(run?.retryableFailure?.stage).toBe("build");
          expect(run?.retryableFailure?.humanBlocked).toBe(true);
        }),
      { startReactor: false },
    ),
  );

  it.effect("requires and probes the inherited stack after Build before Browser App Review", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const run = yield* launchFastFeatureRun(system);
          let snapshot = yield* system.query.getSnapshot();
          expect(snapshot.implementationRuns[0]?.appDevStack).toMatchObject({
            status: "not-requested",
            frontendUrl: null,
          });

          const implementer = snapshot.threads.find(
            (thread) => thread.workflowRole === "fast-feature-implementer",
          );
          if (!implementer) throw new Error("Fast feature implementer missing.");
          yield* system.engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId("fast-build-refresh-stack-url"),
            threadId: implementer.id,
            activity: {
              id: eventId("fast-build-refresh-stack-url"),
              tone: "info",
              kind: "implementation-fast-build-result",
              summary: "Fast Build succeeded",
              payload: {
                type: "implementation-fast-build-result",
                runId: run.id,
                status: "succeeded",
                commitSha: "def456",
                validations: requiredValidations(),
                notesMarkdown: "Implemented and committed.",
              },
              turnId: null,
              createdAt: "2026-01-01T00:00:02.000Z",
            },
            createdAt: "2026-01-01T00:00:02.000Z",
          });
          yield* system.reactor.drain;

          snapshot = yield* system.query.getSnapshot();
          const reviewThread = snapshot.threads.find(
            (thread) => thread.workflowRole === "implementation-qa-reviewer",
          );
          expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(1);
          expect(snapshot.implementationRuns[0]?.appDevStack.frontendUrl).toBe(
            "https://fast-checkout-dev.nightingale-ai.com",
          );
          expect(reviewThread?.messages.at(-1)?.text).toContain(
            "Feature URL: https://fast-checkout-dev.nightingale-ai.com",
          );
          expect(reviewThread?.messages.at(-1)?.text).toContain(
            "authoritative frontend for the App Dev Stack associated with this implementation worktree",
          );
          expect(reviewThread?.messages.at(-1)?.text).toContain(
            "Do not substitute a deployment URL from repository documentation",
          );
        }),
      {
        autoCreateFrontendUrls: ["https://fast-checkout-dev.nightingale-ai.com"],
      },
    ),
  );

  it.effect("blocks instead of creating a replacement when the inherited stack is missing", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const run = yield* launchFastFeatureRun(system);
          const snapshot = yield* system.query.getSnapshot();
          const implementer = snapshot.threads.find(
            (thread) => thread.workflowRole === "fast-feature-implementer",
          );
          if (!implementer) throw new Error("Fast feature implementer missing.");

          yield* system.engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId("fast-build-missing-inherited-stack"),
            threadId: implementer.id,
            activity: {
              id: eventId("fast-build-missing-inherited-stack"),
              tone: "info",
              kind: "implementation-fast-build-result",
              summary: "Fast Build succeeded",
              payload: {
                type: "implementation-fast-build-result",
                runId: run.id,
                status: "succeeded",
                commitSha: "def456",
                validations: requiredValidations(),
                notesMarkdown: "Implemented and committed.",
              },
              turnId: null,
              createdAt: "2026-01-01T00:00:02.000Z",
            },
            createdAt: "2026-01-01T00:00:02.000Z",
          });
          yield* system.reactor.drain;

          const settled = (yield* system.query.getSnapshot()).implementationRuns[0];
          expect(settled?.status).toBe("needs-human-attention");
          expect(settled?.retryableFailure?.stage).toBe("app-dev-stack");
          expect(settled?.retryableFailure?.humanBlocked).toBe(true);
          expect(settled?.lastQaFailure?.detailMarkdown).toContain(
            "workflow-owned App Dev Stack is missing",
          );
          expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(0);
        }),
      { inheritedStackMissing: true },
    ),
  );

  it.effect("starts a fresh TDD repair when Fast feature dev-stack startup fails", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const run = yield* launchFastFeatureRun(system);
          const snapshot = yield* system.query.getSnapshot();
          const implementer = snapshot.threads.find(
            (thread) => thread.workflowRole === "fast-feature-implementer",
          );
          if (!implementer) throw new Error("Fast feature implementer missing.");
          expect(snapshot.implementationRuns[0]?.status).toBe("running");

          yield* system.engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId("fast-build-stack-failure"),
            threadId: implementer.id,
            activity: {
              id: eventId("fast-build-stack-failure"),
              tone: "info",
              kind: "implementation-fast-build-result",
              summary: "Fast Build succeeded",
              payload: {
                type: "implementation-fast-build-result",
                runId: run.id,
                status: "succeeded",
                commitSha: "def456",
                validations: requiredValidations(),
                notesMarkdown: "Implemented and committed.",
              },
              turnId: null,
              createdAt: "2026-01-01T00:00:02.000Z",
            },
            createdAt: "2026-01-01T00:00:02.000Z",
          });
          yield* system.reactor.drain;

          const afterFailure = yield* system.query.getSnapshot();
          const repairing = afterFailure.implementationRuns[0];
          expect(repairing?.status).toBe("fixing");
          expect(repairing?.fixOrigin).toBe("app-dev-stack");
          expect(repairing?.qaCycleCount).toBe(1);
          expect(repairing?.appReviewIds).toHaveLength(0);
          const repair = afterFailure.threads.find(
            (thread) => thread.workflowRole === "implementation-fixer",
          );
          expect(repair?.messages.at(-1)?.text).toContain("Orchestrated QA Repair Result");
          expect(repair?.messages.at(-1)?.text).toContain("Programmatic AppDevStack diagnostics");
          expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(1);
        }),
      { failAutoCreate: true },
    ),
  );

  it.effect("blocks infrastructure repair when the controller cannot see the worktree", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const run = yield* launchFastFeatureRun(system);
          const implementer = (yield* system.query.getSnapshot()).threads.find(
            (thread) => thread.workflowRole === "fast-feature-implementer",
          );
          if (!implementer) throw new Error("Fast feature implementer missing.");

          yield* system.engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId("fast-build-unmounted-worktree"),
            threadId: implementer.id,
            activity: {
              id: eventId("fast-build-unmounted-worktree"),
              tone: "info",
              kind: "implementation-fast-build-result",
              summary: "Fast Build succeeded",
              payload: {
                type: "implementation-fast-build-result",
                runId: run.id,
                status: "succeeded",
                commitSha: "def456",
                validations: requiredValidations(),
                notesMarkdown: "Implemented and committed.",
              },
              turnId: null,
              createdAt: "2026-01-01T00:00:02.000Z",
            },
            createdAt: "2026-01-01T00:00:02.000Z",
          });
          yield* system.reactor.drain;

          const snapshot = yield* system.query.getSnapshot();
          const blocked = snapshot.implementationRuns.find((entry) => entry.id === run.id);
          expect(blocked?.status).toBe("needs-human-attention");
          expect(blocked?.retryableFailure?.humanBlocked).toBe(true);
          expect(blocked?.retryableFailure?.detail).toContain(
            "not visible to the App Dev Stack controller",
          );
          expect(
            snapshot.threads.filter((thread) => thread.workflowRole === "implementation-fixer"),
          ).toHaveLength(0);
        }),
      {
        failAutoCreate: true,
        autoCreateFailureMessage:
          "Worktree path is not visible to the App Dev Stack controller: /var/lib/code/worktrees/feature.",
      },
    ),
  );

  it.effect("exhausts the Build retry budget instead of relaunching the stage forever", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const run = yield* launchFastFeatureRun(system);
        const implementer = (yield* system.query.getSnapshot()).threads.find(
          (thread) => thread.workflowRole === "fast-feature-implementer",
        );
        if (!implementer) throw new Error("Fast feature implementer missing.");

        const failBuild = (attempt: number) =>
          Effect.gen(function* () {
            const at = `2026-01-01T00:0${attempt}:00.000Z`;
            yield* system.engine.dispatch({
              type: "thread.activity.append",
              commandId: commandId(`fast-build-blocked-${attempt}`),
              threadId: implementer.id,
              activity: {
                id: eventId(`fast-build-blocked-${attempt}`),
                tone: "info",
                kind: "implementation-fast-build-result",
                summary: "Fast Build blocked",
                payload: {
                  type: "implementation-fast-build-result",
                  runId: run.id,
                  status: "blocked",
                  validations: [],
                  notesMarkdown: "Workflow directive JSON is malformed.",
                },
                turnId: null,
                createdAt: at,
              },
              createdAt: at,
            });
            yield* system.reactor.drain;
            return (yield* system.query.getSnapshot()).implementationRuns[0];
          });

        const retry = (attempt: number) =>
          Effect.gen(function* () {
            yield* system.engine.dispatch({
              type: "thread.implementation-run.retry",
              commandId: commandId(`fast-build-retry-${attempt}`),
              threadId: sourceThreadId,
              runId: run.id,
              createdAt: `2026-01-01T00:0${attempt}:30.000Z`,
            });
            yield* system.reactor.drain;
            return (yield* system.query.getSnapshot()).implementationRuns[0];
          });

        // Each block/retry pair must raise the attempt count. Before the fix the
        // resume cleared `retryableFailure`, so this stayed pinned at 1 forever.
        const first = yield* failBuild(2);
        expect(first?.status).toBe("needs-human-attention");
        expect(first?.retryableFailure?.stage).toBe("build");
        expect(first?.retryableFailure?.attemptCount).toBe(1);

        yield* retry(2);
        const second = yield* failBuild(3);
        expect(second?.retryableFailure?.attemptCount).toBe(2);

        expect(second?.retryableFailure?.maxAttempts).toBe(2);
        expect(second?.automationHalt).toMatchObject({
          stage: "implementation",
          category: "retry-exhausted",
        });

        expect(second?.automationHalt).not.toBeNull();
      }),
    ),
  );

  it.effect("cancels a Fast feature run, stops its threads, and settles the run terminally", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const run = yield* launchFastFeatureRun(system);
        const implementer = (yield* system.query.getSnapshot()).threads.find(
          (thread) => thread.workflowRole === "fast-feature-implementer",
        );
        if (!implementer) throw new Error("Fast feature implementer missing.");

        yield* system.engine.dispatch({
          type: "thread.implementation-run.cancel",
          commandId: commandId("fast-cancel"),
          threadId: sourceThreadId,
          runId: run.id,
          reason: "Stopped from the composer.",
          createdAt: "2026-01-01T00:00:05.000Z",
        });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        expect(snapshot.implementationRuns[0]?.status).toBe("canceled");
        expect(snapshot.implementationRuns[0]?.retryableFailure).toBeNull();
        const canceledActivity = snapshot.threads
          .find((thread) => thread.id === implementer.id)
          ?.activities.find((activity) => activity.kind === "implementation-workflow.canceled");
        expect(canceledActivity).toBeDefined();

        // A late Build directive must not resurrect the canceled run.
        yield* system.engine.dispatch({
          type: "thread.activity.append",
          commandId: commandId("fast-build-after-cancel"),
          threadId: implementer.id,
          activity: {
            id: eventId("fast-build-after-cancel"),
            tone: "info",
            kind: "implementation-fast-build-result",
            summary: "Fast Build blocked",
            payload: {
              type: "implementation-fast-build-result",
              runId: run.id,
              status: "blocked",
              validations: [],
              notesMarkdown: "Too late.",
            },
            turnId: null,
            createdAt: "2026-01-01T00:00:06.000Z",
          },
          createdAt: "2026-01-01T00:00:06.000Z",
        });
        yield* system.reactor.drain;

        expect((yield* system.query.getSnapshot()).implementationRuns[0]?.status).toBe("canceled");

        // Canceling twice is rejected rather than silently re-emitted.
        const secondCancel = yield* Effect.result(
          system.engine.dispatch({
            type: "thread.implementation-run.cancel",
            commandId: commandId("fast-cancel-again"),
            threadId: sourceThreadId,
            runId: run.id,
            createdAt: "2026-01-01T00:00:07.000Z",
          }),
        );
        expect(secondCancel._tag).toBe("Failure");
      }),
    ),
  );

  it.effect("halts a Fast feature run before launching from a dirty source", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          yield* launchFastFeatureRun(system);
          const snapshot = yield* system.query.getSnapshot();

          expect(snapshot.implementationRuns[0]?.status).toBe("needs-human-attention");
          expect(snapshot.implementationRuns[0]?.retryableFailure?.humanBlocked).toBe(true);
          expect(snapshot.implementationRuns[0]?.automationHalt).toMatchObject({
            stage: "implementation",
            category: "structural-invariant",
          });
          expect(yield* Ref.get(system.createWorktreeInputs)).toHaveLength(0);
          expect(
            snapshot.threads.filter((thread) => thread.workflowRole === "fast-feature-implementer"),
          ).toHaveLength(1);
        }),
      { dirtySourceStatusChecks: 1 },
    ),
  );

  it.effect("does not warn about a dirty source when the source worktree is clean", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* launchFastFeatureRun(system);
        const snapshot = yield* system.query.getSnapshot();
        expect(
          snapshot.threads
            .find((thread) => thread.id === sourceThreadId)
            ?.activities.some((activity) => activity.kind === "fast-feature.source-dirty-ignored"),
        ).toBe(false);
      }),
    ),
  );

  it.effect("blocks a moved source branch as human-blocked and never auto-retries it", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          yield* launchFastFeatureRun(system);
          let snapshot = yield* system.query.getSnapshot();

          // A moved HEAD is a real "you changed something" condition, unlike routine dirt.
          expect(snapshot.implementationRuns[0]?.status).toBe("needs-human-attention");
          expect(snapshot.implementationRuns[0]?.retryableFailure?.stage).toBe("source-dirty");
          expect(snapshot.implementationRuns[0]?.retryableFailure?.humanBlocked).toBe(true);
          expect(snapshot.implementationRuns[0]?.retryableFailure?.attemptCount).toBe(1);
          expect(yield* Ref.get(system.createWorktreeInputs)).toHaveLength(0);

          // The 30s sweep must leave the attempt budget intact: retrying a branch the
          // user has to move back can never succeed, and burning all three attempts
          // before they read the message is what wedged the production run.
          yield* system.reactor.recoverRetryableRuns();
          yield* system.reactor.recoverRetryableRuns();
          yield* system.reactor.drain;

          snapshot = yield* system.query.getSnapshot();
          expect(snapshot.implementationRuns[0]?.retryableFailure?.attemptCount).toBe(1);
        }),
      { sourceRefName: "some-other-branch" },
    ),
  );

  it.effect("creates the orchestrator worktree before starting ready workers", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        const snapshot = yield* system.query.getSnapshot();
        const workerThread = snapshot.threads.find(
          (thread) => thread.workflowRole === "implementation-worker",
        );
        const createWorktreeInputs = yield* Ref.get(system.createWorktreeInputs);

        expect(createWorktreeInputs[0]).toMatchObject({
          path: run.orchestratorWorktreePath,
          newRefName: run.orchestratorBranch,
        });
        expect(createWorktreeInputs[1]).toMatchObject({
          path: run.launchSummary.plannedWorkers[0]?.worktreePath,
          newRefName: run.launchSummary.plannedWorkers[0]?.branch,
        });
        // Worker branches must not nest under the orchestrator branch ref: git cannot
        // create `X/ticket-N` once branch `X` exists.
        expect(run.launchSummary.plannedWorkers[0]?.branch).toBe(
          "implementation/checkout-ticket-1",
        );
        expect(run.launchSummary.plannedWorkers[0]?.worktreePath).toBe(
          "/tmp/implementation-reactor.worktrees/checkout-ticket-1",
        );
        expect(workerThread?.parentThreadId).toBe(run.orchestratorThreadId);
      }),
    ),
  );

  it.effect("starts all 30 ready tickets with unique worker identities and singleton scopes", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const plannedTickets = Array.from({ length: 30 }, (_, index) =>
          planningTicket(`TICKET-${index + 1}`),
        );
        const { run, tickets } = yield* launchRun(system, {
          tickets: plannedTickets,
        });
        const snapshot = yield* system.query.getSnapshot();
        const workers = snapshot.threads.filter(
          (thread) => thread.workflowRole === "implementation-worker",
        );
        const states = snapshot.implementationRuns.find(
          (entry) => entry.id === run.id,
        )?.ticketStates;

        expect(workers).toHaveLength(30);
        expect(new Set(workers.map((thread) => thread.id)).size).toBe(30);
        expect(new Set(workers.map((thread) => thread.branch)).size).toBe(30);
        expect(new Set(workers.map((thread) => thread.worktreePath)).size).toBe(30);
        expect(workers.map((thread) => thread.workflowContext?.ticketScope).toSorted()).toEqual(
          tickets.map((ticket) => [ticket.id]).toSorted(),
        );
        expect(states?.every((state) => state.status === "running")).toBe(true);
      }),
    ),
  );

  it.effect("turns prompt-authored tickets into a durable implementation run automatically", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        yield* system.engine.dispatch({
          type: "project.create",
          commandId: commandId("prompt-project-create"),
          projectId,
          title: "Prompt implementation",
          workspaceRoot: "/tmp/implementation-reactor",
          createdAt: now,
        });
        yield* system.engine.dispatch({
          type: "thread.create",
          commandId: commandId("prompt-thread-create"),
          threadId: sourceThreadId,
          projectId,
          ownerUserId: DEFAULT_WORKSPACE_USER_ID,
          parentThreadId: null,
          workflowRole: null,
          title: "Implement checkout from prompt",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: "implementation-workflow",
          branch: "main",
          worktreePath: "/tmp/implementation-reactor",
          createdAt: now,
        });
        yield* system.engine.dispatch({
          type: "thread.planning-tickets.apply",
          commandId: commandId("prompt-tickets-apply"),
          threadId: sourceThreadId,
          sourceMessageId: messageId("prompt-tickets-source"),
          specId: "spec-prompt-checkout",
          tickets: [planningTicket("TICKET-1")],
          createdAt: now,
        });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const source = snapshot.threads.find((thread) => thread.id === sourceThreadId);
        expect(source?.planningWorkflow?.spec?.id).toBe("spec-prompt-checkout");
        expect(source?.planningWorkflow?.tickets).toHaveLength(1);
        expect(snapshot.implementationRuns).toHaveLength(1);
        expect(snapshot.implementationRuns[0]).toMatchObject({
          specId: "spec-prompt-checkout",
          baseBranch: "main",
          orchestratorBranch: "main",
          orchestratorWorktreePath: "/tmp/implementation-reactor",
          status: "running",
        });
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-worker"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("inherits a five-ticket chain and integrates only its terminal branch", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, tickets } = yield* launchRun(system, {
          tickets: [
            planningTicket("TICKET-1"),
            planningTicket("TICKET-2", ["TICKET-1"]),
            planningTicket("TICKET-3", ["TICKET-2"]),
            planningTicket("TICKET-4", ["TICKET-3"]),
            planningTicket("TICKET-5", ["TICKET-4"]),
          ],
        });
        const ticketIds = new Map(tickets.map((ticket) => [ticket.key, ticket.id] as const));
        expect(run.terminalLineageTicketIds).toEqual([ticketIds.get("TICKET-5")]);

        for (const key of ["TICKET-1", "TICKET-2", "TICKET-3", "TICKET-4"]) {
          yield* appendWorkerResult(system, {
            run,
            status: "succeeded",
            ticketId: ticketIds.get(key),
          });
          const snapshot = yield* system.query.getSnapshot();
          expect(
            snapshot.threads.filter((thread) => thread.workflowRole === "implementation-validator"),
          ).toHaveLength(0);
        }

        yield* appendWorkerResult(system, {
          run,
          status: "succeeded",
          ticketId: ticketIds.get("TICKET-5"),
        });
        const snapshot = yield* system.query.getSnapshot();
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-validator"),
        ).toHaveLength(1);

        const worktrees = yield* Ref.get(system.createWorktreeInputs);
        expect(worktrees).toHaveLength(6);
        expect(worktrees[1]?.refName).toBe(run.orchestratorBranch);
        expect(
          worktrees
            .slice(2)
            .every((worktree, index) =>
              worktree.refName.endsWith(`-ticket-${String(index + 1)}@commit`),
            ),
        ).toBe(true);

        const merges = yield* Ref.get(system.mergeRefInputs);
        expect(merges).toEqual([
          {
            cwd: run.orchestratorWorktreePath,
            refName: `${run.launchSummary.plannedWorkers[4]?.branch}@commit`,
          },
        ]);
      }),
    ),
  );

  it.effect("uses a dependency branch commit that advanced from its worker result", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, tickets } = yield* launchRun(system, {
          tickets: [planningTicket("TICKET-1"), planningTicket("TICKET-2", ["TICKET-1"])],
        });
        const base = tickets.find((ticket) => ticket.key === "TICKET-1");
        const dependent = tickets.find((ticket) => ticket.key === "TICKET-2");
        if (!base || !dependent) throw new Error("Tickets missing.");
        yield* appendWorkerResult(system, { run, status: "succeeded", ticketId: base.id });

        const afterBase = yield* system.query.getSnapshot();
        const baseBranch = afterBase.implementationRuns
          .find((entry) => entry.id === run.id)
          ?.ticketStates.find((state) => state.ticketId === base.id)?.branch;
        if (!baseBranch) throw new Error("Base branch missing.");
        yield* Ref.set(system.advancedBranchRefs, new Set([baseBranch]));
        yield* appendWorkerResult(system, {
          run,
          status: "succeeded",
          ticketId: dependent.id,
        });

        const snapshot = yield* system.query.getSnapshot();
        const completed = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(completed?.automationHalt).toBeNull();
        expect(
          completed?.ticketStates.find((state) => state.ticketId === dependent.id)?.status,
        ).toBe("succeeded");
      }),
    ),
  );

  it.effect("deletes ticket resources only after the ticket commit is integrated", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, ticket } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });

        let snapshot = yield* system.query.getSnapshot();
        let state = snapshot.implementationRuns
          .find((entry) => entry.id === run.id)
          ?.ticketStates.find((entry) => entry.ticketId === ticket.id);
        expect(state?.status).toBe("succeeded");
        expect(state?.appDevStackTierDownAt).toBeNull();
        expect(state?.resourceCleanupAt).toBeNull();
        expect(yield* Ref.get(system.deleteStackIds)).toEqual([]);
        expect(yield* Ref.get(system.removeWorktreeInputs)).toEqual([]);

        yield* passMergeGate(system, run);

        snapshot = yield* system.query.getSnapshot();
        state = snapshot.implementationRuns
          .find((entry) => entry.id === run.id)
          ?.ticketStates.find((entry) => entry.ticketId === ticket.id);
        expect(state?.resourceCleanupAt).toBe("2026-01-01T00:00:02.000Z");
        expect(yield* Ref.get(system.stopStackIds)).toEqual([]);
        expect(yield* Ref.get(system.deleteStackIds)).toEqual(["stack-ticket"]);
        expect(yield* Ref.get(system.removeWorktreeInputs)).toEqual([
          {
            cwd: run.orchestratorWorktreePath,
            path: state?.worktreePath,
          },
        ]);

        yield* system.reactor.recoverIncompleteStages();
        expect(yield* Ref.get(system.stopStackIds)).toEqual([]);
        expect(yield* Ref.get(system.deleteStackIds)).toHaveLength(1);
        expect(yield* Ref.get(system.removeWorktreeInputs)).toHaveLength(1);
      }),
    ),
  );

  it.effect("retries failed ticket worktree cleanup during recovery", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          yield* appendWorkerResult(system, { run, status: "succeeded" });
          yield* passMergeGate(system, run);

          expect(yield* Ref.get(system.deleteStackIds)).toEqual(["stack-ticket"]);
          expect(yield* Ref.get(system.removeWorktreeInputs)).toHaveLength(1);
          yield* system.reactor.recoverIncompleteStages();
          expect(yield* Ref.get(system.removeWorktreeInputs)).toHaveLength(2);
          expect(yield* Ref.get(system.stopStackIds)).toEqual([]);
        }),
      { failRemoveWorktreeAttempts: 1 },
    ),
  );

  it.effect("retains a ticket worktree until it is clean and fully merged", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const branch = run.launchSummary.plannedWorkers[0]?.branch;
          if (branch === undefined) throw new Error("Ticket branch missing.");
          yield* appendWorkerResult(system, { run, status: "succeeded" });
          yield* Ref.set(system.dirtyWorkerWorktrees, true);
          yield* passMergeGate(system, run);

          expect(yield* Ref.get(system.deleteStackIds)).toEqual(["stack-ticket"]);
          expect(yield* Ref.get(system.removeWorktreeInputs)).toEqual([]);

          yield* Ref.set(system.dirtyWorkerWorktrees, false);
          yield* Ref.set(system.advancedBranchRefs, new Set([branch]));
          yield* system.reactor.recoverIncompleteStages();
          expect(yield* Ref.get(system.removeWorktreeInputs)).toEqual([]);

          yield* Ref.set(system.advancedBranchRefs, new Set());
          yield* system.reactor.recoverIncompleteStages();
          expect(yield* Ref.get(system.removeWorktreeInputs)).toEqual([
            {
              cwd: run.orchestratorWorktreePath,
              path: run.launchSummary.plannedWorkers[0]?.worktreePath,
            },
          ]);
        }),
      { nonAncestorCommitSha: "implementation/checkout-ticket-1@advanced" },
    ),
  );

  it.effect(
    "hands fan-in conflicts and remaining dependency branches to the dependent worker",
    () =>
      withSystem(
        (system) =>
          Effect.gen(function* () {
            const { run, tickets } = yield* launchRun(system, {
              tickets: [
                planningTicket("TICKET-1"),
                planningTicket("TICKET-2"),
                planningTicket("TICKET-3"),
                planningTicket("TICKET-4", ["TICKET-1", "TICKET-2", "TICKET-3"]),
              ],
            });
            const ticketIds = new Map(tickets.map((ticket) => [ticket.key, ticket.id] as const));
            for (const key of ["TICKET-1", "TICKET-2", "TICKET-3"]) {
              yield* appendWorkerResult(system, {
                run,
                status: "succeeded",
                ticketId: ticketIds.get(key),
              });
            }

            const snapshot = yield* system.query.getSnapshot();
            const dependent = snapshot.threads.find(
              (thread) =>
                thread.workflowRole === "implementation-worker" &&
                thread.workflowContext?.ticketScope.includes(ticketIds.get("TICKET-4") ?? ""),
            );
            expect(dependent).toBeDefined();
            expect(dependent?.messages.at(-1)?.text).toContain("conflicted dependency");
            expect(dependent?.messages.at(-1)?.text).toContain("conflicted.ts");
            expect(dependent?.messages.at(-1)?.text).toContain("implementation/checkout-ticket-3");
            expect(dependent?.messages.at(-1)?.text).toContain(
              "plannedFileChanges as the expected file scope",
            );
            expect(
              snapshot.threads.filter((thread) => thread.workflowRole === "implementation-worker"),
            ).toHaveLength(4);
            expect(
              snapshot.threads.filter(
                (thread) => thread.workflowRole === "implementation-validator",
              ),
            ).toHaveLength(0);

            const merges = yield* Ref.get(system.mergeRefInputs);
            expect(merges).toEqual([
              {
                cwd: run.launchSummary.plannedWorkers[3]?.worktreePath,
                refName: `${run.launchSummary.plannedWorkers[1]?.branch}@commit`,
              },
            ]);
          }),
        { conflictMergeRefName: "implementation/checkout-ticket-2" },
      ),
  );

  it.effect("integrates only terminal branches for a fan-out graph", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, tickets } = yield* launchRun(system, {
          tickets: [
            planningTicket("TICKET-1"),
            planningTicket("TICKET-2", ["TICKET-1"]),
            planningTicket("TICKET-3", ["TICKET-1"]),
          ],
        });
        const ticketIds = new Map(tickets.map((ticket) => [ticket.key, ticket.id] as const));
        expect(run.terminalLineageTicketIds).toEqual([
          ticketIds.get("TICKET-2"),
          ticketIds.get("TICKET-3"),
        ]);

        yield* appendWorkerResult(system, {
          run,
          status: "succeeded",
          ticketId: ticketIds.get("TICKET-1"),
        });
        yield* appendWorkerResult(system, {
          run,
          status: "succeeded",
          ticketId: ticketIds.get("TICKET-2"),
        });
        yield* appendWorkerResult(system, {
          run,
          status: "succeeded",
          ticketId: ticketIds.get("TICKET-3"),
        });

        expect(yield* Ref.get(system.mergeRefInputs)).toEqual([
          {
            cwd: run.orchestratorWorktreePath,
            refName: `${run.launchSummary.plannedWorkers[1]?.branch}@commit`,
          },
          {
            cwd: run.orchestratorWorktreePath,
            refName: `${run.launchSummary.plannedWorkers[2]?.branch}@commit`,
          },
        ]);
      }),
    ),
  );

  it.effect("derives terminal lineage for legacy runs where it was not persisted", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* system.engine.dispatch({
          type: "thread.implementation-run.update",
          commandId: commandId("clear-terminal-lineage"),
          threadId: sourceThreadId,
          run: { ...run, terminalLineageTicketIds: [] },
          createdAt: now,
        });
        yield* appendWorkerResult(system, { run, status: "succeeded" });

        expect(yield* Ref.get(system.mergeRefInputs)).toEqual([
          {
            cwd: run.orchestratorWorktreePath,
            refName: `${run.launchSummary.plannedWorkers[0]?.branch}@commit`,
          },
        ]);
      }),
    ),
  );

  it.effect("records sibling results but does not integrate after a terminal ticket fails", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, tickets } = yield* launchRun(system, {
          tickets: [
            planningTicket("TICKET-1"),
            planningTicket("TICKET-2", ["TICKET-1"]),
            planningTicket("TICKET-3", ["TICKET-1"]),
            planningTicket("TICKET-4", ["TICKET-2", "TICKET-3"]),
          ],
        });
        const ticketIds = new Map(tickets.map((ticket) => [ticket.key, ticket.id] as const));
        expect(run.terminalLineageTicketIds).toEqual([ticketIds.get("TICKET-4")]);

        for (const key of ["TICKET-1", "TICKET-2", "TICKET-3"]) {
          yield* appendWorkerResult(system, {
            run,
            status: "succeeded",
            ticketId: ticketIds.get(key),
          });
        }
        yield* appendWorkerResult(system, {
          run,
          status: "failed",
          ticketId: ticketIds.get("TICKET-4"),
        });

        const merges = yield* Ref.get(system.mergeRefInputs);
        expect(merges.filter((merge) => merge.cwd === run.orchestratorWorktreePath)).toEqual([]);
        const snapshot = yield* system.query.getSnapshot();
        const halted = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(halted?.status).toBe("needs-human-attention");
        expect(halted?.workerResults).toHaveLength(4);
        expect(halted?.automationHalt).toMatchObject({
          ticketId: ticketIds.get("TICKET-4"),
          stage: "implementation",
          category: "stage-failed",
        });
      }),
    ),
  );

  it.effect("replaces a stale validator while recovering interrupted integration", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });

        let snapshot = yield* system.query.getSnapshot();
        const validatingRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        const originalValidatorThreadId = validatingRun?.activeValidatorThreadId;
        if (validatingRun === undefined || originalValidatorThreadId == null) {
          throw new Error("Validator missing.");
        }
        yield* system.engine.dispatch({
          type: "thread.delete",
          commandId: commandId("delete-original-validator"),
          threadId: originalValidatorThreadId,
        });

        const staleValidatorThreadId = ThreadId.make("thread-stale-validator");
        yield* system.engine.dispatch({
          type: "thread.create",
          commandId: commandId("create-stale-validator"),
          threadId: staleValidatorThreadId,
          projectId,
          ownerUserId: DEFAULT_WORKSPACE_USER_ID,
          parentThreadId: run.orchestratorThreadId,
          workflowRole: "implementation-validator",
          title: "Interrupted implementation merge gate",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5-codex",
          },
          runtimeMode: "full-access",
          interactionMode: "implementation-workflow",
          branch: run.orchestratorBranch,
          worktreePath: run.orchestratorWorktreePath,
          createdAt: now,
        });
        yield* system.engine.dispatch({
          type: "thread.implementation-run.update",
          commandId: commandId("interrupt-integration-with-stale-validator"),
          threadId: sourceThreadId,
          run: {
            ...validatingRun,
            status: "integrating",
            activeValidatorThreadId: staleValidatorThreadId,
          },
          createdAt: now,
        });

        yield* system.reactor.start();
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        const recovered = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(recovered?.status).toBe("validating");
        expect(recovered?.activeValidationKind).toBe("integration");
        expect(recovered?.activeValidatorThreadId).not.toBe(staleValidatorThreadId);
        expect(
          snapshot.threads.find((thread) => thread.id === staleValidatorThreadId),
        ).toMatchObject({ session: null, latestTurn: null });
        expect(
          snapshot.threads
            .find((thread) => thread.id === recovered?.activeValidatorThreadId)
            ?.messages.at(-1)?.text,
        ).toContain("integration gate before App Review and Code Review");
        expect(yield* Ref.get(system.mergeRefInputs)).toHaveLength(2);
      }),
    ),
  );

  it.effect("parks the run for a human when integration leaves a ticket out of the tree", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          yield* appendWorkerResult(system, { run, status: "succeeded" });

          // The merge reported success but the tree does not contain the
          // ticket. Left unhandled this aborts the reactor's event, which parks
          // the run in `integrating` with nothing on screen, no Retry, and no
          // sweep that re-drives it.
          const snapshot = yield* system.query.getSnapshot();
          const blocked = snapshot.implementationRuns.find((entry) => entry.id === run.id);
          expect(blocked?.status).toBe("needs-human-attention");
          expect(blocked?.retryableFailure).toMatchObject({
            stage: "integration",
            humanBlocked: true,
          });
          expect(blocked?.retryableFailure?.detail).toContain("does not contain ticket");
          expect(blocked?.integrationHeadSha).toBeNull();
          expect(
            snapshot.threads.filter((thread) => thread.workflowRole === "implementation-validator"),
          ).toHaveLength(0);
        }),
      { nonAncestorCommitSha: "implementation/checkout-ticket-1@commit" },
    ),
  );

  it.effect("leaves a stage thread resting between turns alone until it goes quiet", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        // A reviewer that finished a turn and has not started the next one is
        // `ready` with no active turn, which is indistinguishable from one that
        // stopped without reporting. Recovering on the first idle sweep put a
        // second reviewer on the ticket branch, and the two then raced: one
        // reported and froze the ticket's commit, the other kept committing.
        const { run } = yield* launchRun(system, { appReviewStrategy: "nested-workflow" });
        yield* appendWorkerResult(system, {
          run,
          status: "succeeded",
          completeTicketReview: false,
        });

        const codeReviewers = (snapshot: {
          readonly threads: ReadonlyArray<{
            readonly id: ThreadId;
            readonly workflowRole: string | null;
          }>;
        }) =>
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          );

        let snapshot = yield* system.query.getSnapshot();
        const reviewer = codeReviewers(snapshot)[0];
        if (!reviewer) throw new Error("Code reviewer missing.");
        const nowIso = DateTime.formatIso(yield* DateTime.now);
        const restReviewer = (updatedAt: string, tag: string) =>
          system.engine.dispatch({
            type: "thread.session.set",
            commandId: commandId(`reviewer-ready-${tag}`),
            threadId: reviewer.id,
            session: {
              threadId: reviewer.id,
              status: "ready",
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: null,
              lastError: null,
              updatedAt,
            },
            createdAt: nowIso,
          });

        yield* restReviewer(nowIso, "just-now");
        yield* system.reactor.drain;
        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        expect(codeReviewers(snapshot)).toHaveLength(1);

        // Quiet long enough, and the stage really is interrupted: the same
        // cycle thread receives one continuation turn.
        const longAgo = DateTime.formatIso(DateTime.subtract(yield* DateTime.now, { minutes: 11 }));
        yield* restReviewer(longAgo, "long-ago");
        yield* system.reactor.drain;
        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        expect(codeReviewers(snapshot)).toHaveLength(1);
        expect(codeReviewers(snapshot)[0]?.id).toBe(reviewer.id);
        expect(snapshot.threads.find((thread) => thread.id === reviewer.id)?.messages).toHaveLength(
          2,
        );
      }),
    ),
  );

  it.effect("hands a final programmatic merge conflict to the one validator", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          yield* appendWorkerResult(system, { run, status: "succeeded" });

          const snapshot = yield* system.query.getSnapshot();
          const validators = snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-validator",
          );
          expect(validators).toHaveLength(1);
          expect(validators[0]?.messages.at(-1)?.text).toContain("conflicted.ts");
          expect(validators[0]?.messages.at(-1)?.text).toContain(
            "Programmatic integration stopped",
          );
          expect(validators[0]?.messages.at(-1)?.text).toContain(
            "Matt Pocock Resolving Merge Conflicts skill",
          );
          expect(validators[0]?.messages.at(-1)?.text).toContain(
            "integration gate before App Review and Code Review",
          );
          expect(snapshot.implementationRuns[0]?.activeValidationKind).toBe("integration");

          yield* appendWorkerResult(system, {
            run,
            status: "succeeded",
            tag: "duplicate",
          });
          const afterDuplicate = yield* system.query.getSnapshot();
          expect(
            afterDuplicate.threads.filter(
              (thread) => thread.workflowRole === "implementation-validator",
            ),
          ).toHaveLength(1);
          expect(yield* Ref.get(system.mergeRefInputs)).toHaveLength(1);
        }),
      { conflictMergeRefName: "implementation/checkout-ticket-1" },
    ),
  );

  it.effect("blocks a dependent ticket when its successful branch moved", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run, tickets } = yield* launchRun(system, {
            tickets: [planningTicket("TICKET-1"), planningTicket("TICKET-2", ["TICKET-1"])],
          });
          yield* appendWorkerResult(system, {
            run,
            status: "succeeded",
            ticketId: tickets[0]?.id,
          });

          const snapshot = yield* system.query.getSnapshot();
          const updated = snapshot.implementationRuns.find((candidate) => candidate.id === run.id);
          expect(updated?.status).toBe("needs-human-attention");
          expect(updated?.ticketStates[1]?.status).toBe("blocked");
          expect(
            snapshot.threads.filter((thread) => thread.workflowRole === "implementation-worker"),
          ).toHaveLength(1);
        }),
      { resolvedCommitSha: "moved-commit" },
    ),
  );

  it.effect("sends final integration failures directly to a fixer with the Git error", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          yield* appendWorkerResult(system, { run, status: "succeeded" });

          const snapshot = yield* system.query.getSnapshot();
          expect(
            snapshot.implementationRuns.find((candidate) => candidate.id === run.id)?.status,
          ).toBe("fixing");
          expect(
            snapshot.threads.filter((thread) => thread.workflowRole === "implementation-validator"),
          ).toHaveLength(0);
          const fixer = snapshot.threads.find(
            (thread) => thread.workflowRole === "implementation-fixer",
          );
          expect(
            snapshot.threads.filter((thread) => thread.workflowRole === "implementation-fixer"),
          ).toHaveLength(1);
          expect(fixer?.messages[0]?.text).toContain("Ticket integration failed:");
          expect(fixer?.messages[0]?.text).toContain("merge failed");
          expect(
            snapshot.threads
              .find((thread) => thread.id === run.orchestratorThreadId)
              ?.activities.some(
                (activity) => activity.kind === "implementation-integration-warning",
              ),
          ).toBe(true);
        }),
      { failMergeRefName: "implementation/checkout-ticket-1" },
    ),
  );

  it.effect("halts when worker worktree creation fails", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const snapshot = yield* system.query.getSnapshot();
          const workerThread = snapshot.threads.find(
            (thread) => thread.workflowRole === "implementation-worker",
          );

          expect(run.status).toBe("needs-human-attention");
          expect(run.automationHalt).toMatchObject({ category: "structural-invariant" });
          expect(workerThread).toBeUndefined();
          expect(
            snapshot.threads.filter((thread) => thread.workflowRole === "implementation-validator"),
          ).toHaveLength(0);
        }),
      { failCreateWorktreeAfter: 1 },
    ),
  );

  it.effect("restarts an interrupted worker with its dirty ticket worktree", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          yield* appendWorkerResult(system, {
            run,
            status: "failed",
            notesMarkdown: WORKFLOW_INTERRUPTION_ERROR_MESSAGE,
          });

          const snapshot = yield* system.query.getSnapshot();
          const restarted = snapshot.implementationRuns.find((entry) => entry.id === run.id);
          const workers = snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-worker",
          );
          expect(restarted?.status).toBe("running");
          expect(restarted?.automationHalt).toBeNull();
          expect(restarted?.ticketStates[0]?.status).toBe("running");
          expect(workers).toHaveLength(1);
          expect(workers[0]?.messages.at(-1)?.text).toContain(
            "This ticket worktree contains tracked or untracked changes from an earlier turn.",
          );
          expect(workers[0]?.messages.at(-1)?.text).toContain(
            "Keep the useful parts, and rewrite or delete anything that does not meet the ticket.",
          );
          expect(workers[0]?.messages.at(-1)?.text).toContain(
            "Commit the completed ticket work on the assigned branch and leave the worktree clean.",
          );
        }),
      { dirtyWorkerWorktrees: true },
    ),
  );

  it.effect("halts after repeated server interruptions exhaust the launch budget", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, {
          run,
          status: "failed",
          notesMarkdown: WORKFLOW_INTERRUPTION_ERROR_MESSAGE,
          tag: "first",
        });

        const continuedSnapshot = yield* system.query.getSnapshot();
        const continued = continuedSnapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(continued?.status).toBe("running");
        expect(continued?.automationHalt).toBeNull();
        expect(continued?.retryableFailure?.attemptCount).toBe(1);
        expect(continued?.ticketStates[0]?.status).toBe("running");
        expect(continued?.ticketStates[0]?.attemptCount).toBe(2);

        yield* appendWorkerResult(system, {
          run,
          status: "failed",
          notesMarkdown: WORKFLOW_INTERRUPTION_ERROR_MESSAGE,
          tag: "second",
        });

        const haltedSnapshot = yield* system.query.getSnapshot();
        const halted = haltedSnapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(halted?.status).toBe("needs-human-attention");
        expect(halted?.retryableFailure?.attemptCount).toBe(2);
        expect(halted?.automationHalt).toMatchObject({
          stage: "implementation",
          category: "retry-exhausted",
        });
        expect(
          haltedSnapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-worker",
          ),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("stops recovery when the durable Implementation thread is gone", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        const initialState = run.ticketStates[0];
        if (initialState?.workerThreadId === null || initialState?.workerThreadId === undefined) {
          throw new Error("Implementation worker missing.");
        }
        yield* system.engine.dispatch({
          type: "thread.delete",
          commandId: commandId("delete-durable-implementation-worker"),
          threadId: initialState.workerThreadId,
        });
        yield* system.reactor.drain;

        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const recovered = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(recovered?.status).toBe("needs-human-attention");
        expect(recovered?.automationHalt).toMatchObject({
          ticketId: initialState.ticketId,
          stage: "implementation",
          category: "structural-invariant",
        });
        expect(recovered?.retryableFailure).toMatchObject({
          ticketId: initialState.ticketId,
          stage: "worker-setup",
          humanBlocked: true,
        });
        expect(recovered?.ticketStates[0]?.status).toBe("failed");
        expect(recovered?.ticketStates[0]?.attemptCount).toBe(2);
        expect(recovered?.ticketStates[0]?.implementationGeneration).toBe(
          initialState.implementationGeneration,
        );
        expect(recovered?.retryableFailure?.detail).toContain("durable Implementation thread");
      }),
    ),
  );

  it.effect("replays a completed worker result after clearing a legacy dirty-worktree halt", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        const ticketId = run.ticketStates[0]?.ticketId;
        if (!ticketId) throw new Error("Ticket missing.");
        const haltedRun: OrchestrationImplementationRun = {
          ...run,
          status: "needs-human-attention",
          automationHalt: {
            ticketId,
            stage: "implementation",
            category: "structural-invariant",
            detail:
              "Git command failed: Existing worker worktree on 'checkout-ticket-1' is dirty before implementation launch.",
            haltedAt: "2026-01-01T00:00:00.500Z",
          },
          updatedAt: "2026-01-01T00:00:00.500Z",
        };
        yield* system.engine.dispatch({
          type: "thread.implementation-run.update",
          commandId: commandId("legacy-dirty-worker-halt"),
          threadId: sourceThreadId,
          run: haltedRun,
          createdAt: "2026-01-01T00:00:00.500Z",
        });
        yield* system.reactor.drain;
        yield* appendWorkerResult(system, { run: haltedRun, status: "succeeded" });

        let snapshot = yield* system.query.getSnapshot();
        const recorded = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(recorded?.automationHalt).not.toBeNull();
        expect(recorded?.ticketStates[0]?.status).toBe("running");
        expect(recorded?.ticketStates[0]?.workerResult?.status).toBe("succeeded");
        expect(recorded?.ticketStates[0]?.warningMarkdown).toBe(
          "Implementation result recorded after automation halted.",
        );

        const workersBeforeRecovery = snapshot.threads.filter(
          (thread) => thread.workflowRole === "implementation-worker",
        );
        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        const recovered = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(recovered?.automationHalt).toBeNull();
        expect(recovered?.ticketStates[0]?.status).toBe("succeeded");
        expect(recovered?.ticketStates[0]?.warningMarkdown).toBeNull();
        expect(recovered?.workerResults).toHaveLength(1);
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-worker"),
        ).toHaveLength(workersBeforeRecovery.length);
      }),
    ),
  );

  it.effect("settles dependents of a failed ticket while another ticket owns the halt", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, tickets } = yield* launchRun(system, {
          tickets: [
            {
              key: "TICKET-1",
              title: "Failed base",
              bodyMarkdown: "Base work.",
              plannedFileChanges: [{ path: "src/base.ts", action: "create" }],
              dependencyKeys: [],
            },
            {
              key: "TICKET-2",
              title: "Blocked dependent",
              bodyMarkdown: "Dependent work.",
              plannedFileChanges: [{ path: "src/dependent.ts", action: "create" }],
              dependencyKeys: ["TICKET-1"],
            },
            {
              key: "TICKET-3",
              title: "Current review",
              bodyMarkdown: "Independent work.",
              plannedFileChanges: [{ path: "src/review.ts", action: "create" }],
              dependencyKeys: [],
            },
          ],
        });
        const failed = tickets.find((ticket) => ticket.key === "TICKET-1")!;
        const dependent = tickets.find((ticket) => ticket.key === "TICKET-2")!;
        const reviewing = tickets.find((ticket) => ticket.key === "TICKET-3")!;
        const snapshot = yield* system.query.getSnapshot();
        const current = snapshot.implementationRuns.find((entry) => entry.id === run.id)!;
        const haltedAt = "2026-01-01T00:05:00.000Z";
        yield* system.engine.dispatch({
          type: "thread.implementation-run.update",
          commandId: commandId("halt-with-stranded-dependent"),
          threadId: sourceThreadId,
          run: {
            ...current,
            status: "needs-human-attention",
            automationHalt: {
              ticketId: reviewing.id,
              stage: "app-review",
              category: "review-blocked",
              detail: "The independent ticket App Review failed.",
              haltedAt,
            },
            ticketStates: current.ticketStates.map((state) =>
              state.ticketId === failed.id
                ? {
                    ...state,
                    status: "failed" as const,
                    warningMarkdown: "The worker stopped.",
                    updatedAt: haltedAt,
                  }
                : state.ticketId === dependent.id
                  ? { ...state, status: "blocked" as const, updatedAt: haltedAt }
                  : state,
            ),
            updatedAt: haltedAt,
          },
          createdAt: haltedAt,
        });
        yield* system.reactor.drain;

        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.drain;

        const recovered = (yield* system.query.getSnapshot()).implementationRuns.find(
          (entry) => entry.id === run.id,
        )!;
        expect(recovered.status).toBe("needs-human-attention");
        expect(recovered.automationHalt?.ticketId).toBe(reviewing.id);
        expect(
          recovered.ticketStates.find((state) => state.ticketId === dependent.id),
        ).toMatchObject({
          status: "failed",
          warningMarkdown: `Blocked by failed dependency: '${failed.id}'.`,
        });
      }),
    ),
  );

  it.effect("keeps a dirty ticket App Review halted", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system, { appReviewStrategy: "nested-workflow" });
        yield* appendWorkerResult(system, {
          run,
          status: "succeeded",
          completeTicketReview: false,
        });
        const beforeHalt = yield* system.query.getSnapshot();
        const current = beforeHalt.implementationRuns.find((entry) => entry.id === run.id);
        if (!current) throw new Error("Implementation run missing.");
        const ticketId = current.ticketStates[0]?.ticketId;
        if (!ticketId) throw new Error("Ticket missing.");
        yield* system.engine.dispatch({
          type: "thread.implementation-run.update",
          commandId: commandId("persist-dirty-app-review-halt"),
          threadId: sourceThreadId,
          run: {
            ...current,
            status: "needs-human-attention",
            automationHalt: {
              ticketId,
              stage: "app-review",
              category: "structural-invariant",
              detail:
                "Embedded App Review requires clean expected branch 'checkout-ticket-1', but Git reports 'checkout-ticket-1' with uncommitted changes.",
              haltedAt: "2026-01-01T00:00:02.000Z",
            },
            updatedAt: "2026-01-01T00:00:02.000Z",
          },
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        yield* system.reactor.drain;
        yield* Ref.set(system.dirtyWorkerWorktrees, true);

        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const recovered = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(recovered?.automationHalt).toMatchObject({
          ticketId,
          stage: "app-review",
          category: "structural-invariant",
        });
        expect(recovered?.status).toBe("needs-human-attention");
        expect(recovered?.ticketStates[0]?.status).toBe("code-reviewing");
        const workers = snapshot.threads.filter(
          (thread) => thread.workflowRole === "implementation-worker",
        );
        expect(workers).toHaveLength(1);
        expect(workers[0]?.messages).toHaveLength(1);
      }),
    ),
  );

  it.effect("rejects launch-budget state that clears durable thread identities", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system, {
          tickets: [planningTicket("TICKET-1"), planningTicket("TICKET-2")],
        });
        const before = (yield* system.query.getSnapshot()).implementationRuns.find(
          (entry) => entry.id === run.id,
        );
        if (before === undefined) throw new Error("Implementation run missing.");
        const ticketId = before.ticketStates[0]?.ticketId;
        if (!ticketId) throw new Error("Ticket missing.");
        const invalidUpdate = yield* system.engine
          .dispatch({
            type: "thread.implementation-run.update",
            commandId: commandId("persist-recovery-launch-budget-fallout"),
            threadId: sourceThreadId,
            run: {
              ...before,
              status: "needs-human-attention",
              automationHalt: {
                ticketId,
                stage: "implementation",
                category: "retry-exhausted",
                detail: `Ticket '${ticketId}' exhausted its implementation launch budget.`,
                haltedAt: "2026-01-01T00:00:02.000Z",
              },
              ticketStates: before.ticketStates.map((state) => ({
                ...state,
                status: "ready" as const,
                workerThreadId: null,
                attemptCount: IMPLEMENTATION_STAGE_MAX_LAUNCHES,
              })),
              updatedAt: "2026-01-01T00:00:02.000Z",
            },
            createdAt: "2026-01-01T00:00:02.000Z",
          })
          .pipe(Effect.result);
        expect(invalidUpdate._tag).toBe("Failure");
        yield* system.reactor.drain;

        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const recovered = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(recovered?.automationHalt).toBeNull();
        expect(recovered?.status).toBe("running");
        expect(recovered?.ticketStates.every((state) => state.status === "running")).toBe(true);
        expect(recovered?.ticketStates.every((state) => state.attemptCount === 1)).toBe(true);
        expect(
          recovered?.ticketStates.every(
            (state, index) => state.workerThreadId === before.ticketStates[index]?.workerThreadId,
          ),
        ).toBe(true);
        expect(
          recovered?.ticketStates.every(
            (state, index) =>
              state.implementationGeneration ===
              (before.ticketStates[index]?.implementationGeneration ?? 0),
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("continues persisted ticket App Review launch-budget fallout in Code Review", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, ticket, nestedRun } = yield* launchTicketAppReview(system);
        const current = (yield* system.query.getSnapshot()).implementationRuns.find(
          (entry) => entry.id === run.id,
        );
        if (current === undefined) throw new Error("Implementation run missing.");
        const haltedRun: OrchestrationImplementationRun = {
          ...current,
          status: "needs-human-attention",
          automationHalt: {
            ticketId: ticket.id,
            stage: "app-review",
            category: "retry-exhausted",
            detail: `Ticket '${ticket.id}' exhausted its App Review launch budget.`,
            haltedAt: "2026-01-01T00:05:00.000Z",
          },
          ticketStates: current.ticketStates.map((state) =>
            state.ticketId === ticket.id
              ? {
                  ...state,
                  appReviewWorkflowRunId: null,
                  appReviewLaunchCount: IMPLEMENTATION_STAGE_MAX_LAUNCHES,
                }
              : state,
          ),
          updatedAt: "2026-01-01T00:05:00.000Z",
        };
        yield* system.engine.dispatch({
          type: "thread.implementation-run.update",
          commandId: commandId("persist-ticket-app-review-launch-budget-fallout"),
          threadId: sourceThreadId,
          run: haltedRun,
          createdAt: "2026-01-01T00:05:00.000Z",
        });
        yield* system.reactor.drain;

        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const recovered = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        const state = recovered?.ticketStates.find((entry) => entry.ticketId === ticket.id);
        expect(recovered?.status).toBe("running");
        expect(recovered?.automationHalt).toBeNull();
        expect(state?.status).toBe("code-reviewing");
        expect(state?.warningMarkdown).toContain("exhausting its 2-launch budget");
        expect(
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          ),
        ).toHaveLength(1);
        expect(
          (snapshot.appReviewWorkflowRuns ?? []).find((entry) => entry.id === nestedRun.id)?.status,
        ).toBe("failed");
      }),
    ),
  );

  it.effect("continues worker success in the same dirty ticket worktree", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          yield* appendWorkerResult(system, { run, status: "succeeded" });

          const snapshot = yield* system.query.getSnapshot();
          const continued = snapshot.implementationRuns.find((entry) => entry.id === run.id);
          expect(continued?.status).toBe("running");
          expect(continued?.automationHalt).toBeNull();
          expect(continued?.ticketStates[0]?.status).toBe("running");
          const workers = snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-worker",
          );
          expect(workers).toHaveLength(1);
          expect(
            workers.some((worker) =>
              worker.messages
                .at(-1)
                ?.text.includes("contains tracked or untracked changes from an earlier turn"),
            ),
          ).toBe(true);
        }),
      { dirtyWorkerWorktrees: true },
    ),
  );

  it.effect("halts without integration when a worker returns a valid failure", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "failed" });

        const snapshot = yield* system.query.getSnapshot();
        const updated = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(updated?.status).toBe("needs-human-attention");
        expect(updated?.ticketStates[0]?.status).toBe("failed");
        expect(updated?.integrationHeadSha).toBeNull();
        expect(updated?.automationHalt).toMatchObject({ category: "stage-failed" });
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-validator"),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("stops ticket Code Review after the first clean cycle", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system, { appReviewStrategy: "nested-workflow" });
        yield* appendWorkerResult(system, {
          run,
          status: "succeeded",
          completeTicketReview: false,
        });

        let snapshot = yield* system.query.getSnapshot();
        const reviewing = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(reviewing?.ticketStates[0]).toMatchObject({
          status: "code-reviewing",
          appReviewOutcome: "skipped",
          codeReviewOutcome: null,
        });
        expect(
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          ),
        ).toHaveLength(1);
        expect(
          snapshot.threads.find(
            (thread) => thread.id === reviewing?.ticketStates[0]?.codeReviewThreadId,
          )?.workflowContext?.ticketScope,
        ).toEqual([reviewing?.ticketStates[0]?.ticketId]);
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-validator"),
        ).toHaveLength(0);

        const reviewerThreadId = reviewing?.ticketStates[0]?.codeReviewThreadId;
        const reviewedTicketId = reviewing?.ticketStates[0]?.ticketId;
        if (!reviewerThreadId) throw new Error("Ticket Code Review missing.");
        if (!reviewedTicketId) throw new Error("Reviewed ticket missing.");
        yield* system.engine.dispatch({
          type: "thread.activity.append",
          commandId: commandId("ticket-code-review-once"),
          threadId: reviewerThreadId,
          activity: {
            id: eventId("ticket-code-review-once"),
            tone: "info",
            kind: "implementation-code-review-result",
            summary: "Ticket code review clean",
            payload: {
              type: "implementation-code-review-result",
              runId: run.id,
              ticketId: reviewedTicketId,
              status: "clean",
              validations: requiredValidations("2026-01-01T00:00:01.500Z"),
              reportMarkdown: "## Standards\n- clean\n\n## Spec\n- clean",
            },
            turnId: null,
            createdAt: "2026-01-01T00:00:01.500Z",
          },
          createdAt: "2026-01-01T00:00:01.500Z",
        });
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        const reviewed = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(reviewed?.ticketStates[0]).toMatchObject({
          status: "succeeded",
          codeReviewOutcome: "clean",
        });
        expect(
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          ),
        ).toHaveLength(1);
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-validator"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("uses a fresh ticket Code Review thread after findings", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system, { appReviewStrategy: "nested-workflow" });
        yield* appendWorkerResult(system, {
          run,
          status: "succeeded",
          completeTicketReview: false,
        });

        let snapshot = yield* system.query.getSnapshot();
        let current = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        const ticketId = current?.ticketStates[0]?.ticketId;
        const firstReviewerId = current?.ticketStates[0]?.codeReviewThreadId;
        if (ticketId === undefined || firstReviewerId === null || firstReviewerId === undefined) {
          throw new Error("Ticket Code Review missing.");
        }
        yield* appendCodeReviewResult(system, {
          run,
          threadId: firstReviewerId,
          ticketId,
          status: "findings",
          tag: "ticket-findings-cycle-one",
        });

        snapshot = yield* system.query.getSnapshot();
        current = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        const secondReviewerId = current?.ticketStates[0]?.codeReviewThreadId;
        expect(secondReviewerId).not.toBe(firstReviewerId);
        expect(current?.ticketStates[0]?.codeReviewPassCount).toBe(1);
        expect(current?.ticketStates[0]?.codeReviewGeneration).toBe(1);
        expect(
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          ),
        ).toHaveLength(2);
      }),
    ),
  );

  it.effect("retries an interrupted ticket Code Review once and then halts", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system, { appReviewStrategy: "nested-workflow" });
        yield* appendWorkerResult(system, {
          run,
          status: "succeeded",
          completeTicketReview: false,
        });

        let snapshot = yield* system.query.getSnapshot();
        let current = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        const ticketId = current?.ticketStates[0]?.ticketId;
        const firstReviewerId = current?.ticketStates[0]?.codeReviewThreadId;
        if (ticketId === undefined || firstReviewerId === null || firstReviewerId === undefined) {
          throw new Error("Ticket Code Review missing.");
        }
        yield* appendCodeReviewResult(system, {
          run,
          threadId: firstReviewerId,
          ticketId,
          status: "blocked",
          reportMarkdown: WORKFLOW_INTERRUPTION_ERROR_MESSAGE,
          tag: "ticket-interrupted-once",
        });

        snapshot = yield* system.query.getSnapshot();
        current = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        const secondReviewerId = current?.ticketStates[0]?.codeReviewThreadId;
        expect(secondReviewerId).toBe(firstReviewerId);
        expect(current?.ticketStates[0]?.codeReviewLaunchCount).toBe(2);
        expect(current?.retryableFailure).toMatchObject({
          ticketId,
          stage: "code-review",
          attemptCount: 1,
        });
        expect(current?.automationHalt).toBeNull();
        if (secondReviewerId === null || secondReviewerId === undefined) {
          throw new Error("Ticket Code Review retry missing.");
        }

        yield* appendCodeReviewResult(system, {
          run,
          threadId: secondReviewerId,
          ticketId,
          status: "blocked",
          reportMarkdown: WORKFLOW_INTERRUPTION_ERROR_MESSAGE,
          tag: "ticket-interrupted-twice",
        });

        snapshot = yield* system.query.getSnapshot();
        current = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(current?.status).toBe("needs-human-attention");
        expect(current?.automationHalt).toMatchObject({
          ticketId,
          stage: "code-review",
          category: "retry-exhausted",
        });
        expect(
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          ),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("waits for a stage thread whose session has not reported yet", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        // The leak this closes: recovery read "no live session" as "this stage
        // was interrupted", which is also what a thread looks like in the gap
        // between being created and its provider session coming up. On a loaded
        // machine that gap outlasts the sweep, and every pass started another
        // thread for the same ticket and orphaned the last.
        const { run } = yield* launchRun(system, { appReviewStrategy: "nested-workflow" });
        yield* appendWorkerResult(system, {
          run,
          status: "succeeded",
          completeTicketReview: false,
        });

        const codeReviewers = (snapshot: {
          readonly threads: ReadonlyArray<{
            readonly id: ThreadId;
            readonly workflowRole: string | null;
            readonly session: { readonly status: string } | null;
            readonly latestTurn: { readonly state: string } | null;
          }>;
        }) =>
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          );

        let snapshot = yield* system.query.getSnapshot();
        const reviewer = codeReviewers(snapshot)[0];
        if (!reviewer) throw new Error("Code reviewer missing.");
        // Created, its turn requested, and nothing has come back from the
        // provider yet. On a loaded machine this state lasts minutes.
        expect(reviewer.session).toBe(null);
        expect(reviewer.latestTurn).toBe(null);

        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        expect(codeReviewers(snapshot)).toHaveLength(1);

        // Once the turn is over and the session is idle, the stage is genuinely
        // interrupted and recovery appends one continuation to the same thread.
        const endedAt = DateTime.formatIso(yield* DateTime.now);
        yield* system.engine.dispatch({
          type: "thread.session.set",
          commandId: commandId("reviewer-session-stopped"),
          threadId: reviewer.id,
          session: {
            threadId: reviewer.id,
            status: "stopped",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: endedAt,
          },
          createdAt: endedAt,
        });
        yield* system.reactor.drain;
        yield* Effect.all(
          [system.reactor.recoverIncompleteStages(), system.reactor.recoverIncompleteStages()],
          { concurrency: "unbounded", discard: true },
        );
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        expect(codeReviewers(snapshot)).toHaveLength(1);
        expect(codeReviewers(snapshot)[0]?.id).toBe(reviewer.id);
        expect(snapshot.threads.find((thread) => thread.id === reviewer.id)?.messages).toHaveLength(
          2,
        );
      }),
    ),
  );

  it.effect("waits for a nudge instead of relaunching a stage whose turn failed", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system, { appReviewStrategy: "nested-workflow" });
        yield* appendWorkerResult(system, {
          run,
          status: "succeeded",
          completeTicketReview: false,
        });

        const codeReviewers = (snapshot: {
          readonly threads: ReadonlyArray<{
            readonly id: ThreadId;
            readonly workflowRole: string | null;
          }>;
        }) =>
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          );

        let snapshot = yield* system.query.getSnapshot();
        const reviewer = codeReviewers(snapshot)[0];
        if (!reviewer) throw new Error("Code reviewer missing.");

        // A provider failure — an API error, a usage limit — fails the turn and
        // then takes the session down with it.
        const blockedAt = DateTime.formatIso(yield* DateTime.now);
        const setReviewerSession = (input: {
          readonly tag: string;
          readonly status: "running" | "error" | "stopped";
          readonly activeTurnId: TurnId | null;
          readonly lastError: string | null;
        }) =>
          system.engine.dispatch({
            type: "thread.session.set",
            commandId: commandId(input.tag),
            threadId: reviewer.id,
            session: {
              threadId: reviewer.id,
              status: input.status,
              providerName: "codex",
              runtimeMode: "full-access",
              activeTurnId: input.activeTurnId,
              lastError: input.lastError,
              updatedAt: blockedAt,
            },
            createdAt: blockedAt,
          });

        yield* setReviewerSession({
          tag: "nudge-reviewer-running",
          status: "running",
          activeTurnId: TurnId.make("turn-nudge-reviewer"),
          lastError: null,
        });
        yield* setReviewerSession({
          tag: "nudge-reviewer-failed",
          status: "error",
          activeTurnId: null,
          lastError: "Claude AI usage limit reached",
        });
        yield* setReviewerSession({
          tag: "nudge-reviewer-stopped",
          status: "stopped",
          activeTurnId: null,
          lastError: "Claude AI usage limit reached",
        });
        yield* system.reactor.drain;

        // Relaunching here would throw away the reviewer's context and, for as
        // long as the limit holds, leave one dead thread per sweep behind.
        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.drain;
        snapshot = yield* system.query.getSnapshot();
        expect(codeReviewers(snapshot)).toHaveLength(1);

        // Nudging gives up and hands the thread back by marking its session.
        yield* setReviewerSession({
          tag: "nudge-reviewer-exhausted",
          status: "error",
          activeTurnId: null,
          lastError: WORKFLOW_NUDGE_EXHAUSTED_MESSAGE,
        });
        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        expect(codeReviewers(snapshot)).toHaveLength(1);
        expect(codeReviewers(snapshot)[0]?.id).toBe(reviewer.id);
        expect(snapshot.threads.find((thread) => thread.id === reviewer.id)?.messages).toHaveLength(
          2,
        );
      }),
    ),
  );

  it.effect("leaves a paused run's stage alone and re-enters it on resume", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system, { appReviewStrategy: "nested-workflow" });
        yield* appendWorkerResult(system, {
          run,
          status: "succeeded",
          completeTicketReview: false,
        });

        const codeReviewers = (snapshot: {
          readonly threads: ReadonlyArray<{
            readonly id: ThreadId;
            readonly workflowRole: string | null;
          }>;
        }) =>
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          );

        let snapshot = yield* system.query.getSnapshot();
        expect(codeReviewers(snapshot)).toHaveLength(1);

        yield* system.engine.dispatch({
          type: "thread.workflow.pause",
          commandId: commandId("pause-run"),
          threadId: sourceThreadId,
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        yield* system.reactor.drain;

        // The reviewer has no live session, so the sweep would normally re-enter
        // the stage. While the run is paused it must not: the turn would fail on
        // the paused-ancestor invariant and leave the created thread orphaned.
        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.drain;
        snapshot = yield* system.query.getSnapshot();
        expect(codeReviewers(snapshot)).toHaveLength(1);

        // Stopping the reviewer is what the pause asked the provider for, and
        // it is what tells recovery the stage is free to start again. Without
        // it the reviewer still counts as work in flight, which is the whole
        // point of the sweep leaving unreported threads alone.
        const reviewer = codeReviewers(snapshot)[0];
        if (!reviewer) throw new Error("Code reviewer missing.");
        yield* system.engine.dispatch({
          type: "thread.session.set",
          commandId: commandId("paused-reviewer-stopped"),
          threadId: reviewer.id,
          session: {
            threadId: reviewer.id,
            status: "stopped",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:00:02.500Z",
          },
          createdAt: "2026-01-01T00:00:02.500Z",
        });
        yield* system.reactor.drain;

        yield* system.engine.dispatch({
          type: "thread.workflow.resume",
          commandId: commandId("resume-run"),
          threadId: sourceThreadId,
          createdAt: "2026-01-01T00:00:03.000Z",
        });
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        expect(codeReviewers(snapshot)).toHaveLength(1);
        expect(codeReviewers(snapshot)[0]?.id).toBe(reviewer.id);
        expect(snapshot.threads.find((thread) => thread.id === reviewer.id)?.messages).toHaveLength(
          2,
        );
        expect(
          snapshot.implementationRuns.find((entry) => entry.id === run.id)?.ticketStates[0]?.status,
        ).toBe("code-reviewing");
      }),
    ),
  );

  it.effect("starts the bounded combined App Review directly after the merge gate", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system, { appReviewStrategy: "nested-workflow" });
        yield* appendWorkerResult(system, { run, status: "succeeded" });

        let snapshot = yield* system.query.getSnapshot();
        const validator = snapshot.threads.find(
          (thread) =>
            thread.workflowRole === "implementation-validator" &&
            thread.title === "Implementation merge gate",
        );
        if (!validator) throw new Error("Merge gate missing.");
        yield* system.engine.dispatch({
          type: "thread.activity.append",
          commandId: commandId("nested-merge-gate-pass"),
          threadId: validator.id,
          activity: {
            id: eventId("nested-merge-gate-pass"),
            tone: "info",
            kind: "implementation-merge-gate-result",
            summary: "Merge gate passed",
            payload: {
              type: "implementation-merge-gate-result",
              runId: run.id,
              status: "passed",
              validations: requiredValidations(),
              summaryMarkdown: "ok",
            },
            turnId: null,
            createdAt: "2026-01-01T00:00:02.000Z",
          },
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        const combinedReview = snapshot.appReviewWorkflowRuns?.find(
          (candidate) =>
            candidate.caller.type === "implementation" &&
            candidate.caller.implementationRunId === run.id &&
            candidate.caller.ticketId === undefined,
        );
        expect(combinedReview?.cycleBudget).toBe(10);
        expect(
          snapshot.threads.filter(
            (thread) =>
              thread.workflowRole === "implementation-code-reviewer" &&
              thread.workflowContext?.ticketScope.length !== 1,
          ),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("gives the run's own App Review the cycles its step budget asks for", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system, { appReviewStrategy: "nested-workflow" });
          yield* appendWorkerResult(system, { run, status: "succeeded" });

          let snapshot = yield* system.query.getSnapshot();
          const validator = snapshot.threads.find(
            (thread) =>
              thread.workflowRole === "implementation-validator" &&
              thread.title === "Implementation merge gate",
          );
          if (!validator) throw new Error("Merge gate missing.");
          yield* system.engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId("budgeted-merge-gate-pass"),
            threadId: validator.id,
            activity: {
              id: eventId("budgeted-merge-gate-pass"),
              tone: "info",
              kind: "implementation-merge-gate-result",
              summary: "Merge gate passed",
              payload: {
                type: "implementation-merge-gate-result",
                runId: run.id,
                status: "passed",
                validations: requiredValidations(),
                summaryMarkdown: "ok",
              },
              turnId: null,
              createdAt: "2026-01-01T00:00:02.000Z",
            },
            createdAt: "2026-01-01T00:00:02.000Z",
          });
          yield* system.reactor.drain;

          snapshot = yield* system.query.getSnapshot();
          const review = snapshot.appReviewWorkflowRuns?.find(
            (candidate) =>
              candidate.caller.type === "implementation" &&
              candidate.caller.implementationRunId === run.id &&
              candidate.caller.ticketId === undefined,
          );
          expect(review?.cycleBudget).toBe(10);
        }),
      {
        serverSettings: {
          workflowStepCycles: [
            {
              workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
              maxCycles: 25,
            },
          ],
        },
      },
    ),
  );

  it.effect("runs merge gate, browser review, files a PR, and completes after worker success", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        let snapshot = yield* system.query.getSnapshot();
        const validator = snapshot.threads.find(
          (thread) => thread.workflowRole === "implementation-validator",
        );
        expect(validator).toBeDefined();
        expect(validator?.messages.at(-1)?.text).toContain(
          "its workflow-owned AppDevStack was created during workspace bootstrap and is reused here",
        );
        expect(validator?.messages.at(-1)?.text).toContain(
          "integration gate before App Review and Code Review",
        );

        yield* system.engine.dispatch({
          type: "thread.activity.append",
          commandId: commandId("merge-gate-pass"),
          threadId: validator!.id,
          activity: {
            id: eventId("merge-gate-pass"),
            tone: "info",
            kind: "implementation-merge-gate-result",
            summary: "Merge gate passed",
            payload: {
              type: "implementation-merge-gate-result",
              runId: run.id,
              status: "passed",
              validations: requiredValidations(),
              summaryMarkdown: "ok",
            },
            turnId: null,
            createdAt: "2026-01-01T00:00:02.000Z",
          },
          createdAt: "2026-01-01T00:00:02.000Z",
        });
        yield* system.reactor.drain;
        snapshot = yield* system.query.getSnapshot();
        const reviewingRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        const autoCreateInputs = yield* Ref.get(system.autoCreateInputs);
        expect(autoCreateInputs).toHaveLength(1);
        expect(reviewingRun?.status).toBe("qa-reviewing");
        expect(reviewingRun?.appReviewIds).toHaveLength(1);
        const reviewThread = snapshot.threads.find(
          (thread) => thread.workflowRole === "implementation-qa-reviewer",
        );
        expect(reviewThread?.messages.at(-1)?.text).toContain("Feature URL: http://127.0.0.1:5173");

        yield* system.engine.dispatch({
          type: "thread.app-review.update",
          commandId: commandId("app-review-pass"),
          threadId: run.orchestratorThreadId,
          reviewId: AppReviewId.make(reviewingRun!.appReviewIds[0]!),
          status: "passed",
          updatedAt: "2026-01-01T00:00:03.000Z",
          createdAt: "2026-01-01T00:00:03.000Z",
        });
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        const codeReviewingRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        const createOrOpenChangeRequestCount = yield* Ref.get(
          system.createOrOpenChangeRequestCount,
        );
        expect(createOrOpenChangeRequestCount).toBe(0);
        expect(codeReviewingRun?.status).toBe("code-reviewing");
        expect(codeReviewingRun?.codeReviewAttemptCount).toBe(1);
        expect(codeReviewingRun?.changeRequest).toBeNull();

        const reviewerThread = snapshot.threads.find(
          (thread) => thread.workflowRole === "implementation-code-reviewer",
        );
        expect(reviewerThread).toBeDefined();
        expect(reviewerThread?.parentThreadId).toBe(run.orchestratorThreadId);
        expect(reviewerThread?.messages.at(-1)?.text).toContain(
          "Compare the actual diff with each ticket's plannedFileChanges",
        );
        expect(reviewerThread?.messages.at(-1)?.text).toContain("- vp check");
        expect(reviewerThread?.messages.at(-1)?.text).toContain("- vp run typecheck");

        yield* appendCodeReviewResult(system, {
          run,
          threadId: reviewerThread!.id,
          status: "clean",
          tag: "clean",
        });
        snapshot = yield* system.query.getSnapshot();
        const finalGateRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(finalGateRun?.automationHalt).toBeNull();
        expect(finalGateRun?.retryableFailure).toBeNull();
        expect(finalGateRun?.status).toBe("babysitting-change-request");
        expect(finalGateRun?.activeValidationKind).toBeNull();
        expect(finalGateRun?.validatedHeadSha).toBe("def456");
        expect(yield* Ref.get(system.createOrOpenChangeRequestCount)).toBe(1);
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-validator"),
        ).toHaveLength(1);
        yield* passFinalGate(system, run);

        snapshot = yield* system.query.getSnapshot();
        const completedRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(completedRun?.status).toBe("completed");
        // A finished run releases the stacks it owns, and says which protected
        // ones it deliberately left running.
        const orchestratorWorkflowId = snapshot.threads.find(
          (thread) => thread.id === run.orchestratorThreadId,
        )?.workflowContext?.workflowId;
        expect(orchestratorWorkflowId).toBeDefined();
        expect(yield* Ref.get(system.workflowTeardownInputs)).toEqual([
          { workflowId: orchestratorWorkflowId },
        ]);
        const teardownActivity = snapshot.threads
          .find((thread) => thread.id === run.orchestratorThreadId)
          ?.activities.find((entry) => entry.kind === "implementation-run-stacks-torn-down");
        expect(teardownActivity?.summary).toBe(
          "Stopped 1 workflow App Dev Stack(s); left 2 protected",
        );
        expect(completedRun?.mergeGateAttemptCount).toBe(1);
        expect(completedRun?.validatedHeadSha).toBe("def456");
        expect(completedRun?.changeRequest?.url).toBe("https://example.test/pr/1");
        expect(yield* Ref.get(system.createOrOpenChangeRequestCount)).toBe(1);
        expect(yield* Ref.get(system.createOrOpenChangeRequestInputs)).toEqual([
          expect.objectContaining({
            cwd: run.orchestratorWorktreePath,
            baseRefName: "main",
            headRefName: run.orchestratorBranch,
            expectedHeadSha: "def456",
          }),
        ]);

        // The orchestrator thread narrates the run through lifecycle
        // activities (other activity kinds, e.g. hardlock fallbacks, may
        // interleave and are ignored here).
        const lifecycleKinds = new Set([
          "implementation-run-launched",
          "implementation-worker-started",
          "implementation-worker-finished",
          "implementation-merge-gate-started",
          "implementation-merge-gate-finished",
          "implementation-browser-review-started",
          "implementation-browser-review-finished",
          "implementation-change-request-filed",
          "implementation-code-review-started",
          "implementation-code-review-finished",
          "implementation-run-completed",
        ]);
        const orchestratorThread = snapshot.threads.find(
          (thread) => thread.id === run.orchestratorThreadId,
        );
        // Same-timestamp activities are not ordered deterministically in the
        // snapshot, so assert the exact multiset of kinds instead of the order.
        const lifecycleTrail = (orchestratorThread?.activities ?? [])
          .filter((activity) => lifecycleKinds.has(activity.kind))
          .map((activity) => activity.kind)
          .sort();
        expect(lifecycleTrail).toEqual([...lifecycleKinds].sort());
      }),
    ),
  );

  it.effect("starts a fresh TDD repair when app stack creation fails", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          yield* appendWorkerResult(system, { run, status: "succeeded" });
          let snapshot = yield* system.query.getSnapshot();
          const validator = snapshot.threads.find(
            (thread) => thread.workflowRole === "implementation-validator",
          );

          yield* system.engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId("merge-gate-pass-stack-fallback"),
            threadId: validator!.id,
            activity: {
              id: eventId("merge-gate-pass-stack-fallback"),
              tone: "info",
              kind: "implementation-merge-gate-result",
              summary: "Merge gate passed",
              payload: {
                type: "implementation-merge-gate-result",
                runId: run.id,
                status: "passed",
                validations: requiredValidations(),
                summaryMarkdown: "ok",
              },
              turnId: null,
              createdAt: "2026-01-01T00:00:02.000Z",
            },
            createdAt: "2026-01-01T00:00:02.000Z",
          });
          yield* system.reactor.drain;

          snapshot = yield* system.query.getSnapshot();
          const reviewingRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
          expect(reviewingRun?.status).toBe("fixing");
          expect(reviewingRun?.fixOrigin).toBe("app-dev-stack");
          expect(reviewingRun?.qaCycleCount).toBe(1);
          expect(reviewingRun?.appReviewIds).toHaveLength(0);
          const orchestrator = snapshot.threads.find(
            (thread) => thread.id === run.orchestratorThreadId,
          );
          expect(
            orchestrator?.activities.some(
              (activity) => activity.kind === "implementation-fixer-started",
            ),
          ).toBe(true);
          expect(
            snapshot.threads.some((thread) => thread.workflowRole === "implementation-qa-reviewer"),
          ).toBe(false);

          const repair = snapshot.threads.find(
            (thread) => thread.workflowRole === "implementation-fixer",
          );
          expect(repair?.workflowRole).toBe("implementation-fixer");
          expect(repair?.messages.at(-1)?.text).toContain("Orchestrated QA Repair Result");
          expect(repair?.messages.at(-1)?.text).toContain("Programmatic AppDevStack diagnostics");
        }),
      { failAutoCreate: true },
    ),
  );

  it.effect("starts a fresh Final Code Review cycle when complete validation is duplicated", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* passAppReview(system, run);
        const reviewer = yield* nextThreadForRole(
          system,
          "implementation-code-reviewer",
          new Set<string>(),
        );
        yield* appendCodeReviewResult(system, {
          run,
          threadId: reviewer.id,
          status: "clean",
          tag: "duplicate-complete-validation",
          validations: [...completeValidations(), completeValidations()[0]!],
        });

        const snapshot = yield* system.query.getSnapshot();
        const retrying = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(retrying?.status).toBe("code-reviewing");
        expect(retrying?.codeReviewAttemptCount).toBe(2);
        expect(retrying?.finalCodeReviewPassCount).toBe(1);
        expect(retrying?.activeCodeReviewThreadId).not.toBe(reviewer.id);
        expect(retrying?.automationHalt).toBeNull();
        expect(
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          ),
        ).toHaveLength(2);
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-validator"),
        ).toHaveLength(1);
        expect(yield* Ref.get(system.createOrOpenChangeRequestCount)).toBe(0);
      }),
    ),
  );

  it.effect("publishes with a warning when complete validation fails at the review ceiling", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);

        let snapshot = yield* system.query.getSnapshot();
        const qaReviewing = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        if (qaReviewing === undefined) throw new Error("QA reviewing run missing.");
        yield* system.engine.dispatch({
          type: "thread.implementation-run.update",
          commandId: commandId("seed-review-gate-budget"),
          threadId: sourceThreadId,
          run: {
            ...qaReviewing,
            codeReviewAttemptCount: IMPLEMENTATION_RUN_MAX_REVIEW_GATE_CYCLES - 1,
            finalCodeReviewPassCount: IMPLEMENTATION_RUN_MAX_REVIEW_GATE_CYCLES - 1,
          },
          createdAt: "2026-01-01T00:00:02.500Z",
        });
        yield* passAppReview(system, run);

        snapshot = yield* system.query.getSnapshot();
        const ceilingRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        const reviewer = snapshot.threads.find(
          (thread) => thread.id === ceilingRun?.activeCodeReviewThreadId,
        );
        if (reviewer === undefined) throw new Error("Final Code Review missing.");
        yield* appendCodeReviewResult(system, {
          run,
          threadId: reviewer.id,
          status: "clean",
          tag: "at-review-gate-budget",
          validations: completeValidations().map((validation, index) =>
            index === 0
              ? {
                  ...validation,
                  status: "failed" as const,
                  outputMarkdown: "Capability evidence requires review.",
                }
              : validation,
          ),
        });
        yield* passChangeRequestBabysit(system, run, "2026-01-01T00:00:07.000Z");

        snapshot = yield* system.query.getSnapshot();
        const completed = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(completed?.codeReviewAttemptCount).toBe(IMPLEMENTATION_RUN_MAX_REVIEW_GATE_CYCLES);
        expect(completed?.finalCodeReviewPassCount).toBe(IMPLEMENTATION_RUN_MAX_REVIEW_GATE_CYCLES);
        expect(completed?.status).toBe("completed");
        expect(completed?.codeReviewExhaustedAt).not.toBeNull();
        expect(completed?.codeReviewExhaustionReason).toContain("complete validation did not pass");
        expect(completed?.finalValidation?.status).toBe("failed");
        expect(completed?.validatedHeadSha).toBe("def456");
        expect(completed?.changeRequest).not.toBeNull();
        expect(completed?.automationHalt).toBeNull();
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-fixer"),
        ).toHaveLength(0);
        expect(yield* Ref.get(system.createOrOpenChangeRequestCount)).toBe(1);
        const orchestrator = snapshot.threads.find(
          (thread) => thread.id === run.orchestratorThreadId,
        );
        expect(
          orchestrator?.activities.some(
            (activity) => activity.kind === "implementation-code-review-exhausted",
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("starts the next App Review directly after a fresh TDD browser repair", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* failAppReview(system, run);
        yield* appendBrowserFixResult(system, { run, validations: requiredValidations() });

        const snapshot = yield* system.query.getSnapshot();
        const updated = snapshot.implementationRuns.find((candidate) => candidate.id === run.id);
        expect(updated?.status).toBe("qa-reviewing");
        expect(updated?.appReviewIds).toHaveLength(2);
        expect(updated?.mergeGateAttemptCount).toBe(1);
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-validator"),
        ).toHaveLength(1);
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-qa-reviewer"),
        ).toHaveLength(2);
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-fixer"),
        ).toHaveLength(1);
        expect(yield* Ref.get(system.mergeRefInputs)).toHaveLength(1);
      }),
    ),
  );

  it.effect("routes a failed App Review through a fresh TDD repair thread", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* failAppReview(system, run);

        const snapshot = yield* system.query.getSnapshot();
        const repairing = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(repairing?.status).toBe("fixing");
        expect(repairing?.fixOrigin).toBe("app-review");
        expect(repairing?.lastQaFailure?.status).toBe("failed");
        expect(repairing?.qaCycleCount).toBe(1);
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-fixer"),
        ).toHaveLength(1);
        const fixer = snapshot.threads.find(
          (thread) => thread.workflowRole === "implementation-fixer",
        );
        expect(fixer?.messages.at(-1)?.text).toContain("Retrieve App Review");
        expect(fixer?.messages.at(-1)?.text).toContain("workflow_app_review_get");
        expect(fixer?.messages.at(-1)?.text).toContain("focused red-green TDD loop");
      }),
    ),
  );

  it.effect(
    "replaces browser fixes with missing validation results using the next repair slot",
    () =>
      withSystem((system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          yield* appendWorkerResult(system, { run, status: "succeeded" });
          yield* passMergeGate(system, run);
          yield* failAppReview(system, run);
          yield* appendBrowserFixResult(system, { run, validations: [] });

          const snapshot = yield* system.query.getSnapshot();
          const updated = snapshot.implementationRuns.find((candidate) => candidate.id === run.id);
          expect(updated?.status).toBe("fixing");
          expect(updated?.retryableFailure).toBeNull();
          expect(updated?.qaCycleCount).toBe(2);
          expect(updated?.appReviewIds).toHaveLength(1);
          expect(
            snapshot.threads.filter((thread) => thread.workflowRole === "implementation-validator"),
          ).toHaveLength(1);
          expect(
            snapshot.threads.filter((thread) => thread.workflowRole === "implementation-fixer"),
          ).toHaveLength(2);
        }),
      ),
  );

  it.effect("counts a fresh replacement for an interrupted browser fixer", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* failAppReview(system, run);

        let snapshot = yield* system.query.getSnapshot();
        const firstFixer = snapshot.threads.find(
          (thread) => thread.workflowRole === "implementation-fixer",
        );
        if (firstFixer === undefined) throw new Error("Fixer missing.");
        yield* system.engine.dispatch({
          type: "thread.activity.append",
          commandId: commandId("browser-fix-interrupted"),
          threadId: firstFixer.id,
          activity: {
            id: eventId("browser-fix-interrupted"),
            tone: "error",
            kind: "implementation-fix-result",
            summary: "Implementation fix failed",
            payload: {
              type: "implementation-fix-result",
              runId: run.id,
              status: "failed",
              validations: [],
              notesMarkdown:
                "Provider session lost while a turn was running; settled by the stale-turn reconciler.",
            },
            turnId: null,
            createdAt: "2026-01-01T00:00:04.000Z",
          },
          createdAt: "2026-01-01T00:00:04.000Z",
        });
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        const interrupted = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(interrupted?.status).toBe("fixing");
        expect(interrupted?.retryableFailure).toBeNull();
        expect(interrupted?.qaCycleCount).toBe(2);
        expect(interrupted?.activeFixerThreadId).not.toBe(firstFixer.id);
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-fixer"),
        ).toHaveLength(2);
      }),
    ),
  );

  it.effect("recovers legacy interrupted fixers that predate retryable fixer failures", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* failAppReview(system, run);

        let snapshot = yield* system.query.getSnapshot();
        const fixingRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        const firstFixer = snapshot.threads.find(
          (thread) => thread.workflowRole === "implementation-fixer",
        );
        if (fixingRun === undefined || firstFixer === undefined) {
          throw new Error("Fixer missing.");
        }
        yield* system.engine.dispatch({
          type: "thread.implementation-run.update",
          commandId: commandId("legacy-browser-fix-interrupted"),
          threadId: sourceThreadId,
          run: {
            ...fixingRun,
            status: "needs-human-attention",
            retryableFailure: null,
          },
          createdAt: "2026-01-01T00:00:04.000Z",
        });
        yield* system.engine.dispatch({
          type: "thread.session.set",
          commandId: commandId("legacy-browser-fixer-session-error"),
          threadId: firstFixer.id,
          session: {
            threadId: firstFixer.id,
            status: "error",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: "Provider session lost.",
            updatedAt: "2026-01-01T00:00:04.000Z",
          },
          createdAt: "2026-01-01T00:00:04.000Z",
        });

        yield* system.reactor.start();
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        const recovered = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(recovered?.status).toBe("fixing");
        expect(recovered?.activeFixerThreadId).not.toBe(firstFixer.id);
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-fixer"),
        ).toHaveLength(2);
      }),
    ),
  );

  it.effect("claims one Code Review when recovery sweeps share stale QA state", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const entryCount = yield* Ref.make(0);

      yield* withSystem(
        (system) =>
          Effect.gen(function* () {
            const { run } = yield* launchRun(system, {
              appReviewStrategy: "nested-workflow",
            });
            const recoveringRun: OrchestrationImplementationRun = {
              ...run,
              status: "qa-reviewing",
              orchestratorBranch: "main",
              orchestratorWorktreePath: "/tmp/implementation-reactor-review",
              integrationHeadSha: "def456",
              activeAppReviewHeadSha: null,
              activeAppReviewThreadId: null,
              activeCodeReviewHeadSha: null,
              activeCodeReviewThreadId: null,
              appDevStack: {
                status: "ready",
                stackId: "stack-1",
                stackStatus: "running",
                frontendUrl: "http://127.0.0.1:5173",
                frontendServiceName: "frontend",
                displayName: "Implementation test",
                lastErrorMarkdown: null,
                requestedAt: now,
                updatedAt: now,
              },
              updatedAt: now,
            };
            yield* system.engine.dispatch({
              type: "thread.implementation-run.update",
              commandId: commandId("stale-qa-recovery-state"),
              threadId: sourceThreadId,
              run: recoveringRun,
              createdAt: now,
            });

            const recoveries = yield* Effect.forkChild(
              Effect.all(
                [
                  system.reactor.recoverIncompleteStages(),
                  system.reactor.recoverIncompleteStages(),
                ],
                { concurrency: 2, discard: true },
              ),
            );
            yield* Deferred.await(entered);
            expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(2);
            yield* Deferred.succeed(release, undefined);
            yield* Fiber.join(recoveries);

            const snapshot = yield* system.query.getSnapshot();
            const claimedRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
            expect(claimedRun?.status).toBe("code-reviewing");
            expect(claimedRun?.codeReviewAttemptCount).toBe(1);
            expect(claimedRun?.activeCodeReviewThreadId).not.toBeNull();
            expect(
              snapshot.threads.filter(
                (thread) => thread.workflowRole === "implementation-code-reviewer",
              ),
            ).toHaveLength(1);
          }),
        {
          startReactor: false,
          autoCreateGate: { entered, release, entryCount, requiredEntries: 2 },
          serverSettings: {
            workflowStepReviewParts: [
              {
                workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
                e2e: false,
                browser: false,
              },
            ],
          },
        },
      );
    }),
  );

  it.effect(
    "clears the retry state after an interrupted final Code Review returns a valid pass",
    () =>
      withSystem((system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          yield* appendWorkerResult(system, { run, status: "succeeded" });
          yield* passMergeGate(system, run);
          yield* passAppReview(system, run);

          let snapshot = yield* system.query.getSnapshot();
          let current = snapshot.implementationRuns.find((entry) => entry.id === run.id);
          const firstReviewerId = current?.activeCodeReviewThreadId;
          if (firstReviewerId === null || firstReviewerId === undefined) {
            throw new Error("Final Code Review missing.");
          }
          yield* appendCodeReviewResult(system, {
            run,
            threadId: firstReviewerId,
            status: "blocked",
            reportMarkdown: WORKFLOW_INTERRUPTION_ERROR_MESSAGE,
            tag: "final-interrupted-once",
          });

          snapshot = yield* system.query.getSnapshot();
          current = snapshot.implementationRuns.find((entry) => entry.id === run.id);
          const secondReviewerId = current?.activeCodeReviewThreadId;
          expect(secondReviewerId).toBe(firstReviewerId);
          expect(current?.finalCodeReviewLaunchCount).toBe(2);
          expect(current?.retryableFailure).toMatchObject({
            stage: "code-review",
            attemptCount: 1,
          });
          expect(current?.automationHalt).toBeNull();
          if (secondReviewerId === null || secondReviewerId === undefined) {
            throw new Error("Final Code Review retry missing.");
          }

          yield* appendCodeReviewResult(system, {
            run,
            threadId: secondReviewerId,
            status: "clean",
            tag: "final-retry-clean",
          });

          snapshot = yield* system.query.getSnapshot();
          current = snapshot.implementationRuns.find((entry) => entry.id === run.id);
          expect(current?.status).toBe("babysitting-change-request");
          expect(current?.retryableFailure).toBeNull();
          expect(current?.finalCodeReviewPassCount).toBe(1);
          expect(current?.automationHalt).toBeNull();
          expect(
            snapshot.threads.filter(
              (thread) => thread.workflowRole === "implementation-code-reviewer",
            ),
          ).toHaveLength(1);
        }),
      ),
  );

  it.effect("concurrent recovery sweeps cannot duplicate a Final Code Review cycle", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* passAppReview(system, run);
        const reviewer = yield* nextThreadForRole(
          system,
          "implementation-code-reviewer",
          new Set<string>(),
        );
        yield* appendCodeReviewResult(system, {
          run,
          threadId: reviewer.id,
          status: "clean",
          tag: "failed-validation-before-concurrent-recovery",
          validations: completeValidations().map((validation, index) =>
            index === 0 ? { ...validation, status: "failed" as const } : validation,
          ),
        });

        yield* Effect.all(
          [system.reactor.recoverIncompleteStages(), system.reactor.recoverIncompleteStages()],
          {
            concurrency: 2,
            discard: true,
          },
        );

        const snapshot = yield* system.query.getSnapshot();
        const retrying = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(retrying?.status).toBe("code-reviewing");
        expect(retrying?.finalCodeReviewPassCount).toBe(1);
        expect(retrying?.activeCodeReviewThreadId).not.toBe(reviewer.id);
        expect(retrying?.changeRequest).toBeNull();
        expect(yield* Ref.get(system.createOrOpenChangeRequestCount)).toBe(0);
        expect(
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          ),
        ).toHaveLength(2);
      }),
    ),
  );

  it.effect("recovers a filed change request without publishing it again", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const publishingRun: OrchestrationImplementationRun = {
            ...run,
            status: "publishing-change-request",
            orchestratorBranch: "main",
            integrationHeadSha: "def456",
            codeReviewedHeadSha: "def456",
            activeCodeReviewHeadSha: null,
            activeCodeReviewThreadId: null,
            changeRequest: {
              provider: "github",
              number: 70,
              title: "Implementation PR",
              url: "https://example.test/pr/70",
              baseRefName: "main",
              headRefName: "implementation/checkout",
              state: "open",
              updatedAt: Option.none(),
            },
            reviewGateExhaustedAt: now,
            reviewGateExhaustionReason: "Final validation did not pass.",
            updatedAt: now,
          };
          yield* system.engine.dispatch({
            type: "thread.implementation-run.update",
            commandId: commandId("filed-change-request-recovery-state"),
            threadId: sourceThreadId,
            run: publishingRun,
            createdAt: now,
          });

          yield* system.reactor.recoverIncompleteStages();

          const snapshot = yield* system.query.getSnapshot();
          const recovered = snapshot.implementationRuns.find((entry) => entry.id === run.id);
          expect(recovered?.status).toBe("babysitting-change-request");
          expect(recovered?.changeRequest?.number).toBe(70);
          expect(yield* Ref.get(system.createOrOpenChangeRequestCount)).toBe(0);
          expect(
            snapshot.threads.filter(
              (thread) => thread.workflowRole === "implementation-change-request-babysitter",
            ),
          ).toHaveLength(1);
        }),
      { startReactor: false },
    ),
  );

  it.effect("keeps complete validation in Final Code Review when App Review is disabled", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system, {
            appReviewStrategy: "nested-workflow",
          });
          yield* appendWorkerResult(system, { run, status: "succeeded" });
          yield* passMergeGate(system, run);

          let snapshot = yield* system.query.getSnapshot();
          const reviewingRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
          const reviewer = snapshot.threads.find(
            (thread) => thread.id === reviewingRun?.activeCodeReviewThreadId,
          );
          if (reviewer === undefined) throw new Error("Code reviewer missing.");
          const reviewerCount = snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          ).length;
          yield* appendCodeReviewResult(system, {
            run,
            threadId: reviewer.id,
            status: "clean",
            tag: "app-review-disabled",
          });

          snapshot = yield* system.query.getSnapshot();
          const publishingRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
          expect(publishingRun?.automationHalt).toBeNull();
          expect(publishingRun?.retryableFailure).toBeNull();
          expect(publishingRun?.status).toBe("babysitting-change-request");
          expect(publishingRun?.activeValidationKind).toBeNull();
          expect(publishingRun?.codeReviewedHeadSha).toBe("def456");
          expect(publishingRun?.codeReviewAttemptCount).toBe(1);
          expect(publishingRun?.qaAttemptCount).toBe(0);
          expect(
            snapshot.threads.filter(
              (thread) => thread.workflowRole === "implementation-code-reviewer",
            ),
          ).toHaveLength(reviewerCount);
          expect(
            snapshot.threads.filter((thread) => thread.workflowRole === "implementation-validator"),
          ).toHaveLength(1);

          yield* passFinalGate(system, run);
          snapshot = yield* system.query.getSnapshot();
          const completedRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
          expect(completedRun?.status).toBe("completed");
          expect(yield* Ref.get(system.createOrOpenChangeRequestCount)).toBe(1);
        }),
      {
        serverSettings: {
          workflowStepReviewParts: [
            {
              workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
              e2e: false,
              browser: false,
            },
          ],
        },
      },
    ),
  );

  it.effect("numbers malformed QA replacements monotonically and halts before an eleventh", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* failAppReview(system, run);

        for (let repair = 1; repair <= IMPLEMENTATION_RUN_MAX_QA_REPAIRS; repair += 1) {
          const snapshot = yield* system.query.getSnapshot();
          const activeFixerThreadId = snapshot.implementationRuns.find(
            (entry) => entry.id === run.id,
          )?.activeFixerThreadId;
          if (activeFixerThreadId === null || activeFixerThreadId === undefined) {
            throw new Error(`Repair ${repair} missing.`);
          }
          yield* system.engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId(`malformed-repair-${repair}`),
            threadId: activeFixerThreadId,
            activity: {
              id: eventId(`malformed-repair-${repair}`),
              tone: "error",
              kind: "implementation-fix-result",
              summary: "Implementation fix result was malformed",
              payload: {
                type: "implementation-fix-result",
                runId: run.id,
                status: "blocked",
                validations: [],
                notesMarkdown: `Repair ${repair} omitted required validation timestamps.`,
              },
              turnId: null,
              createdAt: `2026-01-01T00:00:${String(10 + repair).padStart(2, "0")}.000Z`,
            },
            createdAt: `2026-01-01T00:00:${String(10 + repair).padStart(2, "0")}.000Z`,
          });
          yield* system.reactor.drain;
        }

        const snapshot = yield* system.query.getSnapshot();
        const exhausted = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        const fixers = snapshot.threads.filter(
          (thread) => thread.workflowRole === "implementation-fixer",
        );
        expect(exhausted?.qaCycleCount).toBe(IMPLEMENTATION_RUN_MAX_QA_REPAIRS);
        expect(exhausted?.qaExhaustedAt).not.toBeNull();
        expect(exhausted?.appReviewExhaustedAt).not.toBeNull();
        expect(exhausted?.status).toBe("needs-human-attention");
        expect(exhausted?.automationHalt).toMatchObject({
          stage: "app-review",
          category: "review-blocked",
        });
        expect(fixers).toHaveLength(IMPLEMENTATION_RUN_MAX_QA_REPAIRS);
        expect(fixers.map((thread) => thread.title)).toEqual(
          Array.from(
            { length: IMPLEMENTATION_RUN_MAX_QA_REPAIRS },
            (_, index) => `TDD repair ${index + 1}/10 · App Review`,
          ),
        );
      }),
    ),
  );

  it.effect("keeps an unsafe exhausted run human-blocked without repeating exhaustion", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        const snapshot = yield* system.query.getSnapshot();
        const reviewing = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        if (reviewing === undefined) throw new Error("Reviewing run missing.");
        yield* system.engine.dispatch({
          type: "thread.implementation-run.update",
          commandId: commandId("unsafe-exhausted-recovery-state"),
          threadId: sourceThreadId,
          run: {
            ...reviewing,
            status: "needs-human-attention",
            orchestratorBranch: "implementation/unexpected",
            qaCycleCount: IMPLEMENTATION_RUN_MAX_QA_REPAIRS,
            qaExhaustedAt: "2026-01-01T00:00:03.000Z",
            appReviewExhaustedAt: "2026-01-01T00:00:03.000Z",
            validatedHeadSha: null,
            retryableFailure: {
              stage: "app-review",
              detail: "Legacy exhausted run needs validation.",
              failedAt: "2026-01-01T00:00:03.000Z",
              attemptCount: 1,
              maxAttempts: 5,
              humanBlocked: false,
            },
            updatedAt: "2026-01-01T00:00:03.000Z",
          },
          createdAt: "2026-01-01T00:00:03.000Z",
        });
        yield* system.engine.dispatch({
          type: "thread.implementation-run.retry",
          commandId: commandId("unsafe-exhausted-retry"),
          threadId: sourceThreadId,
          runId: run.id,
          createdAt: "2026-01-01T00:00:04.000Z",
        });
        yield* system.reactor.drain;

        const recoveredSnapshot = yield* system.query.getSnapshot();
        const blocked = recoveredSnapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(blocked?.status).toBe("needs-human-attention");
        expect(blocked?.retryableFailure?.stage).toBe("app-review");
        expect(blocked?.retryableFailure?.humanBlocked).toBe(true);
        expect(blocked?.codeReviewAttemptCount).toBe(0);
        const orchestrator = recoveredSnapshot.threads.find(
          (thread) => thread.id === run.orchestratorThreadId,
        );
        expect(
          orchestrator?.activities.filter(
            (activity) => activity.kind === "implementation-qa-exhausted",
          ),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("halts when AppDevStack exhausts ten QA repairs", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          yield* appendWorkerResult(system, { run, status: "succeeded" });

          let snapshot = yield* system.query.getSnapshot();
          const validating = snapshot.implementationRuns.find((entry) => entry.id === run.id);
          if (validating === undefined) throw new Error("Validating run missing.");
          yield* system.engine.dispatch({
            type: "thread.implementation-run.update",
            commandId: commandId("exhaust-app-stack-cycles"),
            threadId: sourceThreadId,
            run: {
              ...validating,
              qaCycleCount: IMPLEMENTATION_RUN_MAX_QA_REPAIRS - 1,
            },
            createdAt: "2026-01-01T00:00:02.500Z",
          });
          yield* passMergeGate(system, run);

          snapshot = yield* system.query.getSnapshot();
          const tenthRepair = snapshot.implementationRuns.find((entry) => entry.id === run.id);
          expect(tenthRepair?.status).toBe("fixing");
          expect(tenthRepair?.qaCycleCount).toBe(IMPLEMENTATION_RUN_MAX_QA_REPAIRS);
          if (
            tenthRepair?.activeFixerThreadId === null ||
            tenthRepair?.activeFixerThreadId === undefined
          ) {
            throw new Error("Tenth repair missing.");
          }
          yield* system.engine.dispatch({
            type: "thread.activity.append",
            commandId: commandId("app-stack-tenth-repair-blocked"),
            threadId: tenthRepair.activeFixerThreadId,
            activity: {
              id: eventId("app-stack-tenth-repair-blocked"),
              tone: "error",
              kind: "implementation-fix-result",
              summary: "Implementation fix blocked",
              payload: {
                type: "implementation-fix-result",
                runId: run.id,
                status: "blocked",
                validations: [],
                notesMarkdown: "AppDevStack remains unavailable.",
              },
              turnId: null,
              createdAt: "2026-01-01T00:00:04.000Z",
            },
            createdAt: "2026-01-01T00:00:04.000Z",
          });
          yield* system.reactor.drain;
          snapshot = yield* system.query.getSnapshot();
          const exhausted = snapshot.implementationRuns.find((entry) => entry.id === run.id);
          expect(exhausted?.status).toBe("needs-human-attention");
          expect(exhausted?.qaCycleCount).toBe(IMPLEMENTATION_RUN_MAX_QA_REPAIRS);
          expect(exhausted?.qaExhaustedAt).not.toBeNull();
          expect(exhausted?.qaExhaustionReason).toBe("app-dev-stack");
          expect(exhausted?.appReviewExhaustedAt).toBeNull();
          expect(exhausted?.appReviewIds).toHaveLength(0);
          expect(
            snapshot.threads.filter((thread) => thread.workflowRole === "implementation-fixer"),
          ).toHaveLength(1);
          expect(exhausted?.automationHalt).toMatchObject({ category: "review-blocked" });
          expect(yield* Ref.get(system.createOrOpenChangeRequestCount)).toBe(0);
        }),
      { failAutoCreate: true },
    ),
  );

  it.effect("publishes after five Final Code Review findings cycles with a warning", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* passAppReview(system, run);

        const seenReviewers = new Set<string>();
        for (let cycle = 1; cycle <= 5; cycle += 1) {
          const reviewer = yield* nextThreadForRole(
            system,
            "implementation-code-reviewer",
            seenReviewers,
          );
          yield* appendCodeReviewResult(system, {
            run,
            threadId: reviewer.id,
            status: "findings",
            tag: `findings-cycle-${cycle}`,
            ...(cycle === 5 ? { validations: completeValidations() } : {}),
          });
        }
        yield* passFinalGate(system, run);

        const snapshot = yield* system.query.getSnapshot();
        const completedRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(completedRun?.status).toBe("completed");
        expect(completedRun?.codeReviewAttemptCount).toBe(5);
        expect(completedRun?.finalCodeReviewPassCount).toBe(5);
        expect(completedRun?.codeReviewedHeadSha).toBe("def456");
        expect(completedRun?.codeReviewExhaustedAt).not.toBeNull();
        expect(yield* Ref.get(system.createOrOpenChangeRequestCount)).toBe(1);
        expect(
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          ),
        ).toHaveLength(5);
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-validator"),
        ).toHaveLength(1);
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-fixer"),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("starts a fresh Final Code Review cycle after complete validation fails", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* passAppReview(system, run);

        const firstReviewer = yield* nextThreadForRole(
          system,
          "implementation-code-reviewer",
          new Set<string>(),
        );
        yield* appendCodeReviewResult(system, {
          run,
          threadId: firstReviewer.id,
          status: "clean",
          tag: "final-validation-failed-before-ceiling",
          validations: completeValidations().map((validation, index) =>
            index === 0 ? { ...validation, status: "failed" as const } : validation,
          ),
        });

        const snapshot = yield* system.query.getSnapshot();
        const current = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(current?.status).toBe("code-reviewing");
        expect(current?.finalCodeReviewPassCount).toBe(1);
        expect(current?.finalCodeReviewGeneration).toBe(1);
        expect(current?.activeCodeReviewThreadId).not.toBe(firstReviewer.id);
        expect(
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          ),
        ).toHaveLength(2);
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-validator"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("completes without publishing when pull-request creation is skipped", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system, {
          skips: [{ kind: "run", stage: "change-request" }],
        });
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* passAppReview(system, run);

        const reviewer = yield* nextThreadForRole(
          system,
          "implementation-code-reviewer",
          new Set<string>(),
        );
        yield* appendCodeReviewResult(system, {
          run,
          threadId: reviewer.id,
          status: "clean",
          tag: "skip-pull-request",
        });
        yield* passFinalGate(system, run);

        const snapshot = yield* system.query.getSnapshot();
        expect(snapshot.implementationRuns.find((entry) => entry.id === run.id)?.status).toBe(
          "completed",
        );
        expect(yield* Ref.get(system.createOrOpenChangeRequestCount)).toBe(0);
        expect(
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-change-request-babysitter",
          ),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("publishes without starting a babysitter when that step is skipped", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system, {
          skips: [{ kind: "run", stage: "change-request-babysit" }],
        });
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* passAppReview(system, run);

        const reviewer = yield* nextThreadForRole(
          system,
          "implementation-code-reviewer",
          new Set<string>(),
        );
        yield* appendCodeReviewResult(system, {
          run,
          threadId: reviewer.id,
          status: "clean",
          tag: "skip-pull-request-babysitter",
        });
        yield* passFinalGate(system, run);

        const snapshot = yield* system.query.getSnapshot();
        const completed = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(completed?.status).toBe("completed");
        expect(completed?.changeRequest?.number).toBe(1);
        expect(yield* Ref.get(system.createOrOpenChangeRequestCount)).toBe(1);
        expect(
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-change-request-babysitter",
          ),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("starts a fresh review when a findings cycle skips focused validation", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* passAppReview(system, run);

        const seenReviewers = new Set<string>();
        const reviewer = yield* nextThreadForRole(
          system,
          "implementation-code-reviewer",
          seenReviewers,
        );
        yield* appendCodeReviewResult(system, {
          run,
          threadId: reviewer.id,
          status: "findings",
          tag: "missing-validations",
          validations: [],
        });

        const snapshot = yield* system.query.getSnapshot();
        const retryingRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(retryingRun?.status).toBe("code-reviewing");
        expect(retryingRun?.finalCodeReviewPassCount).toBe(1);
        expect(retryingRun?.activeCodeReviewThreadId).not.toBe(reviewer.id);
        expect(retryingRun?.retryableFailure).toBeNull();
        expect(
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          ),
        ).toHaveLength(2);
        expect(yield* Ref.get(system.createOrOpenChangeRequestCount)).toBe(0);
      }),
    ),
  );

  it.effect("runs the browser app review on the model the workflow was started with", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system, { modelSelection: claudeParentSelection });
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);

        const snapshot = yield* system.query.getSnapshot();
        const reviewThread = snapshot.threads.find(
          (thread) => thread.workflowRole === "implementation-qa-reviewer",
        );
        expect(reviewThread?.modelSelection).toEqual(claudeParentSelection);

        const workerThread = snapshot.threads.find(
          (thread) => thread.workflowRole === "implementation-worker",
        );
        expect(workerThread?.modelSelection).toEqual(claudeParentSelection);
      }),
    ),
  );

  it.effect("keeps inheriting the workflow model when codex is disabled entirely", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system, { modelSelection: claudeParentSelection });
          yield* appendWorkerResult(system, { run, status: "succeeded" });
          yield* passMergeGate(system, run);

          const snapshot = yield* system.query.getSnapshot();
          const reviewThread = snapshot.threads.find(
            (thread) => thread.workflowRole === "implementation-qa-reviewer",
          );
          expect(reviewThread?.modelSelection).toEqual(claudeParentSelection);

          const orchestratorThread = snapshot.threads.find(
            (thread) => thread.id === run.orchestratorThreadId,
          );
          expect(
            orchestratorThread?.activities.some((activity) =>
              activity.kind.endsWith("model-fallback"),
            ),
          ).toBe(false);
        }),
      { serverSettings: { providers: { codex: { enabled: false } } } },
    ),
  );
  it.effect("a skipped ticket keeps its branch so dependents still build on it", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { tickets, run } = yield* launchRun(system, {
          tickets: [
            {
              key: "TICKET-1",
              title: "Base",
              bodyMarkdown: "Base work.",
              plannedFileChanges: [{ path: "src/base.ts", action: "create" }],
              dependencyKeys: [],
            },
            {
              key: "TICKET-2",
              title: "Dependent",
              bodyMarkdown: "Dependent work.",
              plannedFileChanges: [{ path: "src/dependent.ts", action: "create" }],
              dependencyKeys: ["TICKET-1"],
            },
          ],
        });
        const base = tickets.find((ticket) => ticket.key === "TICKET-1")!;
        const dependent = tickets.find((ticket) => ticket.key === "TICKET-2")!;

        yield* system.engine.dispatch({
          type: "thread.implementation-run.skip",
          commandId: commandId("skip-base-ticket"),
          threadId: sourceThreadId,
          runId: run.id,
          target: { kind: "ticket", ticketId: base.id },
          skipped: true,
          createdAt: "2026-01-01T00:00:00.500Z",
        });
        yield* system.reactor.drain;
        // Re-running the base is what walks it through createWorker again now
        // that the skip is recorded.
        yield* system.engine.dispatch({
          type: "thread.implementation-run.rerun",
          commandId: commandId("rerun-skipped-base"),
          threadId: sourceThreadId,
          runId: run.id,
          target: { kind: "ticket", ticketId: base.id, stage: "implementation" },
          createdAt: "2026-01-01T00:00:01.000Z",
        });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const current = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        const baseState = current?.ticketStates.find((state) => state.ticketId === base.id);
        // No agent ran, but the branch is there and the ticket is terminal, so
        // the dependent is free to start on top of it.
        expect(baseState?.status).toBe("succeeded");
        expect(baseState?.workerThreadId ?? null).toBeNull();
        expect(baseState?.workerResult ?? null).toBeNull();
        expect(baseState?.branch).not.toBeNull();
        expect(baseState?.warningMarkdown).toContain("Skipped");
        // The dependent starts inside the same call the skip settled in, rather
        // than waiting for a sweep.
        const dependentState = current?.ticketStates.find(
          (state) => state.ticketId === dependent.id,
        );
        expect(dependentState?.status).toBe("running");
        expect(dependentState?.branch).not.toBeNull();
      }),
    ),
  );

  it.effect("skipping a ticket's App Review sends it straight to Code Review", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, ticket } = yield* launchRun(system, {
          appReviewStrategy: "nested-workflow",
        });

        yield* system.engine.dispatch({
          type: "thread.implementation-run.skip",
          commandId: commandId("skip-ticket-app-review"),
          threadId: sourceThreadId,
          runId: run.id,
          target: { kind: "ticket", ticketId: ticket.id, stage: "app-review" },
          skipped: true,
          createdAt: "2026-01-01T00:00:00.500Z",
        });
        yield* system.reactor.drain;
        yield* appendWorkerResult(system, {
          run,
          status: "succeeded",
          ticketId: ticket.id,
          completeTicketReview: false,
        });

        const snapshot = yield* system.query.getSnapshot();
        const current = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        const state = current?.ticketStates.find((entry) => entry.ticketId === ticket.id);
        expect(current?.skips).toHaveLength(1);
        expect(state?.status).toBe("code-reviewing");
        expect(state?.appReviewWorkflowRunId ?? null).toBeNull();
        expect(snapshot.appReviewWorkflowRuns ?? []).toHaveLength(0);
      }),
    ),
  );

  it.effect("starts more than two ticket App Reviews in parallel", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, tickets } = yield* launchRun(system, {
          appReviewStrategy: "nested-workflow",
          tickets: ["TICKET-1", "TICKET-2", "TICKET-3"].map((key) => ({
            ...planningTicket(key),
            appReviewEligible: true,
            appReviewPlanMarkdown: `Review ${key}.`,
          })),
        });

        for (const ticket of tickets) {
          yield* appendWorkerResult(system, {
            run,
            status: "succeeded",
            ticketId: ticket.id,
            completeTicketReview: false,
          });
        }

        const snapshot = yield* system.query.getSnapshot();
        const current = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        const reviewIds = current?.ticketStates.flatMap((state) =>
          state.appReviewWorkflowRunId == null ? [] : [state.appReviewWorkflowRunId],
        );

        expect(reviewIds).toHaveLength(3);
        expect(new Set(reviewIds).size).toBe(3);
        expect(
          (snapshot.appReviewWorkflowRuns ?? []).filter((review) => reviewIds?.includes(review.id)),
        ).toHaveLength(3);
      }),
    ),
  );

  it.effect("an exhausted ticket App Review launch budget continues to Code Review", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, ticket } = yield* launchRun(system, {
          appReviewStrategy: "nested-workflow",
          tickets: [
            {
              ...planningTicket("TICKET-1"),
              appReviewEligible: true,
              appReviewPlanMarkdown: "Review checkout.",
            },
          ],
        });
        const current = (yield* system.query.getSnapshot()).implementationRuns.find(
          (entry) => entry.id === run.id,
        );
        if (current === undefined) throw new Error("Implementation run missing.");
        const budgetedRun: OrchestrationImplementationRun = {
          ...current,
          ticketStates: current.ticketStates.map((state) =>
            state.ticketId === ticket.id
              ? { ...state, appReviewLaunchCount: IMPLEMENTATION_STAGE_MAX_LAUNCHES }
              : state,
          ),
        };
        yield* system.engine.dispatch({
          type: "thread.implementation-run.update",
          commandId: commandId("exhaust-ticket-app-review-launch-budget"),
          threadId: sourceThreadId,
          run: budgetedRun,
          createdAt: "2026-01-01T00:00:00.500Z",
        });
        yield* system.reactor.drain;

        yield* appendWorkerResult(system, {
          run,
          status: "succeeded",
          ticketId: ticket.id,
          completeTicketReview: false,
        });

        const snapshot = yield* system.query.getSnapshot();
        const updated = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        const state = updated?.ticketStates.find((entry) => entry.ticketId === ticket.id);
        expect(updated?.status).toBe("running");
        expect(updated?.automationHalt).toBeNull();
        expect(state).toMatchObject({
          status: "code-reviewing",
          appReviewOutcome: "failed",
        });
        expect(state?.appReviewWorkflowRunId ?? null).toBeNull();
        expect(state?.warningMarkdown).toContain("exhausting its 2-launch budget");
        expect(snapshot.appReviewWorkflowRuns ?? []).toHaveLength(0);
        expect(
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          ),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("lifting a skip leaves the run with none recorded", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, ticket } = yield* launchRun(system);
        const target = {
          kind: "ticket" as const,
          ticketId: ticket.id,
          stage: "app-review" as const,
        };
        for (const skipped of [true, false]) {
          yield* system.engine.dispatch({
            type: "thread.implementation-run.skip",
            commandId: commandId(`toggle-skip-${String(skipped)}`),
            threadId: sourceThreadId,
            runId: run.id,
            target,
            skipped,
            createdAt: "2026-01-01T00:00:00.500Z",
          });
          yield* system.reactor.drain;
        }

        const current = (yield* system.query.getSnapshot()).implementationRuns.find(
          (entry) => entry.id === run.id,
        );
        expect(current?.skips).toHaveLength(0);
      }),
    ),
  );

  it.effect("clearing a ticket puts it back in the queue instead of starting it", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { tickets, run } = yield* launchRun(system, {
          tickets: [
            {
              key: "TICKET-1",
              title: "Base",
              bodyMarkdown: "Base work.",
              plannedFileChanges: [{ path: "src/base.ts", action: "create" }],
              dependencyKeys: [],
            },
            {
              key: "TICKET-2",
              title: "Dependent",
              bodyMarkdown: "Dependent work.",
              plannedFileChanges: [{ path: "src/dependent.ts", action: "create" }],
              dependencyKeys: ["TICKET-1"],
            },
          ],
        });
        const base = tickets.find((ticket) => ticket.key === "TICKET-1")!;
        const dependent = tickets.find((ticket) => ticket.key === "TICKET-2")!;
        yield* appendWorkerResult(system, { run, status: "succeeded", ticketId: base.id });
        yield* appendWorkerResult(system, { run, status: "succeeded", ticketId: dependent.id });
        const workersBefore = (yield* system.query.getSnapshot()).threads.filter(
          (thread) => thread.workflowRole === "implementation-worker",
        ).length;

        // Clearing the base takes its dependent down with it, and neither
        // starts until the run reaches them again in dependency order.
        yield* system.engine.dispatch({
          type: "thread.implementation-run.reset",
          commandId: commandId("clear-base-implementation"),
          threadId: sourceThreadId,
          runId: run.id,
          target: { kind: "ticket", ticketId: base.id, stage: "implementation" },
          createdAt: "2026-01-01T00:05:00.000Z",
        });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const current = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        const baseState = current?.ticketStates.find((state) => state.ticketId === base.id);
        expect(baseState?.status).toBe("blocked");
        expect(baseState?.workerResult).toBeNull();
        expect(baseState?.branch).not.toBeNull();
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-worker")
            .length,
        ).toBe(workersBefore);
      }),
    ),
  );

  it.effect("clearing a ticket stage leaves its branch and its earlier stages alone", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, ticket } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded", ticketId: ticket.id });

        const before = (yield* system.query.getSnapshot()).implementationRuns
          .find((entry) => entry.id === run.id)
          ?.ticketStates.find((state) => state.ticketId === ticket.id);

        yield* system.engine.dispatch({
          type: "thread.implementation-run.reset",
          commandId: commandId("clear-ticket-code-review"),
          threadId: sourceThreadId,
          runId: run.id,
          target: { kind: "ticket", ticketId: ticket.id, stage: "code-review" },
          createdAt: "2026-01-01T00:05:00.000Z",
        });
        yield* system.reactor.drain;

        const after = (yield* system.query.getSnapshot()).implementationRuns
          .find((entry) => entry.id === run.id)
          ?.ticketStates.find((state) => state.ticketId === ticket.id);
        expect(after?.codeReviewOutcome).toBeNull();
        expect(after?.branch).toBe(before?.branch);
        expect(after?.worktreePath).toBe(before?.worktreePath);
        expect(after?.workerResult?.commitSha).toBe(before?.workerResult?.commitSha);
      }),
    ),
  );

  it.effect("skips ticket App Review without provisioning a stack when its scope is empty", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system, {
            appReviewStrategy: "nested-workflow",
            tickets: [
              {
                ...planningTicket("TICKET-1"),
                appReviewEligible: true,
                appReviewPlanMarkdown: "Review the ticket.",
              },
            ],
          });
          yield* appendWorkerResult(system, {
            run,
            status: "succeeded",
            completeTicketReview: false,
          });

          const snapshot = yield* system.query.getSnapshot();
          expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(0);
          expect(snapshot.appReviewWorkflowRuns ?? []).toHaveLength(0);
          expect(snapshot.implementationRuns[0]?.ticketStates[0]).toMatchObject({
            status: "code-reviewing",
            appReviewOutcome: "skipped",
          });
        }),
      {
        serverSettings: {
          workflowStepReviewParts: [
            {
              workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
              stepWorkflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
              e2e: false,
              browser: false,
            },
          ],
        },
      },
    ),
  );

  it.effect("provisions a ticket stack for browser-only App Review", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { nestedRun } = yield* launchTicketAppReview(system);
          expect(nestedRun.appReviewScope).toBe("browser");
          expect(yield* Ref.get(system.autoCreateInputs)).toEqual([
            expect.objectContaining({
              worktreePath: "/tmp/implementation-reactor.worktrees/checkout-ticket-1",
            }),
          ]);
        }),
      {
        serverSettings: {
          workflowStepReviewParts: [
            {
              workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
              stepWorkflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
              e2e: false,
              browser: true,
            },
          ],
        },
      },
    ),
  );

  it.effect("skips ticket App Review when only project-wide E2E is enabled", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system, {
            appReviewStrategy: "nested-workflow",
            tickets: [
              {
                ...planningTicket("TICKET-1"),
                appReviewEligible: true,
                appReviewPlanMarkdown: "Review the ticket.",
              },
            ],
          });
          yield* appendWorkerResult(system, {
            run,
            status: "succeeded",
            completeTicketReview: false,
          });

          const snapshot = yield* system.query.getSnapshot();
          expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(0);
          expect(snapshot.appReviewWorkflowRuns ?? []).toHaveLength(0);
          expect(snapshot.implementationRuns[0]?.ticketStates[0]).toMatchObject({
            status: "code-reviewing",
            appReviewOutcome: "skipped",
          });
        }),
      {
        projectFile: { e2eCommands: ["vp test run e2e/checkout.test.ts"] },
        serverSettings: {
          workflowStepReviewParts: [
            {
              workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
              stepWorkflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
              e2e: true,
              browser: false,
            },
          ],
        },
      },
    ),
  );

  it.effect("keeps project-wide E2E out of a ticket browser review", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { nestedRun } = yield* launchTicketAppReview(system);
          expect(nestedRun.appReviewScope).toBe("browser");
          expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(1);
        }),
      {
        projectFile: { e2eCommands: ["vp test run e2e/checkout.test.ts"] },
        serverSettings: {
          workflowStepReviewParts: [
            {
              workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
              stepWorkflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
              e2e: true,
              browser: true,
            },
          ],
        },
      },
    ),
  );

  it.effect("a ticket App Review runs the cycles the step's budget asks for", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { nestedRun } = yield* launchTicketAppReview(system);
          expect(nestedRun.cycleBudget).toBe(3);
        }),
      {
        serverSettings: {
          workflowStepCycles: [
            {
              workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
              stepWorkflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
              maxCycles: 3,
            },
          ],
        },
      },
    ),
  );

  it.effect("a ticket App Review ignores the budget set for the run's own App Review", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          // The two steps run the same agent. A budget on the run's App Review
          // must not reach the per-ticket reviews inside the ticket waves.
          const { nestedRun } = yield* launchTicketAppReview(system);
          expect(nestedRun.cycleBudget).toBe(10);
        }),
      {
        serverSettings: {
          workflowStepCycles: [
            {
              workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
              maxCycles: 25,
            },
          ],
        },
      },
    ),
  );

  it.effect("keeps ticket scope on every App Review descendant", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { ticket, nestedRun } = yield* launchTicketAppReview(system);
        const snapshot = yield* system.query.getSnapshot();
        const scopedThreads = snapshot.threads.filter(
          (thread) =>
            thread.id === nestedRun.controllerThreadId ||
            thread.parentThreadId === nestedRun.controllerThreadId,
        );

        expect(scopedThreads.length).toBeGreaterThan(0);
        expect(
          scopedThreads.every(
            (thread) =>
              thread.workflowContext?.ticketScope.length === 1 &&
              thread.workflowContext.ticketScope[0] === ticket.id,
          ),
        ).toBe(true);
      }),
    ),
  );

  it.effect("reconnects a halted ticket to its manually rerun App Review thread", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, ticket, nestedRun } = yield* launchTicketAppReview(system);
        const failedAt = "2026-01-01T00:04:00.000Z";
        const { cycle, failure } = failedReviewRecoveryState(nestedRun, failedAt, "ticket");
        const failedRun = {
          ...nestedRun,
          status: "failed" as const,
          outcome: "failed" as const,
          activePhase: null,
          activeThreadId: null,
          failure,
          cycles: [
            {
              ...cycle,
              status: "failed" as const,
              reviewLaunchCount: 2,
              failure,
              completedAt: failedAt,
            },
          ],
          updatedAt: failedAt,
          completedAt: failedAt,
        };
        yield* system.engine.dispatch({
          type: "thread.app-review-workflow.update",
          commandId: commandId("fail-ticket-review-before-recovery"),
          threadId: nestedRun.controllerThreadId,
          run: failedRun,
          createdAt: failedAt,
        });
        yield* system.reactor.drain;

        let current = (yield* system.query.getSnapshot()).implementationRuns.find(
          (candidate) => candidate.id === run.id,
        );
        expect(current?.status).toBe("needs-human-attention");
        expect(current?.automationHalt).toMatchObject({
          stage: "app-review",
          category: "review-blocked",
          ticketId: ticket.id,
        });
        const failedState = current?.ticketStates.find(
          (candidate) => candidate.ticketId === ticket.id,
        );
        expect(failedState?.appReviewOutcome).toBe("failed");
        expect(failedState?.warningMarkdown).toContain("exhausted its 2 phase launches");

        yield* system.engine.dispatch({
          type: "thread.app-review-workflow.update",
          commandId: commandId("recover-ticket-review-in-place"),
          threadId: nestedRun.controllerThreadId,
          run: {
            ...failedRun,
            status: "running",
            outcome: null,
            activePhase: "review",
            activeThreadId: cycle.reviewerThreadId,
            failure: null,
            cycles: [
              {
                ...cycle,
                status: "reviewing",
                recoveryContinuationCount: 0,
                failure: null,
                completedAt: null,
              },
            ],
            updatedAt: "2026-01-01T00:05:00.000Z",
            completedAt: null,
          },
          createdAt: "2026-01-01T00:05:00.000Z",
        });
        yield* system.reactor.drain;

        current = (yield* system.query.getSnapshot()).implementationRuns.find(
          (candidate) => candidate.id === run.id,
        );
        const state = current?.ticketStates.find((candidate) => candidate.ticketId === ticket.id);
        expect(current?.status).toBe("running");
        expect(current?.automationHalt).toBeNull();
        expect(state?.status).toBe("app-reviewing");
        expect(state?.appReviewWorkflowRunId).toBe(nestedRun.id);
        expect(state?.appReviewOutcome).toBeNull();
        expect(state?.warningMarkdown).toBeNull();
      }),
    ),
  );

  it.effect("keeps back-to-back ticket App Review reruns in the same run", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, tickets } = yield* launchRun(system, {
          appReviewStrategy: "nested-workflow",
          tickets: [
            {
              ...planningTicket("TICKET-1"),
              appReviewEligible: true,
              appReviewPlanMarkdown: "Review the first page.",
            },
            {
              ...planningTicket("TICKET-2"),
              appReviewEligible: true,
              appReviewPlanMarkdown: "Review the second page.",
            },
          ],
        });
        for (const ticket of tickets) {
          yield* appendWorkerResult(system, {
            run,
            status: "succeeded",
            ticketId: ticket.id,
            completeTicketReview: false,
          });
        }
        let snapshot = yield* system.query.getSnapshot();
        const oldReviewIds = new Map(
          snapshot.implementationRuns
            .find((entry) => entry.id === run.id)
            ?.ticketStates.map((state) => [state.ticketId, state.appReviewWorkflowRunId] as const),
        );
        for (const ticket of tickets) {
          const oldReviewId = oldReviewIds.get(ticket.id);
          const nested = (snapshot.appReviewWorkflowRuns ?? []).find(
            (entry) => entry.id === oldReviewId,
          );
          if (nested === undefined) throw new Error(`Nested review missing for ${ticket.id}.`);
          yield* system.engine.dispatch({
            type: "thread.app-review-workflow.update",
            commandId: commandId(`fail-old-review-${ticket.id}`),
            threadId: nested.controllerThreadId,
            run: {
              ...nested,
              status: "failed",
              outcome: "failed",
              activePhase: null,
              activeThreadId: null,
              failure: {
                reason: "review-blocked",
                phase: "review",
                cycleNumber: 1,
                detailMarkdown: "The provider stopped.",
                failedAt: "2026-01-01T00:04:00.000Z",
              },
              updatedAt: "2026-01-01T00:04:00.000Z",
              completedAt: "2026-01-01T00:04:00.000Z",
            },
            createdAt: "2026-01-01T00:04:00.000Z",
          });
        }
        yield* system.reactor.drain;

        for (const ticket of tickets) {
          yield* system.engine.dispatch({
            type: "thread.implementation-run.rerun",
            commandId: commandId(`rerun-review-${ticket.id}`),
            threadId: sourceThreadId,
            runId: run.id,
            target: { kind: "ticket", ticketId: ticket.id, stage: "app-review" },
            createdAt: "2026-01-01T00:05:00.000Z",
          });
        }
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        const current = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(current?.status).toBe("running");
        for (const ticket of tickets) {
          const state = current?.ticketStates.find((entry) => entry.ticketId === ticket.id);
          expect(state?.status).toBe("app-reviewing");
          expect(state?.attemptCount).toBe(1);
          expect(state?.appReviewWorkflowRunId).not.toBe(oldReviewIds.get(ticket.id));
          expect(
            (snapshot.appReviewWorkflowRuns ?? []).find(
              (entry) => entry.id === state?.appReviewWorkflowRunId,
            )?.status,
          ).toBe("running");
        }
      }),
    ),
  );

  it.effect("hands unfinished App Review repairs to the replacement worker", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, ticket, nestedRun } = yield* launchTicketAppReview(system);
        const failedAt = "2026-01-01T00:04:00.000Z";
        const failure = {
          reason: "fixer-failed" as const,
          phase: "fixing" as const,
          cycleNumber: 1,
          detailMarkdown:
            "App Review fixer completed without the required app-review-fix-result directive.",
          failedAt,
        };
        yield* system.engine.dispatch({
          type: "thread.app-review-workflow.update",
          commandId: commandId("fail-ticket-review-with-partial-repair"),
          threadId: nestedRun.controllerThreadId,
          run: {
            ...nestedRun,
            status: "failed",
            outcome: "failed",
            activePhase: null,
            activeThreadId: null,
            failure,
            cyclesUsed: 1,
            cycles: [
              {
                cycleNumber: 1,
                status: "failed",
                reviewId: AppReviewId.make("app-review-partial-repair"),
                reviewerThreadId: ThreadId.make("thread-app-review-reviewer-partial"),
                reviewLaunchCount: 1,
                planningLaunchCount: 1,
                fixingLaunchCount: 2,
                supersededThreadIds: [ThreadId.make("thread-app-review-fixer-old")],
                reviewVerdict: "failed",
                actionableFindingsMarkdown: "The evidence table loses its selected row.",
                planId: "app-review-repair-tickets:partial",
                plannerThreadId: ThreadId.make("thread-app-review-planner-partial"),
                plannerTurnId: null,
                fixerThreadId: ThreadId.make("thread-app-review-fixer-partial"),
                repairTickets: [
                  {
                    key: "AR-1",
                    parentTicketKey: ticket.id,
                    title: "Preserve the selected evidence row",
                    bodyMarkdown:
                      "Add a focused regression test and keep the selected row visible.",
                    dependencyKeys: [],
                  },
                ],
                ticketingTurnId: null,
                fixResult: null,
                failure,
                workspaceRevision: nestedRun.workspaceRevision,
                startedAt: now,
                completedAt: failedAt,
              },
            ],
            updatedAt: failedAt,
            completedAt: failedAt,
          },
          createdAt: failedAt,
        });
        yield* system.reactor.drain;
        yield* Ref.set(system.dirtyWorkerWorktrees, true);

        yield* system.engine.dispatch({
          type: "thread.implementation-run.rerun",
          commandId: commandId("rerun-dirty-ticket-app-review"),
          threadId: sourceThreadId,
          runId: run.id,
          target: { kind: "ticket", ticketId: ticket.id, stage: "app-review" },
          createdAt: "2026-01-01T00:05:00.000Z",
        });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const workers = snapshot.threads.filter(
          (thread) => thread.workflowRole === "implementation-worker",
        );
        const replacementPrompt = workers[0]?.messages.at(-1)?.text;
        expect(workers).toHaveLength(1);
        expect(replacementPrompt).toContain("Why the prior stage stopped:");
        expect(replacementPrompt).toContain("Unfinished App Review repair tickets");
        expect(replacementPrompt).toContain("AR-1 · Preserve the selected evidence row");
        expect(replacementPrompt).toContain(
          "Add a focused regression test and keep the selected row visible.",
        );
      }),
    ),
  );

  it.effect("clearing a ticket stops the App Review it was waiting on", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, ticket, nestedRun } = yield* launchTicketAppReview(system);

        yield* system.engine.dispatch({
          type: "thread.implementation-run.reset",
          commandId: commandId("clear-ticket-with-app-review"),
          threadId: sourceThreadId,
          runId: run.id,
          target: { kind: "ticket", ticketId: ticket.id, stage: "implementation" },
          createdAt: "2026-01-01T00:05:00.000Z",
        });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const cleared = snapshot.implementationRuns
          .find((entry) => entry.id === run.id)
          ?.ticketStates.find((state) => state.ticketId === ticket.id);
        expect(cleared?.status).toBe("blocked");
        expect(cleared?.appReviewWorkflowRunId ?? null).toBeNull();
        expect(
          (snapshot.appReviewWorkflowRuns ?? []).find((entry) => entry.id === nestedRun.id)?.status,
        ).toBe("failed");
      }),
    ),
  );

  it.effect("a cleared ticket ignores a late update from the App Review it disowned", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, ticket, nestedRun } = yield* launchTicketAppReview(system);

        yield* system.engine.dispatch({
          type: "thread.implementation-run.reset",
          commandId: commandId("clear-ticket-before-late-update"),
          threadId: sourceThreadId,
          runId: run.id,
          target: { kind: "ticket", ticketId: ticket.id, stage: "implementation" },
          createdAt: "2026-01-01T00:05:00.000Z",
        });
        yield* system.reactor.drain;

        // The controller was mid-cycle when the clear landed, so its next write
        // still reports the review as running, from a pre-clear snapshot.
        yield* system.engine.dispatch({
          type: "thread.app-review-workflow.update",
          commandId: commandId("late-app-review-update"),
          threadId: nestedRun.controllerThreadId,
          run: { ...nestedRun, status: "running", updatedAt: "2026-01-01T00:04:59.000Z" },
          createdAt: "2026-01-01T00:05:01.000Z",
        });
        yield* system.reactor.drain;

        const state = (yield* system.query.getSnapshot()).implementationRuns
          .find((entry) => entry.id === run.id)
          ?.ticketStates.find((entry) => entry.ticketId === ticket.id);
        expect(state?.status).toBe("blocked");
        expect(state?.appReviewWorkflowRunId ?? null).toBeNull();
      }),
    ),
  );

  it.effect("stage recovery reaps an App Review its ticket stopped waiting on", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run, ticket, nestedRun } = yield* launchTicketAppReview(system);

        // A ticket rewound while its review was in flight, the way one was
        // before clearing cancelled it: the review keeps running with nothing
        // pointing at it.
        const current = (yield* system.query.getSnapshot()).implementationRuns.find(
          (entry) => entry.id === run.id,
        )!;
        yield* system.engine.dispatch({
          type: "thread.implementation-run.update",
          commandId: commandId("orphan-ticket-app-review"),
          threadId: sourceThreadId,
          run: {
            ...current,
            ticketStates: current.ticketStates.map((state) =>
              state.ticketId === ticket.id
                ? { ...state, status: "blocked" as const, appReviewWorkflowRunId: null }
                : state,
            ),
          },
          createdAt: "2026-01-01T00:05:00.000Z",
        });
        yield* system.reactor.drain;

        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        expect(
          (snapshot.appReviewWorkflowRuns ?? []).find((entry) => entry.id === nestedRun.id)?.status,
        ).toBe("failed");
        expect(
          snapshot.implementationRuns
            .find((entry) => entry.id === run.id)
            ?.ticketStates.find((state) => state.ticketId === ticket.id)?.status,
        ).toBe("blocked");
      }),
    ),
  );

  it.effect(
    "stage recovery applies a terminal ticket App Review whose update was interrupted",
    () =>
      withSystem((system) =>
        Effect.gen(function* () {
          const { run, ticket, nestedRun } = yield* launchTicketAppReview(system);
          const completedAt = "2026-01-01T00:05:00.000Z";
          const reviewedHead = (yield* system.query.getSnapshot()).implementationRuns
            .find((entry) => entry.id === run.id)
            ?.ticketStates.find((state) => state.ticketId === ticket.id)?.workerResult?.commitSha;
          if (reviewedHead === null || reviewedHead === undefined) {
            throw new Error("Reviewed ticket HEAD missing.");
          }
          yield* system.engine.dispatch({
            type: "thread.app-review-workflow.update",
            commandId: commandId("pass-ticket-app-review-before-interruption"),
            threadId: nestedRun.controllerThreadId,
            run: {
              ...nestedRun,
              status: "passed",
              cyclesUsed: 1,
              activePhase: null,
              activeThreadId: null,
              outcome: "passed",
              finalHeadSha: reviewedHead,
              updatedAt: completedAt,
              completedAt,
            },
            createdAt: completedAt,
          });
          yield* system.reactor.drain;

          const afterNormalContinuation = yield* system.query.getSnapshot();
          const continuedRun = afterNormalContinuation.implementationRuns.find(
            (entry) => entry.id === run.id,
          )!;
          const reviewersBeforeRecovery = afterNormalContinuation.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          ).length;
          yield* system.engine.dispatch({
            type: "thread.implementation-run.update",
            commandId: commandId("restore-interrupted-ticket-app-review-result"),
            threadId: sourceThreadId,
            run: {
              ...continuedRun,
              ticketStates: continuedRun.ticketStates.map((state) =>
                state.ticketId === ticket.id
                  ? {
                      ...state,
                      status: "app-reviewing" as const,
                      appReviewWorkflowRunId: nestedRun.id,
                      appReviewOutcome: null,
                      codeReviewThreadId: null,
                      codeReviewOutcome: null,
                    }
                  : state,
              ),
              updatedAt: "2026-01-01T00:05:01.000Z",
            },
            createdAt: "2026-01-01T00:05:01.000Z",
          });
          yield* system.reactor.drain;

          yield* system.reactor.recoverIncompleteStages();
          yield* system.reactor.drain;

          const snapshot = yield* system.query.getSnapshot();
          const recovered = snapshot.implementationRuns
            .find((entry) => entry.id === run.id)
            ?.ticketStates.find((state) => state.ticketId === ticket.id);
          expect(recovered?.status).toBe("code-reviewing");
          expect(recovered?.appReviewOutcome).toBe("passed");
          expect(recovered?.workerResult?.commitSha).toBe(reviewedHead);
          expect(recovered?.codeReviewThreadId).not.toBeNull();
          expect(
            snapshot.threads.filter(
              (thread) => thread.workflowRole === "implementation-code-reviewer",
            ),
          ).toHaveLength(reviewersBeforeRecovery + 1);
        }),
      ),
  );

  it.effect("re-running a ticket merges a dependency that moved under it", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { tickets, run } = yield* launchRun(system, {
          tickets: [
            {
              key: "TICKET-1",
              title: "Base",
              bodyMarkdown: "Base work.",
              plannedFileChanges: [{ path: "src/base.ts", action: "create" }],
              dependencyKeys: [],
            },
            {
              key: "TICKET-2",
              title: "Dependent",
              bodyMarkdown: "Dependent work.",
              plannedFileChanges: [{ path: "src/dependent.ts", action: "create" }],
              dependencyKeys: ["TICKET-1"],
            },
          ],
        });
        const base = tickets.find((ticket) => ticket.key === "TICKET-1")!;
        const dependent = tickets.find((ticket) => ticket.key === "TICKET-2")!;
        yield* appendWorkerResult(system, { run, status: "succeeded", ticketId: base.id });
        yield* appendWorkerResult(system, { run, status: "succeeded", ticketId: dependent.id });

        const snapshot = yield* system.query.getSnapshot();
        const dependentState = snapshot.implementationRuns
          .find((entry) => entry.id === run.id)
          ?.ticketStates.find((state) => state.ticketId === dependent.id);
        const baseState = snapshot.implementationRuns
          .find((entry) => entry.id === run.id)
          ?.ticketStates.find((state) => state.ticketId === base.id);
        const mergesBefore = yield* Ref.get(system.mergeRefInputs);

        yield* system.engine.dispatch({
          type: "thread.implementation-run.rerun",
          commandId: commandId("rerun-dependent-implementation"),
          threadId: sourceThreadId,
          runId: run.id,
          target: { kind: "ticket", ticketId: dependent.id, stage: "implementation" },
          createdAt: "2026-01-01T00:05:00.000Z",
        });
        yield* system.reactor.drain;

        // The worktree is still there, so nothing re-branches it off the base.
        // Merging that base is the only way its repairs reach the ticket.
        const merges = (yield* Ref.get(system.mergeRefInputs)).slice(mergesBefore.length);
        expect(merges).toContainEqual({
          cwd: dependentState?.worktreePath,
          refName: baseState?.workerResult?.commitSha,
        });
      }),
    ),
  );

  it.effect("defers dependency merges to a restarted worker with inherited changes", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { tickets, run } = yield* launchRun(system, {
          tickets: [
            {
              key: "TICKET-1",
              title: "Base",
              bodyMarkdown: "Base work.",
              plannedFileChanges: [{ path: "src/base.ts", action: "create" }],
              dependencyKeys: [],
            },
            {
              key: "TICKET-2",
              title: "Dependent",
              bodyMarkdown: "Dependent work.",
              plannedFileChanges: [{ path: "src/dependent.ts", action: "create" }],
              dependencyKeys: ["TICKET-1"],
            },
          ],
        });
        const base = tickets.find((ticket) => ticket.key === "TICKET-1")!;
        const dependent = tickets.find((ticket) => ticket.key === "TICKET-2")!;
        yield* appendWorkerResult(system, { run, status: "succeeded", ticketId: base.id });
        yield* appendWorkerResult(system, { run, status: "succeeded", ticketId: dependent.id });

        const beforeRestart = yield* system.query.getSnapshot();
        const baseState = beforeRestart.implementationRuns
          .find((entry) => entry.id === run.id)
          ?.ticketStates.find((state) => state.ticketId === base.id);
        const mergesBefore = yield* Ref.get(system.mergeRefInputs);
        yield* Ref.set(system.dirtyWorkerWorktrees, true);

        yield* system.engine.dispatch({
          type: "thread.implementation-run.rerun",
          commandId: commandId("rerun-dirty-dependent-implementation"),
          threadId: sourceThreadId,
          runId: run.id,
          target: { kind: "ticket", ticketId: dependent.id, stage: "implementation" },
          createdAt: "2026-01-01T00:05:00.000Z",
        });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const restarted = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        const dependentWorkers = snapshot.threads.filter(
          (thread) =>
            thread.workflowRole === "implementation-worker" &&
            thread.workflowContext?.ticketScope.includes(dependent.id),
        );
        const latestWorker = dependentWorkers.at(-1);
        expect(
          restarted?.ticketStates.find((state) => state.ticketId === dependent.id)?.status,
        ).toBe("running");
        expect((yield* Ref.get(system.mergeRefInputs)).slice(mergesBefore.length)).toEqual([]);
        expect(latestWorker?.messages.at(-1)?.text).toContain(
          `dependency merges deferred until inherited changes are reconciled: ${baseState?.workerResult?.commitSha}`,
        );
        expect(latestWorker?.messages.at(-1)?.text).toContain(
          "merge each deferred dependency ref in order before completing the ticket",
        );
      }),
    ),
  );

  it.effect("re-running a failed ticket resets only that ticket's generation", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { tickets, run } = yield* launchRun(system, {
          tickets: [
            {
              key: "TICKET-1",
              title: "Base",
              bodyMarkdown: "Base work.",
              plannedFileChanges: [{ path: "src/base.ts", action: "create" }],
              dependencyKeys: [],
            },
            {
              key: "TICKET-2",
              title: "Dependent",
              bodyMarkdown: "Dependent work.",
              plannedFileChanges: [{ path: "src/dependent.ts", action: "create" }],
              dependencyKeys: ["TICKET-1"],
            },
          ],
        });
        const base = tickets.find((ticket) => ticket.key === "TICKET-1")!;
        const dependent = tickets.find((ticket) => ticket.key === "TICKET-2")!;
        yield* appendWorkerResult(system, { run, status: "failed", ticketId: base.id });

        let snapshot = yield* system.query.getSnapshot();
        let current = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(current?.ticketStates.find((s) => s.ticketId === base.id)?.status).toBe("failed");
        expect(current?.ticketStates.find((s) => s.ticketId === dependent.id)?.status).toBe(
          "failed",
        );
        const workersBefore = snapshot.threads.filter(
          (thread) => thread.workflowRole === "implementation-worker",
        ).length;

        yield* system.engine.dispatch({
          type: "thread.implementation-run.rerun",
          commandId: commandId("rerun-ticket-implementation"),
          threadId: sourceThreadId,
          runId: run.id,
          target: { kind: "ticket", ticketId: base.id, stage: "implementation" },
          createdAt: "2026-01-01T00:05:00.000Z",
        });
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        current = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        const baseState = current?.ticketStates.find((s) => s.ticketId === base.id);
        expect(baseState?.status).toBe("running");
        expect(baseState?.workerResult).toBeNull();
        expect(baseState?.warningMarkdown ?? null).toBeNull();
        // The dependent carried no work of its own, so it waits again instead
        // of staying failed forever.
        expect(current?.ticketStates.find((s) => s.ticketId === dependent.id)?.status).toBe(
          "blocked",
        );
        expect(current?.status).toBe("running");
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-worker")
            .length,
        ).toBe(workersBefore);
      }),
    ),
  );

  it.effect("re-running the run's code review starts a fresh reviewer thread", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* passAppReview(system, run);
        const seen = new Set<string>();
        const firstReviewer = yield* nextThreadForRole(
          system,
          "implementation-code-reviewer",
          seen,
        );
        yield* appendCodeReviewResult(system, {
          run,
          threadId: firstReviewer.id,
          status: "clean",
          tag: "rerun-clean",
        });

        yield* system.engine.dispatch({
          type: "thread.implementation-run.rerun",
          commandId: commandId("rerun-run-code-review"),
          threadId: sourceThreadId,
          runId: run.id,
          target: { kind: "run", stage: "code-review" },
          createdAt: "2026-01-01T00:05:00.000Z",
        });
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const current = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(current?.status).toBe("code-reviewing");
        expect(current?.activeCodeReviewThreadId).not.toBe(firstReviewer.id);
        expect(
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          ).length,
        ).toBe(2);
      }),
    ),
  );

  it.effect("restarts a canceled final code review from its preserved integrated HEAD", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system, {
            appReviewStrategy: "nested-workflow",
          });
          yield* appendWorkerResult(system, { run, status: "succeeded" });
          yield* passMergeGate(system, run);

          let snapshot = yield* system.query.getSnapshot();
          const beforeCancel = snapshot.implementationRuns.find((entry) => entry.id === run.id);
          const firstReviewerId = beforeCancel?.activeCodeReviewThreadId;
          if (firstReviewerId === null || firstReviewerId === undefined) {
            throw new Error("Code reviewer missing before cancellation.");
          }
          const workerCount = snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-worker",
          ).length;
          const reviewerCount = snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          ).length;

          yield* system.engine.dispatch({
            type: "thread.implementation-run.cancel",
            commandId: commandId("cancel-during-final-code-review"),
            threadId: sourceThreadId,
            runId: run.id,
            reason: "Stop a looping final review.",
            createdAt: "2026-01-01T00:04:00.000Z",
          });
          yield* system.reactor.drain;
          expect(
            (yield* system.query.getSnapshot()).implementationRuns.find(
              (entry) => entry.id === run.id,
            )?.status,
          ).toBe("canceled");

          yield* system.engine.dispatch({
            type: "thread.implementation-run.rerun",
            commandId: commandId("rerun-canceled-final-code-review"),
            threadId: sourceThreadId,
            runId: run.id,
            target: { kind: "run", stage: "code-review" },
            createdAt: "2026-01-01T00:05:00.000Z",
          });
          yield* system.reactor.drain;

          snapshot = yield* system.query.getSnapshot();
          const restarted = snapshot.implementationRuns.find((entry) => entry.id === run.id);
          expect(restarted?.status).toBe("code-reviewing");
          expect(restarted?.activeCodeReviewThreadId).not.toBe(firstReviewerId);
          expect(restarted?.activeCodeReviewHeadSha).toBe(restarted?.integrationHeadSha);
          expect(restarted?.codeReviewAttemptCount).toBe(2);
          expect(restarted?.ticketStates.every((state) => state.status === "succeeded")).toBe(true);
          expect(
            snapshot.threads.filter((thread) => thread.workflowRole === "implementation-worker"),
          ).toHaveLength(workerCount);
          expect(
            snapshot.threads.filter(
              (thread) => thread.workflowRole === "implementation-code-reviewer",
            ),
          ).toHaveLength(reviewerCount + 1);
        }),
      {
        serverSettings: {
          workflowStepReviewParts: [
            {
              workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
              e2e: false,
              browser: false,
            },
          ],
        },
      },
    ),
  );

  it.effect("a re-run with a model pins that step and starts it on the pinned model", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system, { modelSelection: claudeParentSelection });
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* passAppReview(system, run);
        const seen = new Set<string>();
        const firstReviewer = yield* nextThreadForRole(
          system,
          "implementation-code-reviewer",
          seen,
        );
        yield* appendCodeReviewResult(system, {
          run,
          threadId: firstReviewer.id,
          status: "clean",
          tag: "rerun-model-clean",
        });
        const pinned: ModelSelection = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-sonnet-5",
        };

        yield* system.engine.dispatch({
          type: "thread.implementation-run.rerun",
          commandId: commandId("rerun-with-model"),
          threadId: sourceThreadId,
          runId: run.id,
          target: { kind: "run", stage: "code-review" },
          modelSelection: pinned,
          createdAt: "2026-01-01T00:05:00.000Z",
        });
        yield* system.reactor.drain;

        const secondReviewer = yield* nextThreadForRole(
          system,
          "implementation-code-reviewer",
          seen,
        );
        expect(secondReviewer.modelSelection).toEqual(pinned);
        // The pin is durable, so every later agent of that step follows it too.
        const snapshot = yield* system.query.getSnapshot();
        const root = snapshot.threads.find((thread) => thread.id === sourceThreadId);
        expect(root?.workflowStepModels).toContainEqual(
          expect.objectContaining({ modelSelection: pinned }),
        );
      }),
    ),
  );
  it.effect("refuses a re-run while the stage it targets is still running", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* passAppReview(system, run);
        const reviewer = yield* nextThreadForRole(
          system,
          "implementation-code-reviewer",
          new Set<string>(),
        );
        yield* system.engine.dispatch({
          type: "thread.session.set",
          commandId: commandId("rerun-guard-reviewer-running"),
          threadId: reviewer.id,
          session: {
            threadId: reviewer.id,
            status: "running",
            providerName: "codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-01-01T00:04:00.000Z",
          },
          createdAt: "2026-01-01T00:04:00.000Z",
        });
        yield* system.reactor.drain;

        const result = yield* system.engine.dispatch({
          type: "thread.implementation-run.rerun",
          commandId: commandId("rerun-while-live"),
          threadId: sourceThreadId,
          runId: run.id,
          target: { kind: "run", stage: "code-review" },
          createdAt: "2026-01-01T00:05:00.000Z",
        });
        expect(result.outcome).toMatchObject({
          type: "rejected",
          reasonCode: "live-stage-owner",
        });
        if (result.outcome?.type !== "rejected") throw new Error("Expected a typed rejection.");
        expect(result.outcome.detail).toContain(reviewer.id);

        const snapshot = yield* system.query.getSnapshot();
        expect(
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          ).length,
        ).toBe(1);
      }),
    ),
  );

  /**
   * A repair the run itself commits moves the orchestrator branch past the sha
   * integration recorded. Reading that as a tampered workspace halted runs for
   * doing exactly what the workflow asked of them, and nothing re-recorded the
   * sha, so both the gate and App Review refused from then on.
   */
  const qaReviewingRun = (
    run: OrchestrationImplementationRun,
    integrationHeadSha: string | null,
  ): OrchestrationImplementationRun => ({
    ...run,
    status: "qa-reviewing",
    orchestratorBranch: "main",
    orchestratorWorktreePath: "/tmp/implementation-reactor-review",
    integrationHeadSha,
    activeAppReviewHeadSha: null,
    activeAppReviewThreadId: null,
    activeCodeReviewHeadSha: null,
    activeCodeReviewThreadId: null,
    appDevStack: {
      status: "ready",
      stackId: "stack-1",
      stackStatus: "running",
      frontendUrl: "http://127.0.0.1:5173",
      frontendServiceName: "frontend",
      displayName: "Implementation test",
      lastErrorMarkdown: null,
      requestedAt: now,
      updatedAt: now,
    },
    updatedAt: now,
  });

  it.effect("reviews an integration head its own repair advanced", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system, { appReviewStrategy: "nested-workflow" });
        yield* system.engine.dispatch({
          type: "thread.implementation-run.update",
          commandId: commandId("advanced-app-review-head"),
          threadId: sourceThreadId,
          // HEAD resolves to "def456"; the run still records the pre-repair sha.
          run: qaReviewingRun(run, "abc123"),
          createdAt: now,
        });

        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const reviewed = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(reviewed?.automationHalt).toBeNull();
        expect(reviewed?.status).not.toBe("needs-human-attention");
        expect(reviewed?.integrationHeadSha).toBe("def456");
      }),
    ),
  );

  it.effect("halts App Review when the integrated commit is no longer in history", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system, { appReviewStrategy: "nested-workflow" });
          yield* system.engine.dispatch({
            type: "thread.implementation-run.update",
            commandId: commandId("rewritten-app-review-head"),
            threadId: sourceThreadId,
            run: qaReviewingRun(run, "abc123"),
            createdAt: now,
          });

          yield* system.reactor.recoverIncompleteStages();
          yield* system.reactor.drain;

          const snapshot = yield* system.query.getSnapshot();
          const halted = snapshot.implementationRuns.find((entry) => entry.id === run.id);
          expect(halted?.status).toBe("needs-human-attention");
          expect(halted?.retryableFailure).toMatchObject({ stage: "app-review" });
          expect(halted?.retryableFailure?.detail).toContain("recorded integrated HEAD");
        }),
      // The branch was rewritten, so the recorded sha no longer descends to HEAD.
      { nonAncestorCommitSha: "abc123" },
    ),
  );

  it.effect("re-records the integration head the Merge Gate accepts", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* system.engine.dispatch({
          type: "thread.implementation-run.update",
          commandId: commandId("advanced-merge-gate-head"),
          threadId: sourceThreadId,
          run: {
            ...run,
            status: "validating",
            orchestratorBranch: "main",
            orchestratorWorktreePath: "/tmp/implementation-reactor-review",
            integrationHeadSha: "abc123",
            activeValidationKind: "integration",
            activeValidationHeadSha: null,
            activeValidatorThreadId: null,
            validatedHeadSha: null,
            updatedAt: now,
          },
          createdAt: now,
        });

        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const gated = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(gated?.automationHalt).toBeNull();
        expect(gated?.status).toBe("validating");
        expect(gated?.integrationHeadSha).toBe("def456");
        expect(gated?.activeValidationHeadSha).toBe("def456");
      }),
    ),
  );

  it.effect("halts a ticket Code Review that has no launch budget left", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        let snapshot = yield* system.query.getSnapshot();
        const launched = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        if (launched === undefined) throw new Error("Expected the launched run.");
        // The stage only starts for a ticket that already has a worker and a
        // worktree, so the launch has to have got that far for this to prove
        // anything. Leave the implementation claim alone: changing it is what
        // the decider calls a stale update.
        expect(launched.ticketStates[0]?.workerThreadId).not.toBeNull();
        expect(launched.ticketStates[0]?.worktreePath).not.toBeNull();

        // A reviewer that is gone plus a spent budget is what a lost provider
        // session leaves behind. Starting the stage would claim a third launch,
        // which the decider refuses, so the sweep used to ask forever.
        yield* system.engine.dispatch({
          type: "thread.implementation-run.update",
          commandId: commandId("spent-code-review-budget"),
          threadId: sourceThreadId,
          run: {
            ...launched,
            status: "running",
            ticketStates: launched.ticketStates.map((state, index) =>
              index === 0
                ? {
                    ...state,
                    status: "code-reviewing" as const,
                    codeReviewThreadId: null,
                    codeReviewLaunchCount: IMPLEMENTATION_STAGE_MAX_LAUNCHES,
                    updatedAt: now,
                  }
                : state,
            ),
            updatedAt: now,
          },
          createdAt: now,
        });

        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        const halted = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(halted?.status).toBe("needs-human-attention");
        expect(halted?.automationHalt).toMatchObject({
          stage: "code-review",
          category: "retry-exhausted",
        });
        expect(halted?.automationHalt?.detail).toContain("Code Review launch budget");
      }),
    ),
  );

  it.effect("re-drives a run left stranded mid-integration", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        const strandedAt = DateTime.formatIso(DateTime.makeUnsafe(0));

        // Integration runs inline in the reactor, so a run parked here is one
        // whose reactor died mid-merge. Only the stall window can tell, and
        // before this nothing in the sweep drove `integrating` at all.
        yield* system.engine.dispatch({
          type: "thread.implementation-run.update",
          commandId: commandId("stranded-integration"),
          threadId: sourceThreadId,
          run: {
            ...run,
            status: "integrating",
            integrationHeadSha: null,
            activeValidatorThreadId: null,
            updatedAt: strandedAt,
          },
          createdAt: now,
        });
        yield* TestClock.adjust(Duration.minutes(6));

        yield* system.reactor.recoverIncompleteStages();
        yield* system.reactor.drain;

        const snapshot = yield* system.query.getSnapshot();
        const resumed = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(resumed?.updatedAt).not.toBe(strandedAt);
      }),
    ),
  );
});
