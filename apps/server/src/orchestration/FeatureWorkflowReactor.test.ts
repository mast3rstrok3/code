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
  featureAppReviewFixMessageId,
  featureAppReviewId,
  featureAppReviewThreadId,
  featureFixMessageId,
  featureImplementMessageId,
  featurePullRequestMessageId,
  featureReviewThreadId,
} from "./featureWorkflow.ts";
import {
  FEATURE_APP_REVIEW_SKIPPED_ACTIVITY_KIND,
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
  /** App Review records by reviewer thread id; present threads have a completed run. */
  appReviews?: Record<string, { status: string; summary: string }>;
  /** The worktree's App Stack: its frontend, or why it did not start. */
  appStack?: { frontendUrl: string } | { failure: string };
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
  const stackRequests: Array<{ worktreePath: string; workflowId?: string | null | undefined }> = [];
  const appendedActivities = () =>
    workflowCommands.flatMap((command) =>
      command.type === "thread.activity.append" ? [command.activity] : [],
    );
  const reviewerExists = (id: ThreadId) =>
    world.reviews?.[id] !== undefined ||
    world.appReviews?.[id] !== undefined ||
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
            : world.appReviews?.[id] !== undefined
              ? Effect.succeed({
                  thread: { id },
                  runs: [{ id: "run-app-review", ordinal: 1, status: "completed" }],
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
        getThreadDetailById: (id) => {
          const record = world.appReviews?.[id];
          return Effect.succeed(
            record === undefined
              ? Option.none()
              : (Option.some({
                  id,
                  appReviews: [
                    {
                      id: featureAppReviewId(threadId, planId, Number(id.split("::").at(-1))),
                      status: record.status,
                      document: { summary: record.summary, findings: [] },
                    },
                  ],
                }) as never),
          );
        },
        listActivitiesByKind: (kind) =>
          Effect.succeed(
            [
              ...(world.completedActivities as Array<{ kind?: string }>),
              ...appendedActivities(),
            ].filter((activity) => activity.kind === kind) as never,
          ),
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
        autoCreate: (input) =>
          Effect.suspend(() => {
            stackRequests.push(input);
            const stack = world.appStack ?? { frontendUrl: "https://feature.stack.example" };
            return "failure" in stack
              ? Effect.fail({ message: stack.failure } as never)
              : Effect.succeed({
                  stack: { id: "stack-feature", status: "starting" },
                  created: true,
                  frontendUrl: stack.frontendUrl,
                  frontendServiceName: "frontend",
                } as never);
          }),
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
  return { layer, evaluate, nativeCommands, workflowCommands, teardowns, stackRequests };
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
  const cleanReviews = {
    [featureReviewThreadId(threadId, planId, 1)]: [
      "```json",
      '{"type":"feature-code-review-result","status":"clean","reportMarkdown":"Looks right."}',
      "```",
    ].join("\n"),
  };

  it.effect("tests the change in the running app once Code Review is clean", () => {
    const world: FakeWorld = {
      interactionMode: "default",
      runs: [planningRun, implementRun],
      pullRequests: [],
      completedActivities: [],
      reviews: cleanReviews,
    };
    const system = makeSystem(world);
    return Effect.gen(function* () {
      yield* system.evaluate;
      assert.deepStrictEqual(
        system.stackRequests.map((request) => request.workflowId),
        [`workflow-${threadId}`],
      );
      const launch = system.workflowCommands[0];
      assert.ok(launch?.type === "thread.app-review.launch");
      if (launch?.type !== "thread.app-review.launch") return;
      assert.strictEqual(launch.sourceThreadId, threadId);
      assert.strictEqual(launch.reviewThreadId, featureAppReviewThreadId(threadId, planId, 1));
      assert.strictEqual(launch.reviewId, featureAppReviewId(threadId, planId, 1));
      assert.strictEqual(launch.appReviewScope, "browser");
      assert.strictEqual(launch.workflowPromptId, "implementation.browser-app-review.codex");
      assert.match(launch.message.text, /App Review cycle 1 of 3/);
      assert.match(launch.message.text, /Feature URL: https:\/\/feature\.stack\.example/);
      assert.match(launch.message.text, /App Stack: stack-feature/);
      assert.match(launch.message.text, /Add the fast checkout/);
      // No pull request yet: it waits for the App Review verdict.
      assert.deepStrictEqual(system.nativeCommands, []);
    }).pipe(Effect.provide(system.layer));
  });

  it.effect("has the Feature thread fix what a failed App Review found", () => {
    const world: FakeWorld = {
      interactionMode: "default",
      runs: [planningRun, implementRun],
      pullRequests: [],
      completedActivities: [],
      reviews: cleanReviews,
      appReviews: {
        [featureAppReviewThreadId(threadId, planId, 1)]: {
          status: "failed",
          summary: "Checkout never finishes.",
        },
      },
    };
    const system = makeSystem(world);
    return Effect.gen(function* () {
      yield* system.evaluate;
      const [fix] = system.nativeCommands;
      assert.ok(fix?.type === "message.dispatch");
      if (fix?.type !== "message.dispatch") return;
      assert.strictEqual(fix.threadId, threadId);
      assert.strictEqual(fix.messageId, featureAppReviewFixMessageId(threadId, planId, 1));
      assert.match(fix.text, /App Review cycle 1 of 3 failed/);
      assert.match(fix.text, /Checkout never finishes\./);
    }).pipe(Effect.provide(system.layer));
  });

  it.effect("opens the pull request when App Review passed", () => {
    const world: FakeWorld = {
      interactionMode: "default",
      runs: [planningRun, implementRun],
      pullRequests: [],
      completedActivities: [],
      reviews: cleanReviews,
      appReviews: {
        [featureAppReviewThreadId(threadId, planId, 1)]: { status: "passed", summary: "Works." },
      },
    };
    const system = makeSystem(world);
    return Effect.gen(function* () {
      yield* system.evaluate;
      const [pullRequest] = system.nativeCommands;
      assert.ok(pullRequest?.type === "message.dispatch");
      if (pullRequest?.type !== "message.dispatch") return;
      assert.strictEqual(pullRequest.messageId, featurePullRequestMessageId(threadId, planId));
      assert.match(pullRequest.text, /App Review passed in cycle 1/);
    }).pipe(Effect.provide(system.layer));
  });

  it.effect("opens the pull request without App Review when the App Stack does not start", () => {
    const world: FakeWorld = {
      interactionMode: "default",
      runs: [planningRun, implementRun],
      pullRequests: [],
      completedActivities: [],
      reviews: cleanReviews,
      appStack: { failure: "This project has no App Stack" },
    };
    const system = makeSystem(world);
    return Effect.gen(function* () {
      yield* system.evaluate;
      const skipped = system.workflowCommands[0];
      assert.ok(skipped?.type === "thread.activity.append");
      if (skipped?.type !== "thread.activity.append") return;
      assert.strictEqual(skipped.activity.kind, FEATURE_APP_REVIEW_SKIPPED_ACTIVITY_KIND);
      assert.ok(
        !system.workflowCommands.some((command) => command.type === "thread.app-review.launch"),
      );
      const [pullRequest] = system.nativeCommands;
      assert.ok(pullRequest?.type === "message.dispatch");
      if (pullRequest?.type !== "message.dispatch") return;
      assert.strictEqual(pullRequest.messageId, featurePullRequestMessageId(threadId, planId));
      assert.match(
        pullRequest.text,
        /App Review cycle 1 could not run: its App Stack did not start \(This project has no App Stack\)\./,
      );
    }).pipe(Effect.provide(system.layer));
  });
});
