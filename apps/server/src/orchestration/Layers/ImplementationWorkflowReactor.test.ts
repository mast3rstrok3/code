import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  AppDevStackError,
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  DevReviewId,
  EventId,
  GitCommandError,
  IMPLEMENTATION_RUN_MAX_QA_ATTEMPTS,
  MessageId,
  ProviderInstanceId,
  ProjectId,
  ThreadId,
  type ModelSelection,
  type OrchestrationImplementationRun,
  type ServerSettings,
  type VcsCreateWorktreeInput,
} from "@t3tools/contracts";
import { type DeepPartial } from "@t3tools/shared/Struct";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import { describe } from "vite-plus/test";

import { AppDevStackManager } from "../../appDevStack/AppDevStackManager.ts";
import { ServerConfig } from "../../config.ts";
import { GitWorkflowService, type GitMergeRefInput } from "../../git/GitWorkflowService.ts";
import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import {
  fastFeatureBuildContractProblems,
  ImplementationWorkflowReactorLive,
} from "./ImplementationWorkflowReactor.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
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
const projectId = ProjectId.make("project-implementation-reactor");
const sourceThreadId = ThreadId.make("thread-implementation-source");

interface ImplementationCalls {
  readonly autoCreateInputs: Ref.Ref<
    ReadonlyArray<{ readonly worktreePath: string; readonly displayName: string }>
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
  readonly mergeRefInputs: Ref.Ref<ReadonlyArray<GitMergeRefInput>>;
  readonly localStatusCount: Ref.Ref<number>;
  readonly frontendProbeUrls: Ref.Ref<ReadonlyArray<string>>;
}

/**
 * Holds `autoCreate` open so a test can observe what the reactor has already done by the time the
 * app dev stack starts provisioning. `entered` resolves as the stack call begins; the reactor then
 * parks on `release`.
 */
interface AutoCreateGate {
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
  conflictMergeRefName?: string,
  failMergeRefName?: string,
  resolvedCommitSha = "def456",
  dirtySourceStatusChecks = 0,
  autoCreateFrontendUrls?: ReadonlyArray<string | null>,
  sourceRefName = "main",
  autoCreateGate?: AutoCreateGate,
  autoCreateStackStatus: "running" | "starting" | "error" = "running",
  frontendProbeStatus = 200,
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
  );

  return Layer.mergeAll(
    coreLayer,
    ImplementationWorkflowReactorLive.pipe(
      Layer.provide(coreLayer),
      Layer.provide(serverSettingsLayerTest(serverSettings)),
      // The reactor probes the frontend URL before Dev Review; answer it without real network I/O.
      Layer.provide(
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Ref.update(calls.frontendProbeUrls, (urls) => [...urls, request.url]).pipe(
              Effect.as(
                HttpClientResponse.fromWeb(
                  request,
                  new Response("ok", { status: frontendProbeStatus }),
                ),
              ),
            ),
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
            ),
          resolveCommit: (input) =>
            Effect.gen(function* () {
              if (input.ref === "HEAD" && input.cwd.includes(".worktrees/")) {
                const created = yield* Ref.get(calls.createWorktreeInputs);
                if (!created.some((candidate) => candidate.path === input.cwd)) {
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
                    resolvedCommitSha === "def456" ? `${input.ref}@commit` : resolvedCommitSha,
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
                      ? `${branch}@commit`
                      : resolvedCommitSha,
                };
              }
              return { commitSha: resolvedCommitSha };
            }),
          localStatus: (input) =>
            Effect.all([
              Ref.get(calls.createWorktreeInputs),
              Ref.updateAndGet(calls.localStatusCount, (count) => count + 1),
            ]).pipe(
              Effect.map(([created, statusCheck]) => ({
                isRepo: true,
                hasPrimaryRemote: true,
                isDefaultRef: input.cwd === "/tmp/implementation-reactor",
                refName:
                  created.find((candidate) => candidate.path === input.cwd)?.newRefName ??
                  (input.cwd === "/tmp/implementation-reactor" ? sourceRefName : "main"),
                hasWorkingTreeChanges:
                  input.cwd === "/tmp/implementation-reactor" &&
                  statusCheck <= dirtySourceStatusChecks,
                workingTree: { files: [], insertions: 0, deletions: 0 },
              })),
            ),
          listChangedFiles: () => Effect.succeed([]),
          isAncestor: () => Effect.succeed(true),
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
          autoCreate: (input) =>
            Ref.updateAndGet(calls.autoCreateInputs, (inputs) => [...inputs, input]).pipe(
              Effect.tap(() =>
                autoCreateGate === undefined
                  ? Effect.void
                  : Deferred.succeed(autoCreateGate.entered, undefined).pipe(
                      Effect.andThen(Deferred.await(autoCreateGate.release)),
                    ),
              ),
              Effect.flatMap((inputs) => {
                const configuredFrontendUrl = autoCreateFrontendUrls?.[inputs.length - 1];
                const frontendUrl =
                  configuredFrontendUrl === undefined
                    ? "http://127.0.0.1:5173"
                    : configuredFrontendUrl;
                return failAutoCreate
                  ? Effect.fail(
                      new AppDevStackError({
                        operation: "autoCreate",
                        reason: "request_failed",
                        message: "compose file missing",
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
    /** HTTP status the frontend URL answers with when the reactor probes it before Dev Review. */
    readonly frontendProbeStatus?: number;
  },
) {
  return Effect.gen(function* () {
    const autoCreateInputs = yield* Ref.make<
      ReadonlyArray<{ readonly worktreePath: string; readonly displayName: string }>
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
    const mergeRefInputs = yield* Ref.make<ReadonlyArray<GitMergeRefInput>>([]);
    const localStatusCount = yield* Ref.make(0);
    const frontendProbeUrls = yield* Ref.make<ReadonlyArray<string>>([]);
    const calls = {
      autoCreateInputs,
      createOrOpenChangeRequestCount,
      createOrOpenChangeRequestInputs,
      createWorktreeInputs,
      mergeRefInputs,
      localStatusCount,
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
          options?.conflictMergeRefName,
          options?.failMergeRefName,
          options?.resolvedCommitSha,
          options?.dirtySourceStatusChecks,
          options?.autoCreateFrontendUrls,
          options?.sourceRefName,
          options?.autoCreateGate,
          options?.autoCreateStackStatus,
          options?.frontendProbeStatus,
        ),
      ),
    );
  });
}

function seedPlanning(
  system: ImplementationSystem,
  options?: {
    readonly modelSelection?: ModelSelection;
    readonly tickets?: ReadonlyArray<{
      readonly key: string;
      readonly title: string;
      readonly bodyMarkdown: string;
      readonly plannedFileChanges: ReadonlyArray<{
        readonly path: string;
        readonly action: "create" | "update" | "delete";
      }>;
      readonly dependencyKeys: ReadonlyArray<string>;
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
      branch: "main",
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

function launchRun(system: ImplementationSystem, options?: Parameters<typeof seedPlanning>[1]) {
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
      createdAt: now,
    });
    yield* system.reactor.drain;
    const snapshot = yield* system.query.getSnapshot();
    const run = snapshot.implementationRuns[0];
    if (!run) throw new Error("Run missing.");
    return { ticket, tickets, run };
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
          notesMarkdown: input.status,
          reportedAt: "2026-01-01T00:00:01.000Z",
        },
        turnId: null,
        createdAt: "2026-01-01T00:00:01.000Z",
      },
      createdAt: "2026-01-01T00:00:01.000Z",
    });
    yield* system.reactor.drain;
  });
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
  });
}

function passDevReview(system: ImplementationSystem, run: OrchestrationImplementationRun) {
  return Effect.gen(function* () {
    const snapshot = yield* system.query.getSnapshot();
    const reviewingRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
    const reviewId = reviewingRun?.devReviewIds.at(-1);
    if (reviewId === undefined) throw new Error("Dev review missing.");
    yield* system.engine.dispatch({
      type: "thread.dev-review.update",
      commandId: commandId(`dev-review-pass-${reviewId}`),
      threadId: run.orchestratorThreadId,
      reviewId: DevReviewId.make(reviewId),
      status: "passed",
      updatedAt: "2026-01-01T00:00:03.000Z",
      createdAt: "2026-01-01T00:00:03.000Z",
    });
    yield* system.reactor.drain;
  });
}

function failDevReview(system: ImplementationSystem, run: OrchestrationImplementationRun) {
  return Effect.gen(function* () {
    const snapshot = yield* system.query.getSnapshot();
    const reviewingRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
    const reviewId = reviewingRun?.devReviewIds.at(-1);
    if (reviewId === undefined) throw new Error("Dev review missing.");
    yield* system.engine.dispatch({
      type: "thread.dev-review.update",
      commandId: commandId(`dev-review-fail-${reviewId}`),
      threadId: run.orchestratorThreadId,
      reviewId: DevReviewId.make(reviewId),
      status: "failed",
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
          notesMarkdown: "Applied Browser Dev Review findings.",
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
    readonly validations?: ReadonlyArray<ReturnType<typeof requiredValidations>[number]>;
  },
) {
  return Effect.gen(function* () {
    const commitSha = input.commitSha ?? (input.status === "findings" ? "def456" : undefined);
    const validations =
      input.validations ??
      (input.status === "findings" ? requiredValidations("2026-01-01T00:00:04.000Z") : []);
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
          status: input.status,
          ...(commitSha === undefined ? {} : { commitSha }),
          validations,
          reportMarkdown: "## Standards\n- finding\n\n## Spec\n- finding",
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
    if (!thread) throw new Error(`No new ${role} thread found.`);
    seen.add(thread.id);
    return thread;
  });
}

const claudeParentSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-4-8",
};

function dispatchFastFeatureLaunch(system: ImplementationSystem) {
  return Effect.gen(function* () {
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
      branch: "main",
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
      orchestratorBranch: "fast-feature/fast-checkout",
      orchestratorWorktreePath: "/tmp/implementation-reactor.worktrees/fast-checkout",
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
    return run;
  });
}

describe("ImplementationWorkflowReactor", () => {
  it.effect("sets up Fast feature Build and starts Dev Review only after a verified result", () =>
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
        expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(1);

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

        // Build reports success but names its validation commands differently, so the run is
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
              validations: [
                {
                  command: "vp check (run as `pnpm check`)",
                  status: "passed",
                  outputMarkdown: "ok",
                  completedAt: "2026-01-01T00:00:02.000Z",
                },
              ],
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
        // The reason has to name the exact string that was expected and what arrived instead,
        // otherwise Build cannot tell a naming problem from a real validation failure.
        expect(retried?.messages.at(-1)?.text).toContain(
          "Missing a passing result under this exact command string:",
        );
        expect(retried?.messages.at(-1)?.text).toContain("- `vp run typecheck`");
        expect(retried?.messages.at(-1)?.text).toContain(
          "- `vp check (run as `pnpm check`)` (passed)",
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
          expect(prompt).toContain(`- \`${command}\``);
        }
        expect(prompt).toContain("`validations[].command` **exactly** as written above");

        // The embedded example is generated from the run's own commands, not hardcoded.
        const fence = /```json\s*([\s\S]*?)```/.exec(prompt)?.[1] ?? "";
        const example = JSON.parse(fence) as {
          readonly validations: ReadonlyArray<{ readonly command: string }>;
        };
        expect(example.validations.map((validation) => validation.command)).toEqual([
          ...run.launchSummary.validationCommands,
        ]);
      }),
    ),
  );

  it.effect("blocks Dev Review instead of reviewing a stack that is not running", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const run = yield* launchFastFeatureRun(system);
          expect(run.appDevStack.stackStatus).toBe("starting");
          // A stack the controller reports as `starting` must not be cached as resolved.
          expect(run.appDevStack.status).not.toBe("ready");

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
        }),
      { autoCreateStackStatus: "starting" },
    ),
  );

  it.effect("blocks Dev Review when the stack reports running but the URL is down", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const run = yield* launchFastFeatureRun(system);
          // The controller is happy: stack running, URL resolved, cached as ready. This is the
          // state that used to skip every check and send reviewer after reviewer at a dead edge.
          expect(run.appDevStack.status).toBe("ready");
          expect(run.appDevStack.stackStatus).toBe("running");

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
          const blocked = snapshot.implementationRuns[0];
          expect(blocked?.status).toBe("needs-human-attention");
          expect(blocked?.retryableFailure?.stage).toBe("app-dev-stack");
          expect(blocked?.retryableFailure?.detail).toContain("returned HTTP 503");
          // The probe has to actually have gone to the reviewer's URL.
          expect(yield* Ref.get(system.frontendProbeUrls)).toContain("http://127.0.0.1:5173");
          // No reviewer launched, no Dev Review attempt burned.
          expect(
            snapshot.threads.filter(
              (thread) => thread.workflowRole === "implementation-qa-reviewer",
            ),
          ).toHaveLength(0);
          expect(blocked?.qaAttemptCount).toBe(0);
        }),
      { frontendProbeStatus: 503 },
    ),
  );

  it.effect("does not relaunch Dev Review while its reviewer is idle between turns", () =>
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
        if (!reviewer) throw new Error("Dev Review thread missing.");
        expect(snapshot.implementationRuns[0]?.qaAttemptCount).toBe(1);

        // The reviewer finishes a turn and its session falls back to `ready`. That is an idle
        // reviewer, not a dead one.
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
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-qa-reviewer"),
        ).toHaveLength(1);
        expect(snapshot.implementationRuns[0]?.qaAttemptCount).toBe(1);

        // A reviewer whose session actually died is still recovered.
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
            updatedAt: "2026-01-01T00:00:04.000Z",
          },
          createdAt: "2026-01-01T00:00:04.000Z",
        });
        yield* system.reactor.start();
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-qa-reviewer"),
        ).toHaveLength(2);
        expect(snapshot.implementationRuns[0]?.qaAttemptCount).toBe(2);
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

          yield* system.engine.dispatch({
            type: "thread.implementation-run.update",
            commandId: commandId("fast-run-blocked"),
            threadId: sourceThreadId,
            run: {
              ...run,
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
                stage: "dev-review",
                detail: "Dev Review could not run.",
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

  it.effect("hands the plan to Build before the app dev stack finishes provisioning", () =>
    Effect.gen(function* () {
      const gate: AutoCreateGate = {
        entered: yield* Deferred.make<void>(),
        release: yield* Deferred.make<void>(),
      };
      yield* withSystem(
        (system) =>
          Effect.gen(function* () {
            yield* dispatchFastFeatureLaunch(system);
            const drained = yield* Effect.forkChild(system.reactor.drain);
            // Resolves the moment the stack starts provisioning; the reactor is parked inside
            // `autoCreate` for the assertions below.
            yield* Deferred.await(gate.entered);

            const snapshot = yield* system.query.getSnapshot();
            const implementer = snapshot.threads.find(
              (thread) => thread.workflowRole === "fast-feature-implementer",
            );
            if (!implementer) throw new Error("Fast feature implementer missing.");
            expect(implementer.messages.at(-1)?.text).toContain("# Fast checkout");
            expect(implementer.messages.at(-1)?.role).toBe("user");
            expect(snapshot.implementationRuns[0]?.appDevStack.status).toBe("ensuring");

            yield* Deferred.succeed(gate.release, undefined);
            yield* Fiber.join(drained);
            const settled = yield* system.query.getSnapshot();
            expect(settled.implementationRuns[0]?.appDevStack.status).toBe("ready");
          }),
        { autoCreateGate: gate },
      );
    }),
  );

  it.effect("reports a failed app dev stack on Build without blocking the run", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const run = yield* launchFastFeatureRun(system);
          expect(run.status).toBe("running");
          expect(run.appDevStack.status).toBe("failed");

          let snapshot = yield* system.query.getSnapshot();
          const implementer = snapshot.threads.find(
            (thread) => thread.workflowRole === "fast-feature-implementer",
          );
          if (!implementer) throw new Error("Fast feature implementer missing.");
          expect(implementer.messages.at(-1)?.text).toContain("# Fast checkout");
          const failures = implementer.activities.filter(
            (activity) => activity.kind === "fast-feature.app-dev-stack-failed",
          );
          expect(failures).toHaveLength(1);
          expect(failures[0]?.tone).toBe("error");

          // Startup recovery must leave a run that already reached Build alone — re-driving it
          // would provision a second stack and repeat the notice.
          yield* system.reactor.start();
          yield* system.reactor.drain;
          snapshot = yield* system.query.getSnapshot();
          expect(
            snapshot.threads
              .find((thread) => thread.workflowRole === "fast-feature-implementer")
              ?.activities.filter(
                (activity) => activity.kind === "fast-feature.app-dev-stack-failed",
              ),
          ).toHaveLength(1);
          expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(1);
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

  it.effect("refreshes a stack with no URL before starting Browser Dev Review", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const run = yield* launchFastFeatureRun(system);
          let snapshot = yield* system.query.getSnapshot();
          // A stack with no frontend URL is not serving, so it is not `ready` — it stays
          // `ensuring` and gets re-provisioned before Dev Review.
          expect(snapshot.implementationRuns[0]?.appDevStack).toMatchObject({
            status: "ensuring",
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
          expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(2);
          expect(snapshot.implementationRuns[0]?.appDevStack.frontendUrl).toBe(
            "https://fast-checkout-dev.nightingale-ai.com",
          );
          expect(reviewThread?.messages.at(-1)?.text).toContain(
            "Feature URL: https://fast-checkout-dev.nightingale-ai.com",
          );
        }),
      {
        autoCreateFrontendUrls: [null, "https://fast-checkout-dev.nightingale-ai.com"],
      },
    ),
  );

  it.effect("blocks Fast feature before Dev Review when both dev-stack attempts fail", () =>
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

          const blocked = (yield* system.query.getSnapshot()).implementationRuns[0];
          expect(blocked?.status).toBe("needs-human-attention");
          expect(blocked?.retryableFailure?.stage).toBe("app-dev-stack");
          expect(blocked?.devReviewIds).toHaveLength(0);
          expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(2);
        }),
      { failAutoCreate: true },
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

        yield* retry(3);
        const third = yield* failBuild(4);
        expect(third?.retryableFailure?.attemptCount).toBe(3);
        expect(third?.retryableFailure?.maxAttempts).toBe(3);
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

  it.effect("launches a Fast feature run from a dirty source and warns instead of blocking", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          yield* launchFastFeatureRun(system);
          const snapshot = yield* system.query.getSnapshot();

          // Uncommitted work is not a reason to refuse: the worktree is created
          // from the pinned commit, so the dirty files simply are not in the run.
          expect(snapshot.implementationRuns[0]?.status).toBe("running");
          expect(snapshot.implementationRuns[0]?.retryableFailure).toBeNull();
          expect(yield* Ref.get(system.createWorktreeInputs)).toHaveLength(1);
          expect(
            snapshot.threads.filter((thread) => thread.workflowRole === "fast-feature-implementer"),
          ).toHaveLength(1);

          // The warning lands on the source thread, where the user is reading.
          const dirtyActivity = snapshot.threads
            .find((thread) => thread.id === sourceThreadId)
            ?.activities.find((activity) => activity.kind === "fast-feature.source-dirty-ignored");
          expect(dirtyActivity).toBeDefined();
          expect(dirtyActivity?.payload).toMatchObject({
            pinnedCommit: snapshot.implementationRuns[0]?.pinnedCommit,
          });
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

  it.effect("blocks the run when final integration fails without conflicts", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          yield* appendWorkerResult(system, { run, status: "succeeded" });

          const snapshot = yield* system.query.getSnapshot();
          expect(
            snapshot.implementationRuns.find((candidate) => candidate.id === run.id)?.status,
          ).toBe("needs-human-attention");
          expect(
            snapshot.threads.filter((thread) => thread.workflowRole === "implementation-validator"),
          ).toHaveLength(0);
        }),
      { failMergeRefName: "implementation/checkout-ticket-1" },
    ),
  );

  it.effect("blocks the run when worker worktree creation fails at launch", () =>
    withSystem(
      (system) =>
        Effect.gen(function* () {
          const { run } = yield* launchRun(system);
          const snapshot = yield* system.query.getSnapshot();
          const workerThread = snapshot.threads.find(
            (thread) => thread.workflowRole === "implementation-worker",
          );

          expect(run.status).toBe("needs-human-attention");
          expect(workerThread).toBeUndefined();
          const orchestratorThread = snapshot.threads.find(
            (thread) => thread.id === run.orchestratorThreadId,
          );
          expect(
            orchestratorThread?.activities.some(
              (activity) => activity.kind === "implementation-workflow.needs-human-attention",
            ),
          ).toBe(true);
        }),
      { failCreateWorktreeAfter: 1 },
    ),
  );

  it.effect("blocks the run when a worker fails", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "failed" });

        const snapshot = yield* system.query.getSnapshot();
        const updated = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(updated?.status).toBe("needs-human-attention");
        expect(updated?.ticketStates[0]?.status).toBe("failed");
      }),
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
          "Missing worktree-local dependencies are setup work, not a validation failure.",
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
        expect(reviewingRun?.devReviewIds).toHaveLength(1);
        const reviewThread = snapshot.threads.find(
          (thread) => thread.workflowRole === "implementation-qa-reviewer",
        );
        expect(reviewThread?.messages.at(-1)?.text).toContain("Feature URL: http://127.0.0.1:5173");

        yield* system.engine.dispatch({
          type: "thread.dev-review.update",
          commandId: commandId("dev-review-pass"),
          threadId: run.orchestratorThreadId,
          reviewId: DevReviewId.make(reviewingRun!.devReviewIds[0]!),
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

        yield* appendCodeReviewResult(system, {
          run,
          threadId: reviewerThread!.id,
          status: "clean",
          tag: "clean",
        });

        snapshot = yield* system.query.getSnapshot();
        const completedRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(completedRun?.status).toBe("completed");
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

  it.effect("blocks browser review for retry when app stack creation fails", () =>
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
          expect(reviewingRun?.status).toBe("needs-human-attention");
          expect(reviewingRun?.retryableFailure?.stage).toBe("app-dev-stack");
          expect(reviewingRun?.devReviewIds).toHaveLength(0);
          const orchestrator = snapshot.threads.find(
            (thread) => thread.id === run.orchestratorThreadId,
          );
          expect(
            orchestrator?.activities.some(
              (activity) => activity.kind === "implementation-workflow.needs-human-attention",
            ),
          ).toBe(true);
          expect(
            snapshot.threads.some((thread) => thread.workflowRole === "implementation-qa-reviewer"),
          ).toBe(false);

          for (let attempt = 2; attempt <= 4; attempt += 1) {
            yield* system.engine.dispatch({
              type: "thread.implementation-run.retry",
              commandId: commandId(`app-stack-retry-${attempt}`),
              threadId: sourceThreadId,
              runId: run.id,
              createdAt: `2026-01-01T00:00:0${attempt}.000Z`,
            });
            yield* system.reactor.drain;
          }
          snapshot = yield* system.query.getSnapshot();
          expect(
            snapshot.implementationRuns.find((entry) => entry.id === run.id)?.retryableFailure
              ?.attemptCount,
          ).toBe(4);
          // One provisioning attempt at launch plus one per browser-review ensure.
          expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(5);

          yield* system.engine.dispatch({
            type: "thread.implementation-run.retry",
            commandId: commandId("app-stack-retry-exhausted"),
            threadId: sourceThreadId,
            runId: run.id,
            createdAt: "2026-01-01T00:00:06.000Z",
          });
          yield* system.reactor.drain;
          expect(yield* Ref.get(system.autoCreateInputs)).toHaveLength(5);
        }),
      { failAutoCreate: true },
    ),
  );

  it.effect("reruns the merge gate and downstream reviews after browser fixes", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* failDevReview(system, run);
        yield* appendBrowserFixResult(system, { run, validations: requiredValidations() });

        let snapshot = yield* system.query.getSnapshot();
        const updated = snapshot.implementationRuns.find((candidate) => candidate.id === run.id);
        expect(updated?.status).toBe("validating");
        expect(updated?.devReviewIds).toHaveLength(1);
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-validator"),
        ).toHaveLength(2);
        expect(yield* Ref.get(system.mergeRefInputs)).toHaveLength(1);

        yield* passMergeGate(system, run);
        snapshot = yield* system.query.getSnapshot();
        expect(
          snapshot.implementationRuns.find((candidate) => candidate.id === run.id)?.status,
        ).toBe("qa-reviewing");
      }),
    ),
  );

  it.effect("makes browser fixes with missing validation results retryable", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* failDevReview(system, run);
        yield* appendBrowserFixResult(system, { run, validations: [] });

        const snapshot = yield* system.query.getSnapshot();
        const updated = snapshot.implementationRuns.find((candidate) => candidate.id === run.id);
        expect(updated?.status).toBe("needs-human-attention");
        expect(updated?.retryableFailure?.stage).toBe("fixer");
        expect(updated?.devReviewIds).toHaveLength(1);
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-validator"),
        ).toHaveLength(1);
      }),
    ),
  );

  it.effect("retries an interrupted browser fixer instead of terminally blocking the run", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* failDevReview(system, run);

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
        expect(interrupted?.status).toBe("needs-human-attention");
        expect(interrupted?.retryableFailure?.stage).toBe("fixer");

        yield* system.engine.dispatch({
          type: "thread.implementation-run.retry",
          commandId: commandId("browser-fix-interrupted-retry"),
          threadId: sourceThreadId,
          runId: run.id,
          createdAt: "2026-01-01T00:00:05.000Z",
        });
        yield* system.reactor.drain;

        snapshot = yield* system.query.getSnapshot();
        const retried = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(retried?.status).toBe("fixing");
        // The failure record survives the resume so repeat failures accumulate
        // toward maxAttempts; only a stage success clears it.
        expect(retried?.retryableFailure?.stage).toBe("fixer");
        expect(retried?.retryableFailure?.attemptCount).toBe(1);
        expect(retried?.activeFixerThreadId).not.toBe(firstFixer.id);
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
        yield* failDevReview(system, run);

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

  it.effect("continues to code review when the browser review exhausts every attempt", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);

        let snapshot = yield* system.query.getSnapshot();
        const reviewingRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        if (reviewingRun === undefined) throw new Error("Reviewing run missing.");
        yield* system.engine.dispatch({
          type: "thread.implementation-run.update",
          commandId: commandId("exhaust-browser-review-attempts"),
          threadId: sourceThreadId,
          run: { ...reviewingRun, qaAttemptCount: IMPLEMENTATION_RUN_MAX_QA_ATTEMPTS },
          createdAt: "2026-01-01T00:00:03.000Z",
        });
        yield* failDevReview(system, run);

        snapshot = yield* system.query.getSnapshot();
        const exhausted = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        // The unpassed dev review is recorded, but the run proceeds instead of blocking.
        expect(exhausted?.devReviewExhaustedAt).not.toBeNull();
        expect(exhausted?.status).toBe("code-reviewing");
        expect(exhausted?.retryableFailure).toBeNull();
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-fixer"),
        ).toHaveLength(0);

        const orchestratorThread = snapshot.threads.find(
          (thread) => thread.id === run.orchestratorThreadId,
        );
        const exhaustedActivity = orchestratorThread?.activities.find(
          (activity) => activity.kind === "implementation-browser-review-exhausted",
        );
        expect(exhaustedActivity?.tone).toBe("error");

        // Publication still happens, and the change request records the unpassed dev review.
        const reviewer = yield* nextThreadForRole(
          system,
          "implementation-code-reviewer",
          new Set<string>(),
        );
        yield* appendCodeReviewResult(system, {
          run,
          threadId: reviewer.id,
          status: "clean",
          tag: "after-exhausted-dev-review",
        });

        snapshot = yield* system.query.getSnapshot();
        const publishedRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(publishedRun?.status).toBe("completed");
        expect(yield* Ref.get(system.createOrOpenChangeRequestCount)).toBe(1);
        const publishInputs = yield* Ref.get(system.createOrOpenChangeRequestInputs);
        expect(publishInputs.at(-1)?.pullRequestBodyNote).toMatch(/did not pass/);
        expect(publishInputs.at(-1)?.commitMessage).toMatch(/did not pass/);
      }),
    ),
  );

  it.effect("publishes the change request from the single code review fix pass", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* passDevReview(system, run);

        const seenReviewers = new Set<string>();
        const reviewer = yield* nextThreadForRole(
          system,
          "implementation-code-reviewer",
          seenReviewers,
        );
        // The reviewer fixed its own findings and committed them, so publication follows directly.
        yield* appendCodeReviewResult(system, {
          run,
          threadId: reviewer.id,
          status: "findings",
          tag: "single-pass",
        });

        const snapshot = yield* system.query.getSnapshot();
        const completedRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(completedRun?.status).toBe("completed");
        expect(completedRun?.codeReviewAttemptCount).toBe(1);
        expect(completedRun?.codeReviewedHeadSha).toBe("def456");
        expect(yield* Ref.get(system.createOrOpenChangeRequestCount)).toBe(1);
        // No re-review and no dedicated code-review fixer thread.
        expect(
          snapshot.threads.filter(
            (thread) => thread.workflowRole === "implementation-code-reviewer",
          ),
        ).toHaveLength(1);
        expect(
          snapshot.threads.filter((thread) => thread.workflowRole === "implementation-fixer"),
        ).toHaveLength(0);
      }),
    ),
  );

  it.effect("blocks when the code review fix pass skips a required validation", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* passDevReview(system, run);

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
        const blockedRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(blockedRun?.status).toBe("needs-human-attention");
        expect(blockedRun?.retryableFailure?.stage).toBe("code-review");
        expect(yield* Ref.get(system.createOrOpenChangeRequestCount)).toBe(0);
      }),
    ),
  );

  it.effect("hardlocks the browser dev review thread to codex gpt-5.6-sol at high effort", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system, { modelSelection: claudeParentSelection });
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);

        const snapshot = yield* system.query.getSnapshot();
        const reviewThread = snapshot.threads.find(
          (thread) => thread.workflowRole === "implementation-qa-reviewer",
        );
        expect(reviewThread?.modelSelection).toEqual({
          instanceId: "codex",
          model: "gpt-5.6-sol",
          options: [{ id: "reasoningEffort", value: "high" }],
        });

        const workerThread = snapshot.threads.find(
          (thread) => thread.workflowRole === "implementation-worker",
        );
        expect(workerThread?.modelSelection).toEqual(claudeParentSelection);
      }),
    ),
  );

  it.effect("falls back to the parent selection when no codex instance is enabled", () =>
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
          const fallbackActivity = orchestratorThread?.activities.find(
            (activity) => activity.kind === "implementation-workflow.model-hardlock-fallback",
          );
          expect(fallbackActivity).toBeDefined();
          expect(fallbackActivity?.tone).toBe("info");
          expect(fallbackActivity?.payload).toMatchObject({
            runId: run.id,
            requestedDriver: "codex",
            requestedModel: "gpt-5.6-sol",
          });
        }),
      { serverSettings: { providers: { codex: { enabled: false } } } },
    ),
  );
});
