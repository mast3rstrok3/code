import { assert, describe, it } from "@effect/vitest";
import {
  PlanId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationV2ServerCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { AppStackManager } from "../appStack/AppStackManager.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  featureFixMessageId,
  featureImplementMessageId,
  featurePullRequestMessageId,
  featureReviewThreadId,
} from "./featureWorkflow.ts";
import {
  FEATURE_WORKFLOW_COMPLETED_ACTIVITY_KIND,
  FeatureWorkflowReactor,
  layer as featureWorkflowLayer,
} from "./FeatureWorkflowReactor.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const threadId = ThreadId.make("thread-feature");
const planId = PlanId.make("plan-1");
const reviewerModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-4-8",
};

interface FakeRun {
  readonly id: string;
  readonly ordinal: number;
  readonly status: string;
  readonly userMessageId: string;
  readonly sourcePlanRef?: { readonly threadId: ThreadId; readonly planId: PlanId };
}

interface FakeWorld {
  interactionMode: string;
  runs: FakeRun[];
  pullRequests: ReadonlyArray<unknown>;
  completedActivities: ReadonlyArray<unknown>;
  /** Final reviewer message by reviewer thread id; present threads have a completed run. */
  reviews?: Record<string, string>;
  withoutWorkflowContext?: boolean;
  /** Commits the Feature branch has that its base lacks; two unless a test says otherwise. */
  commitsAhead?: number;
  dirty?: boolean;
}

const featureThread = (world: FakeWorld) => ({
  id: threadId,
  projectId: ProjectId.make("project-1"),
  title: "Feature",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  runtimeMode: "full-access",
  interactionMode: world.interactionMode,
  branch: "t3/fast-checkout",
  worktreePath: "/repo.worktrees/fast-checkout",
  workflowPreset: "fast-plan",
  workflowRole: null,
  workflowContext: world.withoutWorkflowContext
    ? null
    : {
        workflowId: `workflow-${threadId}`,
        parentWorkflowId: null,
        rootThreadId: threadId,
        ticketScope: [],
      },
  pullRequests: world.pullRequests,
  archivedAt: null,
  deletedAt: null,
});

function makeSystem(world: FakeWorld) {
  const nativeCommands: OrchestrationV2ServerCommand[] = [];
  const workflowCommands: OrchestrationCommand[] = [];
  const teardowns: string[] = [];
  const reviewerExists = (id: ThreadId) =>
    world.reviews?.[id] !== undefined ||
    nativeCommands.some((command) => command.type === "thread.create" && command.threadId === id);
  const layer = featureWorkflowLayer.pipe(
    Layer.provide(
      Layer.mock(OrchestratorV2)({
        dispatch: (command) =>
          Effect.sync(() => {
            nativeCommands.push(command);
            return { sequence: nativeCommands.length, storedEvents: [] };
          }),
        getThreadShell: (id) =>
          Effect.succeed(
            (id === threadId ? featureThread(world) : reviewerExists(id) ? { id } : null) as never,
          ),
        getThreadRecords: ((id: ThreadId) =>
          id === threadId
            ? Effect.succeed({
                thread: featureThread(world),
                runs: world.runs,
                plans: [
                  {
                    id: planId,
                    threadId,
                    runId: RunId.make("run-plan"),
                    kind: "proposed_plan",
                    status: world.runs.some((run) => run.sourcePlanRef) ? "completed" : "active",
                    markdown: "## Implementation steps\n1. Add the fast checkout.",
                  },
                ],
                runtimeRequests: [],
                turnItems: [],
              } as never)
            : world.reviews?.[id] !== undefined
              ? Effect.succeed({
                  thread: { id },
                  runs: [{ id: "run-review", ordinal: 1, status: "completed" }],
                  messages: [
                    {
                      id: "review-answer",
                      runId: "run-review",
                      role: "assistant",
                      streaming: false,
                      text: world.reviews[id],
                    },
                  ],
                } as never)
              : Effect.fail(new Error("missing thread") as never)) as never,
        getShellSnapshot: () => Effect.succeed({ threads: [] } as never),
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) =>
          Effect.sync(() => {
            workflowCommands.push(command);
            return { sequence: workflowCommands.length };
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: () => Effect.succeed(Option.none()),
        listActivitiesByKind: () => Effect.succeed(world.completedActivities as never),
      }),
    ),
    Layer.provide(
      serverSettingsLayerTest({
        workflowStepModels: [
          { workflowPromptId: "implementation.code-review.codex", modelSelection: reviewerModel },
        ],
      }),
    ),
    Layer.provide(
      Layer.mock(AppStackManager)({
        workflowTeardown: ({ workflowId }) =>
          Effect.sync(() => {
            teardowns.push(workflowId);
            return {
              stoppedStackIds: ["stack-1"],
              skippedProtectedStackIds: [],
              failedStackIds: [],
            };
          }),
      }),
    ),
    Layer.provide(
      Layer.mock(GitVcsDriver)({
        readConfigValue: () => Effect.succeed("dev"),
        statusDetailsLocal: () =>
          Effect.succeed({ isRepo: true, hasWorkingTreeChanges: world.dirty === true } as never),
        execute: ({ args }) =>
          Effect.succeed({
            exitCode: 0,
            stdout: args[0] === "rev-list" ? `${world.commitsAhead ?? 2}\n` : "abc123\n",
            stderr: "",
            stdoutTruncated: false,
            stderrTruncated: false,
          } as never),
        listLocalBranchNames: () => Effect.succeed(["dev"]),
        remoteBranchExists: () => Effect.succeed(true),
        resolveDefaultBranchName: () => Effect.succeed("main"),
      }),
    ),
  );
  const evaluate = Effect.gen(function* () {
    const reactor = yield* FeatureWorkflowReactor;
    yield* reactor.evaluate(threadId);
    yield* reactor.drain;
  });
  return { layer, evaluate, nativeCommands, workflowCommands, teardowns };
}

const planningRun: FakeRun = {
  id: "run-plan",
  ordinal: 1,
  status: "completed",
  userMessageId: "user-prompt",
};
const implementRun: FakeRun = {
  id: "run-implement",
  ordinal: 2,
  status: "completed",
  userMessageId: featureImplementMessageId(threadId, planId),
  sourcePlanRef: { threadId, planId },
};

describe("FeatureWorkflowReactor", () => {
  it.effect("implements the proposed plan in the Feature thread itself, once", () => {
    const world: FakeWorld = {
      interactionMode: "plan",
      runs: [planningRun],
      pullRequests: [],
      completedActivities: [],
    };
    const system = makeSystem(world);
    return Effect.gen(function* () {
      yield* system.evaluate;
      assert.deepStrictEqual(
        system.nativeCommands.map((command) => command.type),
        ["thread.interaction-mode.set", "thread.runtime-mode.set", "message.dispatch"],
      );
      const [mode, runtime, message] = system.nativeCommands;
      assert.strictEqual(
        mode?.type === "thread.interaction-mode.set" && mode.interactionMode,
        "default",
      );
      assert.strictEqual(
        runtime?.type === "thread.runtime-mode.set" && runtime.runtimeMode,
        "full-access",
      );
      assert.ok(message?.type === "message.dispatch");
      if (message?.type !== "message.dispatch") return;
      assert.strictEqual(message.threadId, threadId);
      assert.deepStrictEqual(message.sourcePlanRef, { threadId, planId });
      assert.match(message.text, /implementation\.feature\.codex/);

      // The run the plan started is what marks it implemented; nothing starts twice.
      world.interactionMode = "default";
      world.runs = [planningRun, { ...implementRun, status: "running" }];
      yield* system.evaluate;
      assert.strictEqual(system.nativeCommands.length, 3);
    }).pipe(Effect.provide(system.layer));
  });

  it.effect("leaves Feature threads from before the workflow id alone", () => {
    const world: FakeWorld = {
      interactionMode: "plan",
      runs: [planningRun],
      pullRequests: [],
      completedActivities: [],
      withoutWorkflowContext: true,
    };
    const system = makeSystem(world);
    return Effect.gen(function* () {
      yield* system.evaluate;
      assert.deepStrictEqual(system.nativeCommands, []);
    }).pipe(Effect.provide(system.layer));
  });

  it.effect("reviews with the Code Review model chosen in the workflow settings", () => {
    const world: FakeWorld = {
      interactionMode: "default",
      runs: [planningRun, implementRun],
      pullRequests: [],
      completedActivities: [],
    };
    const system = makeSystem(world);
    return Effect.gen(function* () {
      yield* system.evaluate;
      const [create, message] = system.nativeCommands;
      assert.ok(create?.type === "thread.create");
      if (create?.type !== "thread.create") return;
      assert.strictEqual(create.threadId, featureReviewThreadId(threadId, planId, 1));
      assert.strictEqual(create.parentThreadId, threadId);
      assert.deepStrictEqual(create.modelSelection, reviewerModel);
      assert.strictEqual(create.worktreePath, "/repo.worktrees/fast-checkout");
      assert.match(create.title, /Cycle 1 of 5/);
      assert.ok(message?.type === "message.dispatch");
      if (message?.type !== "message.dispatch") return;
      assert.match(message.text, /Base branch: dev/);
      assert.match(message.text, /Add the fast checkout/);
      assert.match(message.text, /feature-code-review-result/);
    }).pipe(Effect.provide(system.layer));
  });

  it.effect(
    "finishes without review or pull request when the implement turn changed nothing",
    () => {
      const world: FakeWorld = {
        interactionMode: "default",
        runs: [planningRun, implementRun],
        pullRequests: [],
        completedActivities: [],
        commitsAhead: 0,
      };
      const system = makeSystem(world);
      return Effect.gen(function* () {
        yield* system.evaluate;
        assert.deepStrictEqual(
          system.nativeCommands.map((command) => command.type),
          ["thread.settle"],
        );
        assert.deepStrictEqual(system.teardowns, [`workflow-${threadId}`]);
        const marker = system.workflowCommands[0];
        assert.ok(marker?.type === "thread.activity.append");
        if (marker?.type !== "thread.activity.append") return;
        assert.strictEqual(marker.activity.kind, FEATURE_WORKFLOW_COMPLETED_ACTIVITY_KIND);
        assert.strictEqual((marker.activity.payload as { reason: string }).reason, "no-changes");
        assert.match(marker.activity.summary, /^Finished without changes/);

        // A finished Feature stays finished, even after later commits in its thread.
        world.completedActivities = [marker.activity];
        world.commitsAhead = 1;
        yield* system.evaluate;
        assert.strictEqual(system.nativeCommands.length, 1);
      }).pipe(Effect.provide(system.layer));
    },
  );

  it.effect("finishes without changes when a fix turn leaves nothing to review", () => {
    const world: FakeWorld = {
      interactionMode: "default",
      runs: [
        planningRun,
        implementRun,
        {
          id: "run-fix",
          ordinal: 3,
          status: "completed",
          userMessageId: featureFixMessageId(threadId, planId, 1),
        },
      ],
      pullRequests: [],
      completedActivities: [],
      commitsAhead: 0,
      reviews: {
        [featureReviewThreadId(threadId, planId, 1)]: [
          "```json",
          '{"type":"feature-code-review-result","status":"findings","reportMarkdown":"Revert it."}',
          "```",
        ].join("\n"),
      },
    };
    const system = makeSystem(world);
    return Effect.gen(function* () {
      yield* system.evaluate;
      assert.deepStrictEqual(
        system.nativeCommands.map((command) => command.type),
        ["thread.settle"],
      );
      const marker = system.workflowCommands[0];
      assert.ok(marker?.type === "thread.activity.append");
      if (marker?.type !== "thread.activity.append") return;
      assert.strictEqual((marker.activity.payload as { reason: string }).reason, "no-changes");
    }).pipe(Effect.provide(system.layer));
  });

  it.effect("reviews uncommitted work even when nothing is committed yet", () => {
    const world: FakeWorld = {
      interactionMode: "default",
      runs: [planningRun, implementRun],
      pullRequests: [],
      completedActivities: [],
      commitsAhead: 0,
      dirty: true,
    };
    const system = makeSystem(world);
    return Effect.gen(function* () {
      yield* system.evaluate;
      assert.deepStrictEqual(
        system.nativeCommands.map((command) => command.type),
        ["thread.create", "message.dispatch"],
      );
      assert.deepStrictEqual(system.teardowns, []);
    }).pipe(Effect.provide(system.layer));
  });

  it.effect("stops the workflow's App Stacks and settles once the pull request is linked", () => {
    const world: FakeWorld = {
      interactionMode: "default",
      runs: [
        planningRun,
        implementRun,
        {
          id: "run-pr",
          ordinal: 3,
          status: "completed",
          userMessageId: featurePullRequestMessageId(threadId, planId),
        },
      ],
      pullRequests: [],
      completedActivities: [],
    };
    const system = makeSystem(world);
    world.reviews = {
      [featureReviewThreadId(threadId, planId, 1)]: [
        "```json",
        '{"type":"feature-code-review-result","status":"clean","reportMarkdown":"Looks right."}',
        "```",
      ].join("\n"),
    };
    return Effect.gen(function* () {
      yield* system.evaluate;
      // The pull-request turn finished without linking anything: nothing to tear down.
      assert.deepStrictEqual(system.teardowns, []);

      world.pullRequests = [
        {
          host: "github.com",
          repository: "acme/app",
          number: 7,
          url: "https://github.com/acme/app/pull/7",
          source: "agent",
          linkedAt: "2026-10-13T00:00:00.000Z",
          snapshot: null,
          stack: null,
        },
      ];
      yield* system.evaluate;
      assert.deepStrictEqual(system.teardowns, [`workflow-${threadId}`]);
      assert.deepStrictEqual(
        system.nativeCommands.map((command) => command.type),
        ["thread.settle"],
      );
      const marker = system.workflowCommands[0];
      assert.ok(marker?.type === "thread.activity.append");
      if (marker?.type !== "thread.activity.append") return;
      assert.strictEqual(marker.activity.kind, FEATURE_WORKFLOW_COMPLETED_ACTIVITY_KIND);

      // Later events on the thread leave its App Stacks alone.
      world.completedActivities = [marker.activity];
      yield* system.evaluate;
      assert.deepStrictEqual(system.teardowns, [`workflow-${threadId}`]);
    }).pipe(Effect.provide(system.layer));
  });
});
