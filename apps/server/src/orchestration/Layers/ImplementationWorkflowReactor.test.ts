import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  DevReviewId,
  EventId,
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
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import { describe } from "vite-plus/test";

import { AppDevStackManager } from "../../appDevStack/AppDevStackManager.ts";
import { ServerConfig } from "../../config.ts";
import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { layerTest as serverSettingsLayerTest } from "../../serverSettings.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import * as RepositoryIdentityResolver from "../../project/RepositoryIdentityResolver.ts";
import { ImplementationWorkflowReactorLive } from "./ImplementationWorkflowReactor.ts";
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
  readonly createWorktreeInputs: Ref.Ref<ReadonlyArray<VcsCreateWorktreeInput>>;
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

function makeTestLayer(
  calls: ImplementationCalls,
  serverSettings: DeepPartial<ServerSettings> = {},
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
      Layer.provide(
        Layer.mock(GitWorkflowService)({
          createWorktree: (input) =>
            Ref.update(calls.createWorktreeInputs, (inputs) => [...inputs, input]).pipe(
              Effect.as({
                worktree: {
                  path: input.path ?? "/tmp/generated-worktree",
                  refName: input.newRefName ?? "HEAD",
                },
              }),
            ),
          createOrOpenChangeRequest: () =>
            Ref.update(calls.createOrOpenChangeRequestCount, (count) => count + 1).pipe(
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
            Ref.update(calls.autoCreateInputs, (inputs) => [...inputs, input]).pipe(
              Effect.as({
                created: true,
                frontendUrl: "http://127.0.0.1:5173",
                frontendServiceName: "frontend",
                stack: {
                  id: "stack-1",
                  uuid: "stack-uuid-1",
                  userId: "user-1",
                  worktreePath: input.worktreePath,
                  composePath: "/tmp/compose.yml",
                  displayName: input.displayName,
                  description: null,
                  status: "running" as const,
                  services: null,
                  serviceCount: 0,
                  lastError: null,
                  errorCount: 0,
                  createdAt: now,
                  updatedAt: now,
                },
              }),
            ),
        }),
      ),
    ),
  );
}

function withSystem<A, E>(
  use: (system: ImplementationSystem) => Effect.Effect<A, E>,
  options?: { readonly serverSettings?: DeepPartial<ServerSettings> },
) {
  return Effect.gen(function* () {
    const autoCreateInputs = yield* Ref.make<
      ReadonlyArray<{ readonly worktreePath: string; readonly displayName: string }>
    >([]);
    const createOrOpenChangeRequestCount = yield* Ref.make(0);
    const createWorktreeInputs = yield* Ref.make<ReadonlyArray<VcsCreateWorktreeInput>>([]);
    const calls = {
      autoCreateInputs,
      createOrOpenChangeRequestCount,
      createWorktreeInputs,
    } satisfies ImplementationCalls;

    return yield* Effect.scoped(
      Effect.gen(function* () {
        const engine = yield* OrchestrationEngineService;
        const query = yield* ProjectionSnapshotQuery;
        const reactor = yield* ImplementationWorkflowReactor;
        yield* reactor.start();
        return yield* use({
          ...calls,
          engine,
          query,
          reactor,
        });
      }),
    ).pipe(Effect.provide(makeTestLayer(calls, options?.serverSettings)));
  });
}

function seedPlanning(
  system: ImplementationSystem,
  options?: { readonly modelSelection?: ModelSelection },
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
      tickets: [
        {
          key: "TICKET-1",
          title: "Checkout tracer",
          bodyMarkdown: "Implement checkout tracer.",
          dependencyKeys: [],
        },
      ],
      createdAt: now,
    });
    const snapshot = yield* system.query.getSnapshot();
    const ticket = snapshot.threads.find((thread) => thread.id === sourceThreadId)?.planningWorkflow
      ?.tickets[0];
    if (!ticket) throw new Error("Ticket missing.");
    return { spec, ticket };
  });
}

function launchRun(
  system: ImplementationSystem,
  options?: { readonly modelSelection?: ModelSelection },
) {
  return Effect.gen(function* () {
    const { ticket, spec } = yield* seedPlanning(system, options);
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
    return { ticket, run };
  });
}

function appendWorkerResult(
  system: ImplementationSystem,
  input: {
    readonly run: OrchestrationImplementationRun;
    readonly status: "succeeded" | "failed";
  },
) {
  return Effect.gen(function* () {
    const state = input.run.ticketStates[0];
    if (!state?.workerThreadId || !state.branch || !state.worktreePath) {
      throw new Error("Worker was not started.");
    }
    yield* system.engine.dispatch({
      type: "thread.activity.append",
      commandId: commandId(`worker-${input.status}`),
      threadId: state.workerThreadId,
      activity: {
        id: eventId(`worker-${input.status}`),
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
          commitSha: input.status === "succeeded" ? "def456" : null,
          validations: [],
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
    const validator = snapshot.threads.find(
      (thread) => thread.workflowRole === "implementation-validator",
    );
    if (!validator) throw new Error("Validator missing.");
    yield* system.engine.dispatch({
      type: "thread.activity.append",
      commandId: commandId("merge-gate-pass"),
      threadId: validator.id,
      activity: {
        id: eventId("merge-gate-pass"),
        tone: "info",
        kind: "implementation-merge-gate-result",
        summary: "Merge gate passed",
        payload: {
          type: "implementation-merge-gate-result",
          runId: run.id,
          status: "passed",
          validations: [],
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
    const reviewId = reviewingRun?.devReviewIds[0];
    if (reviewId === undefined) throw new Error("Dev review missing.");
    yield* system.engine.dispatch({
      type: "thread.dev-review.update",
      commandId: commandId("dev-review-pass"),
      threadId: run.orchestratorThreadId,
      reviewId: DevReviewId.make(reviewId),
      status: "passed",
      updatedAt: "2026-01-01T00:00:03.000Z",
      createdAt: "2026-01-01T00:00:03.000Z",
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
  },
) {
  return Effect.gen(function* () {
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

function appendCodeReviewFixResult(
  system: ImplementationSystem,
  input: {
    readonly run: OrchestrationImplementationRun;
    readonly threadId: ThreadId;
    readonly tag: string;
  },
) {
  return Effect.gen(function* () {
    yield* system.engine.dispatch({
      type: "thread.activity.append",
      commandId: commandId(`code-review-fix-${input.tag}`),
      threadId: input.threadId,
      activity: {
        id: eventId(`code-review-fix-${input.tag}`),
        tone: "info",
        kind: "implementation-fix-result",
        summary: "Implementation fix succeeded",
        payload: {
          type: "implementation-fix-result",
          runId: input.run.id,
          status: "succeeded",
          validations: [],
          notesMarkdown: "Applied code review findings.",
        },
        turnId: null,
        createdAt: "2026-01-01T00:00:05.000Z",
      },
      createdAt: "2026-01-01T00:00:05.000Z",
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

describe("ImplementationWorkflowReactor", () => {
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
        expect(workerThread?.parentThreadId).toBe(run.orchestratorThreadId);
      }),
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
              validations: [
                {
                  command: "vp check",
                  status: "passed",
                  outputMarkdown: "ok",
                  completedAt: "2026-01-01T00:00:02.000Z",
                },
              ],
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
        expect(createOrOpenChangeRequestCount).toBe(1);
        expect(codeReviewingRun?.status).toBe("code-reviewing");
        expect(codeReviewingRun?.codeReviewAttemptCount).toBe(1);
        expect(codeReviewingRun?.changeRequest?.url).toBe("https://example.test/pr/1");

        const reviewerThread = snapshot.threads.find(
          (thread) => thread.workflowRole === "implementation-code-reviewer",
        );
        expect(reviewerThread).toBeDefined();
        expect(reviewerThread?.parentThreadId).toBe(run.orchestratorThreadId);

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
      }),
    ),
  );

  it.effect("cycles code review findings through the fixer and re-reviews the change request", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* passDevReview(system, run);

        const seenReviewers = new Set<string>();
        const seenFixers = new Set<string>();

        const firstReviewer = yield* nextThreadForRole(
          system,
          "implementation-code-reviewer",
          seenReviewers,
        );
        yield* appendCodeReviewResult(system, {
          run,
          threadId: firstReviewer.id,
          status: "findings",
          tag: "cycle-1",
        });

        let snapshot = yield* system.query.getSnapshot();
        const fixingRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(fixingRun?.status).toBe("code-review-fixing");

        const fixer = yield* nextThreadForRole(system, "implementation-fixer", seenFixers);
        expect(fixer.title).toBe("Fix code review findings");
        yield* appendCodeReviewFixResult(system, { run, threadId: fixer.id, tag: "cycle-1" });

        snapshot = yield* system.query.getSnapshot();
        const reReviewingRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        const createOrOpenChangeRequestCount = yield* Ref.get(
          system.createOrOpenChangeRequestCount,
        );
        expect(createOrOpenChangeRequestCount).toBe(2);
        expect(reReviewingRun?.status).toBe("code-reviewing");
        expect(reReviewingRun?.codeReviewAttemptCount).toBe(2);

        const secondReviewer = yield* nextThreadForRole(
          system,
          "implementation-code-reviewer",
          seenReviewers,
        );
        yield* appendCodeReviewResult(system, {
          run,
          threadId: secondReviewer.id,
          status: "clean",
          tag: "cycle-2",
        });

        snapshot = yield* system.query.getSnapshot();
        const completedRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(completedRun?.status).toBe("completed");
      }),
    ),
  );

  it.effect("blocks the run when code review findings persist after five cycles", () =>
    withSystem((system) =>
      Effect.gen(function* () {
        const { run } = yield* launchRun(system);
        yield* appendWorkerResult(system, { run, status: "succeeded" });
        yield* passMergeGate(system, run);
        yield* passDevReview(system, run);

        const seenReviewers = new Set<string>();
        const seenFixers = new Set<string>();

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
            tag: `max-cycle-${cycle}`,
          });
          if (cycle < 5) {
            const fixer = yield* nextThreadForRole(system, "implementation-fixer", seenFixers);
            yield* appendCodeReviewFixResult(system, {
              run,
              threadId: fixer.id,
              tag: `max-cycle-${cycle}`,
            });
          }
        }

        const snapshot = yield* system.query.getSnapshot();
        const blockedRun = snapshot.implementationRuns.find((entry) => entry.id === run.id);
        expect(blockedRun?.status).toBe("needs-human-attention");
        expect(blockedRun?.codeReviewAttemptCount).toBe(5);
        const orchestratorThread = snapshot.threads.find(
          (thread) => thread.id === run.orchestratorThreadId,
        );
        const attentionActivity = orchestratorThread?.activities.find(
          (activity) => activity.kind === "implementation-workflow.needs-human-attention",
        );
        expect(attentionActivity).toBeDefined();
      }),
    ),
  );

  it.effect("hardlocks the browser dev review thread to codex gpt-5.5 at extra-high effort", () =>
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
          model: "gpt-5.5",
          options: [{ id: "reasoningEffort", value: "xhigh" }],
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
            requestedModel: "gpt-5.5",
          });
        }),
      { serverSettings: { providers: { codex: { enabled: false } } } },
    ),
  );
});
