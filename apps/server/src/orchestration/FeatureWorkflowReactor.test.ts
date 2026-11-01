import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
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
import { T3ProjectFileLoader } from "../project/T3ProjectFileLoader.ts";
import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import {
  featureAppReviewFixMessageId,
  featureAppReviewId,
  featureAppReviewThreadId,
  featureE2eAppReviewRunId,
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
const instructionText =
  "## User intent\nFaster checkout.\n## Guardrails\nKeep the cart.\n## Goal\nOne-click checkout.";
const reviewerModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-4-8",
};

interface FakeRun {
  readonly id: string;
  readonly ordinal: number;
  readonly status: string;
  readonly userMessageId: string;
}

interface FakeWorld {
  runs: FakeRun[];
  pullRequests: ReadonlyArray<unknown>;
  completedActivities: ReadonlyArray<unknown>;
  /** Final reviewer message by reviewer thread id; present threads have a completed run. */
  reviews?: Record<string, string>;
  /** Browser App Review records by reviewer thread id; present threads have a completed run. */
  appReviews?: Record<string, { status: string; summary: string }>;
  /** E2E App Review Workflow runs by run id. */
  e2eRuns?: Record<string, { status: string; findings?: string; recordings?: string[] }>;
  /** The worktree's `e2eCommands`; none means App Review falls back to the browser. */
  e2eCommands?: string[];
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
  interactionMode: "default",
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
                runtimeRequests: [],
                turnItems: [],
                messages: [
                  {
                    id: "instruction-answer",
                    runId: "run-instruction",
                    role: "assistant",
                    streaming: false,
                    text: instructionText,
                  },
                ],
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
        getThreadShellById: () => Effect.succeedNone,
        getAppReviewWorkflowRun: (input) => {
          const run = "runId" in input ? world.e2eRuns?.[input.runId] : undefined;
          return Effect.succeed(
            run === undefined
              ? Option.none()
              : (Option.some({
                  status: run.status,
                  failure: null,
                  cycles: [
                    {
                      actionableFindingsMarkdown: run.findings ?? null,
                      e2eExecution: {
                        id: "execution",
                        commands: [],
                        results: [
                          {
                            command: "pnpm e2e",
                            executedCommand: "pnpm e2e",
                            status: run.status === "passed" ? "passed" : "failed",
                            outputMarkdown: "",
                            recordings: (run.recordings ?? []).map((label) => ({
                              id: label,
                              label,
                              path: `/recordings/${label}`,
                              sizeBytes: 1,
                            })),
                            completedAt: "2026-10-18T00:00:00.000Z",
                          },
                        ],
                      },
                    },
                  ],
                }) as never),
          );
        },
        getThreadDetailById: (id) => {
          const record = world.appReviews?.[id];
          return Effect.succeed(
            record === undefined
              ? Option.none()
              : (Option.some({
                  id,
                  appReviews: [
                    {
                      id: featureAppReviewId(threadId, Number(id.split("::").at(-1))),
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
      Layer.mock(T3ProjectFileLoader)({
        loadStrict: () =>
          Effect.succeed(
            world.e2eCommands === undefined
              ? Option.none()
              : (Option.some({ e2eCommands: world.e2eCommands }) as never),
          ),
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

const instructionRun: FakeRun = {
  id: "run-instruction",
  ordinal: 1,
  status: "completed",
  userMessageId: "user-prompt",
};
const implementRun: FakeRun = {
  id: "run-implement",
  ordinal: 2,
  status: "completed",
  userMessageId: featureImplementMessageId(threadId),
};
const passedE2e = {
  [featureE2eAppReviewRunId(threadId, 1)]: {
    status: "passed",
    recordings: ["checkout completes", "cart keeps items"],
  },
};
const cleanReviews = {
  [featureReviewThreadId(threadId, 1)]: [
    "```json",
    '{"type":"feature-code-review-result","status":"clean","reportMarkdown":"Looks right."}',
    "```",
  ].join("\n"),
};
const implementedWorld = (overrides: Partial<FakeWorld> = {}): FakeWorld => ({
  runs: [instructionRun, implementRun],
  pullRequests: [],
  completedActivities: [],
  e2eCommands: ["pnpm e2e"],
  ...overrides,
});

describe("FeatureWorkflowReactor", () => {
  it.effect("implements the instruction test-first in the Feature thread itself, once", () => {
    const world: FakeWorld = { runs: [instructionRun], pullRequests: [], completedActivities: [] };
    const system = makeSystem(world);
    return Effect.gen(function* () {
      yield* system.evaluate;
      assert.deepStrictEqual(
        system.nativeCommands.map((command) => command.type),
        ["thread.interaction-mode.set", "thread.runtime-mode.set", "message.dispatch"],
      );
      const [, runtime, message] = system.nativeCommands;
      assert.strictEqual(
        runtime?.type === "thread.runtime-mode.set" && runtime.runtimeMode,
        "full-access",
      );
      assert.ok(message?.type === "message.dispatch");
      if (message?.type !== "message.dispatch") return;
      assert.strictEqual(message.threadId, threadId);
      assert.strictEqual(message.messageId, featureImplementMessageId(threadId));
      assert.match(message.text, /implementation\.feature\.codex/);
      assert.match(message.text, /matt-pocock\.tdd/);

      // The implement turn is what marks the instruction step done; nothing starts twice.
      world.runs = [instructionRun, { ...implementRun, status: "running" }];
      yield* system.evaluate;
      assert.strictEqual(system.nativeCommands.length, 3);
    }).pipe(Effect.provide(system.layer));
  });

  it.effect("leaves Feature threads from before the workflow id alone", () => {
    const world: FakeWorld = {
      runs: [instructionRun],
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

  it.effect("tests the change with the project's E2E suites on the worktree's App Stack", () => {
    const system = makeSystem(implementedWorld());
    return Effect.gen(function* () {
      yield* system.evaluate;
      assert.deepStrictEqual(
        system.stackRequests.map((request) => request.workflowId),
        [`workflow-${threadId}`],
      );
      const launch = system.workflowCommands[0];
      assert.ok(launch?.type === "thread.app-review-workflow.launch");
      if (launch?.type !== "thread.app-review-workflow.launch") return;
      assert.strictEqual(launch.targetThreadId, threadId);
      assert.strictEqual(launch.controllerThreadId, featureAppReviewThreadId(threadId, 1));
      assert.deepStrictEqual(launch.caller, { type: "standalone", sourceThreadId: threadId });
      assert.deepStrictEqual(launch.previewTargets, ["https://feature.stack.example"]);
      assert.strictEqual(launch.previewTargetsPinned, true);
      assert.strictEqual(launch.reviewOnly, true);
      assert.strictEqual(launch.appReviewScope, "e2e");
      assert.match(launch.briefMarkdown, /cycle 1 of 3/);
      assert.match(launch.briefMarkdown, /One-click checkout/);
      // Code Review and the pull request wait for the App Review verdict.
      assert.deepStrictEqual(system.nativeCommands, []);
    }).pipe(Effect.provide(system.layer));
  });

  it.effect("drives the app in the browser when the project has no E2E suites", () => {
    const { e2eCommands: _none, ...world } = implementedWorld();
    const system = makeSystem(world);
    return Effect.gen(function* () {
      yield* system.evaluate;
      const launch = system.workflowCommands[0];
      assert.ok(launch?.type === "thread.app-review.launch");
      if (launch?.type !== "thread.app-review.launch") return;
      assert.strictEqual(launch.sourceThreadId, threadId);
      assert.strictEqual(launch.reviewThreadId, featureAppReviewThreadId(threadId, 1));
      assert.strictEqual(launch.reviewId, featureAppReviewId(threadId, 1));
      assert.strictEqual(launch.appReviewScope, "browser");
      assert.strictEqual(launch.workflowPromptId, "implementation.browser-app-review.codex");
      assert.match(launch.message.text, /Feature URL: https:\/\/feature\.stack\.example/);
      assert.match(launch.message.text, /App Stack: stack-feature/);
      assert.match(launch.message.text, /One-click checkout/);
    }).pipe(Effect.provide(system.layer));
  });

  it.effect("has the Feature thread fix what a failed E2E App Review found", () => {
    const system = makeSystem(
      implementedWorld({
        e2eRuns: {
          [featureE2eAppReviewRunId(threadId, 1)]: {
            status: "exhausted",
            findings: "Suite: pnpm e2e\ncheckout never finishes",
          },
        },
      }),
    );
    return Effect.gen(function* () {
      yield* system.evaluate;
      const [fix] = system.nativeCommands;
      assert.ok(fix?.type === "message.dispatch");
      if (fix?.type !== "message.dispatch") return;
      assert.strictEqual(fix.threadId, threadId);
      assert.strictEqual(fix.messageId, featureAppReviewFixMessageId(threadId, 1));
      assert.match(fix.text, /App Review cycle 1 of 3 failed/);
      assert.match(fix.text, /checkout never finishes/);
    }).pipe(Effect.provide(system.layer));
  });

  it.effect("has the Feature thread fix what a failed browser App Review found", () => {
    const { e2eCommands: _none, ...world } = implementedWorld({
      appReviews: {
        [featureAppReviewThreadId(threadId, 1)]: {
          status: "failed",
          summary: "Checkout never finishes.",
        },
      },
    });
    const system = makeSystem(world);
    return Effect.gen(function* () {
      yield* system.evaluate;
      const [fix] = system.nativeCommands;
      assert.ok(fix?.type === "message.dispatch");
      if (fix?.type !== "message.dispatch") return;
      assert.strictEqual(fix.messageId, featureAppReviewFixMessageId(threadId, 1));
      assert.match(fix.text, /Checkout never finishes\./);
    }).pipe(Effect.provide(system.layer));
  });

  it.effect("reviews the code after App Review, with the Code Review model from settings", () => {
    const system = makeSystem(implementedWorld({ e2eRuns: passedE2e }));
    return Effect.gen(function* () {
      yield* system.evaluate;
      const [create, message] = system.nativeCommands;
      assert.ok(create?.type === "thread.create");
      if (create?.type !== "thread.create") return;
      assert.strictEqual(create.threadId, featureReviewThreadId(threadId, 1));
      assert.strictEqual(create.parentThreadId, threadId);
      assert.deepStrictEqual(create.modelSelection, reviewerModel);
      assert.strictEqual(create.worktreePath, "/repo.worktrees/fast-checkout");
      assert.match(create.title, /Cycle 1 of 5/);
      assert.ok(message?.type === "message.dispatch");
      if (message?.type !== "message.dispatch") return;
      assert.match(message.text, /Base branch: dev/);
      assert.match(message.text, /One-click checkout/);
      assert.match(message.text, /feature-code-review-result/);
    }).pipe(Effect.provide(system.layer));
  });

  it.effect("opens the pull request with the recorded flows once both reviews are done", () => {
    const system = makeSystem(implementedWorld({ e2eRuns: passedE2e, reviews: cleanReviews }));
    return Effect.gen(function* () {
      yield* system.evaluate;
      const [pullRequest] = system.nativeCommands;
      assert.ok(pullRequest?.type === "message.dispatch");
      if (pullRequest?.type !== "message.dispatch") return;
      assert.strictEqual(pullRequest.messageId, featurePullRequestMessageId(threadId));
      assert.match(pullRequest.text, /App Review passed in cycle 1/);
      assert.match(pullRequest.text, /Recorded flows: checkout completes, cart keeps items/);
      assert.match(pullRequest.text, /User intent, Guardrails, and Goal/);
      assert.match(pullRequest.text, /The last Code Review cycle came back clean/);
    }).pipe(Effect.provide(system.layer));
  });

  it.effect(
    "finishes without reviews or pull request when the implement turn changed nothing",
    () => {
      const world = implementedWorld({ commitsAhead: 0 });
      const system = makeSystem(world);
      return Effect.gen(function* () {
        yield* system.evaluate;
        assert.deepStrictEqual(
          system.nativeCommands.map((command) => command.type),
          ["thread.settle"],
        );
        assert.deepStrictEqual(system.teardowns, [`workflow-${threadId}`]);
        assert.deepStrictEqual(system.stackRequests, []);
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
    const system = makeSystem(
      implementedWorld({
        runs: [
          instructionRun,
          implementRun,
          {
            id: "run-fix",
            ordinal: 3,
            status: "completed",
            userMessageId: featureFixMessageId(threadId, 1),
          },
        ],
        commitsAhead: 0,
        e2eRuns: passedE2e,
        reviews: {
          [featureReviewThreadId(threadId, 1)]: [
            "```json",
            '{"type":"feature-code-review-result","status":"findings","reportMarkdown":"Revert it."}',
            "```",
          ].join("\n"),
        },
      }),
    );
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

  it.effect("tests uncommitted work even when nothing is committed yet", () => {
    const system = makeSystem(implementedWorld({ commitsAhead: 0, dirty: true }));
    return Effect.gen(function* () {
      yield* system.evaluate;
      assert.deepStrictEqual(
        system.workflowCommands.map((command) => command.type),
        ["thread.app-review-workflow.launch"],
      );
      assert.deepStrictEqual(system.teardowns, []);
    }).pipe(Effect.provide(system.layer));
  });

  it.effect("stops the workflow's App Stacks and settles once the pull request is linked", () => {
    const world = implementedWorld({
      runs: [
        instructionRun,
        implementRun,
        {
          id: "run-pr",
          ordinal: 3,
          status: "completed",
          userMessageId: featurePullRequestMessageId(threadId),
        },
      ],
    });
    const system = makeSystem(world);
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

  it.effect(
    "reviews the code and says so in the pull request when the App Stack does not start",
    () => {
      const system = makeSystem(
        implementedWorld({
          reviews: cleanReviews,
          appStack: { failure: "This project has no App Stack" },
        }),
      );
      return Effect.gen(function* () {
        yield* system.evaluate;
        const skipped = system.workflowCommands[0];
        assert.ok(skipped?.type === "thread.activity.append");
        if (skipped?.type !== "thread.activity.append") return;
        assert.strictEqual(skipped.activity.kind, FEATURE_APP_REVIEW_SKIPPED_ACTIVITY_KIND);
        assert.ok(
          !system.workflowCommands.some(
            (command) => command.type === "thread.app-review-workflow.launch",
          ),
        );
        const [pullRequest] = system.nativeCommands;
        assert.ok(pullRequest?.type === "message.dispatch");
        if (pullRequest?.type !== "message.dispatch") return;
        assert.strictEqual(pullRequest.messageId, featurePullRequestMessageId(threadId));
        assert.match(
          pullRequest.text,
          /App Review cycle 1 could not run: its App Stack did not start \(This project has no App Stack\)\./,
        );
      }).pipe(Effect.provide(system.layer));
    },
  );
});
