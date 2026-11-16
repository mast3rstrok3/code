import { assert, describe, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type GrillAnswerer,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationV2ServerCommand,
  type UserInputQuestion,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { WorkflowUserInputBroker } from "../mcp/WorkflowUserInputBroker.ts";
import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { layerTest as serverSettingsLayerTest } from "../serverSettings.ts";
import { grillJudgeMessageId, grillJudgeThreadId } from "./grillJudge.ts";
import {
  GRILL_JUDGE_FALLBACK_ACTIVITY_KIND,
  GrillJudgeReactor,
  layer as grillJudgeLayer,
} from "./GrillJudgeReactor.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const rootId = ThreadId.make("thread-engineering");
const judgeId = grillJudgeThreadId(rootId);
const judgeModel: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5-5",
};

const scope: UserInputQuestion = {
  id: "scope",
  header: "Scope",
  question: "How far should the fix reach?",
  options: [
    { label: "Only the form", description: "Fix the reported form." },
    { label: "Every form", description: "Refactor the shared validator." },
  ],
  recommendation: { optionLabel: "Only the form", rationale: "The ticket names one form." },
  multiSelect: false,
};

interface JudgeRun {
  readonly attempt: 1 | 2;
  readonly status: string;
  readonly reply?: string;
}

interface FakeWorld {
  readonly grillAnswerer?: GrillAnswerer;
  readonly stage?: string;
  readonly answered?: boolean;
  readonly judgeRuns?: ReadonlyArray<JudgeRun>;
  /** A provider-native card's runtime request; absent means the MCP broker owns the card. */
  readonly nativeRequest?: "pending" | "resolved";
}

const rootThread = (world: FakeWorld) => ({
  id: rootId,
  projectId: ProjectId.make("project-1"),
  ownerUserId: "user-1",
  title: "Feedback abc12345: broken form",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" },
  runtimeMode: "full-access",
  interactionMode: "planning-workflow",
  branch: "fix/feedback-abc12345",
  worktreePath: "/repo.worktrees/feedback-abc12345",
  workflowPreset: "planning",
  workflowRole: null,
  workflowContext: null,
  workflowImplementationSettings: {
    ticketAppReviewEnabled: false,
    appReviewEnabled: true,
    finalCodeReviewEnabled: true,
    pullRequestCreationEnabled: true,
    pullRequestBabysittingEnabled: true,
    ...(world.grillAnswerer === undefined ? {} : { grillAnswerer: world.grillAnswerer }),
  },
  planningWorkflow: world.stage === undefined ? null : { stage: world.stage },
  archivedAt: null,
  deletedAt: null,
  messages: [
    {
      id: "m1",
      role: "user",
      text: '{"feedbackId":"abc12345","summary":"The form loses input"}\n\n<workflow-skill id="planning.grill-stage.codex">…</workflow-skill>',
      streaming: false,
    },
    {
      id: "m2",
      role: "assistant",
      text: "The form is rendered in Checkout.tsx.",
      streaming: false,
    },
  ],
  activities: [
    {
      id: "a1",
      tone: "info",
      kind: "user-input.requested",
      summary: "User input requested",
      payload: { requestId: "request-1", questions: [scope] },
      turnId: null,
      createdAt: "2026-10-16T10:00:00.000Z",
    },
    ...(world.answered
      ? [
          {
            id: "a2",
            tone: "info",
            kind: "user-input.resolved",
            summary: "User input submitted",
            payload: { requestId: "request-1", answers: { scope: "Every form" } },
            turnId: null,
            createdAt: "2026-10-16T10:01:00.000Z",
          },
        ]
      : []),
  ],
});

function makeSystem(world: FakeWorld) {
  const nativeCommands: OrchestrationV2ServerCommand[] = [];
  const workflowCommands: OrchestrationCommand[] = [];
  const runs = (world.judgeRuns ?? []).map((run, index) => ({
    id: `run-${index + 1}`,
    ordinal: index + 1,
    status: run.status,
    userMessageId: grillJudgeMessageId("request-1", run.attempt),
  }));
  const layer = grillJudgeLayer.pipe(
    Layer.provide(
      Layer.mock(OrchestratorV2)({
        dispatch: (command) =>
          Effect.sync(() => {
            nativeCommands.push(command);
            return { sequence: nativeCommands.length, storedEvents: [] };
          }),
        getThreadShell: (id) =>
          Effect.succeed((id === judgeId && runs.length > 0 ? { id } : null) as never),
        getThreadRecords: ((id: ThreadId) =>
          id === rootId
            ? Effect.succeed({
                thread: { id },
                runtimeRequests:
                  world.nativeRequest === undefined
                    ? []
                    : [{ id: "request-1", kind: "user_input", status: world.nativeRequest }],
              } as never)
            : id === judgeId && runs.length > 0
              ? Effect.succeed({
                  thread: { id },
                  runs,
                  messages: (world.judgeRuns ?? []).flatMap((run, index) =>
                    run.reply === undefined
                      ? []
                      : [
                          {
                            id: `reply-${index + 1}`,
                            runId: `run-${index + 1}`,
                            role: "assistant",
                            streaming: false,
                            text: run.reply,
                          },
                        ],
                  ),
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
        streamDomainEvents: Stream.empty,
      }),
    ),
    Layer.provide(
      Layer.mock(WorkflowUserInputBroker)({
        pendingQuestions: () =>
          Effect.succeed(world.nativeRequest === undefined ? Option.some([scope]) : Option.none()),
      }),
    ),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadDetailById: (id) =>
          Effect.succeed(id === rootId ? (Option.some(rootThread(world)) as never) : Option.none()),
      }),
    ),
    Layer.provide(
      serverSettingsLayerTest({
        workflowStepModels: [
          {
            workflowPromptId: "planning.grill-judge.codex",
            stepWorkflowPromptId: "planning.grill-stage.codex",
            modelSelection: judgeModel,
          },
        ],
      }),
    ),
  );
  const evaluate = Effect.gen(function* () {
    const reactor = yield* GrillJudgeReactor;
    yield* reactor.evaluate(rootId);
    yield* reactor.drain;
  });
  return { layer, evaluate, nativeCommands, workflowCommands };
}

const judgeReply = (answer: string) =>
  `The ticket names one form.\n\n\`\`\`json\n${JSON.stringify({
    type: "grill-judge-answers",
    answers: { scope: answer },
  })}\n\`\`\``;

describe("GrillJudgeReactor", () => {
  it.effect("hands an open Grill card to a judge thread under the root", () => {
    const system = makeSystem({ grillAnswerer: "judge", stage: "grill" });
    return Effect.gen(function* () {
      yield* system.evaluate;
      const [create, message] = system.nativeCommands;
      assert.strictEqual(create?.type, "thread.create");
      if (create?.type !== "thread.create") return;
      assert.strictEqual(create.threadId, judgeId);
      assert.strictEqual(create.parentThreadId, rootId);
      assert.strictEqual(create.workflowRole, "planning-grill-judge");
      assert.deepStrictEqual(create.modelSelection, judgeModel);
      assert.strictEqual(create.worktreePath, "/repo.worktrees/feedback-abc12345");

      assert.strictEqual(message?.type, "message.dispatch");
      if (message?.type !== "message.dispatch") return;
      assert.strictEqual(message.threadId, judgeId);
      assert.strictEqual(message.messageId, grillJudgeMessageId("request-1", 1));
      assert.include(message.text, '{"feedbackId":"abc12345","summary":"The form loses input"}');
      assert.notInclude(message.text, 'id="planning.grill-stage.codex"');
      assert.include(message.text, "The form is rendered in Checkout.tsx.");
      assert.include(message.text, "The Grill recommends **Only the form**");
      assert.include(message.text, 'id="planning.grill-judge.codex"');
      assert.lengthOf(system.workflowCommands, 0);
    }).pipe(Effect.provide(system.layer));
  });

  it.effect("answers the card with the judge's reply", () => {
    const system = makeSystem({
      grillAnswerer: "judge",
      stage: "grill",
      judgeRuns: [{ attempt: 1, status: "completed", reply: judgeReply("Every form") }],
    });
    return Effect.gen(function* () {
      yield* system.evaluate;
      assert.lengthOf(system.nativeCommands, 0);
      const [answer] = system.workflowCommands;
      assert.strictEqual(answer?.type, "thread.user-input.respond");
      if (answer?.type !== "thread.user-input.respond") return;
      assert.strictEqual(answer.threadId, rootId);
      assert.strictEqual(answer.requestId, "request-1");
      assert.deepStrictEqual(answer.answers, { scope: "Every form" });
    }).pipe(Effect.provide(system.layer));
  });

  it.effect("asks once more, then answers with the Grill's recommendation and records why", () => {
    const retrying = makeSystem({
      grillAnswerer: "judge",
      judgeRuns: [{ attempt: 1, status: "completed", reply: "Narrow fix." }],
    });
    const fallingBack = makeSystem({
      grillAnswerer: "judge",
      judgeRuns: [
        { attempt: 1, status: "completed", reply: "Narrow fix." },
        { attempt: 2, status: "completed", reply: "Still narrow." },
      ],
    });
    return Effect.gen(function* () {
      yield* retrying.evaluate.pipe(Effect.provide(retrying.layer));
      const [retry] = retrying.nativeCommands;
      assert.strictEqual(retry?.type, "message.dispatch");
      if (retry?.type === "message.dispatch") {
        assert.strictEqual(retry.messageId, grillJudgeMessageId("request-1", 2));
        assert.include(retry.text, "grill-judge-answers");
      }

      yield* fallingBack.evaluate.pipe(Effect.provide(fallingBack.layer));
      const [answer, fallback] = fallingBack.workflowCommands;
      assert.strictEqual(answer?.type, "thread.user-input.respond");
      if (answer?.type === "thread.user-input.respond") {
        assert.deepStrictEqual(answer.answers, { scope: "Only the form" });
      }
      assert.strictEqual(
        fallback?.type === "thread.activity.append" ? fallback.activity.kind : null,
        GRILL_JUDGE_FALLBACK_ACTIVITY_KIND,
      );
    });
  });

  it.effect("does not answer a native card a person answered while the judge worked", () => {
    const answeredMeanwhile = makeSystem({
      grillAnswerer: "judge",
      nativeRequest: "resolved",
      judgeRuns: [{ attempt: 1, status: "completed", reply: judgeReply("Every form") }],
    });
    const stillOpen = makeSystem({
      grillAnswerer: "judge",
      nativeRequest: "pending",
      judgeRuns: [{ attempt: 1, status: "completed", reply: judgeReply("Every form") }],
    });
    return Effect.gen(function* () {
      yield* answeredMeanwhile.evaluate.pipe(Effect.provide(answeredMeanwhile.layer));
      assert.lengthOf(answeredMeanwhile.workflowCommands, 0);
      yield* stillOpen.evaluate.pipe(Effect.provide(stillOpen.layer));
      assert.strictEqual(stillOpen.workflowCommands[0]?.type, "thread.user-input.respond");
    });
  });

  it.effect("leaves the card to a person, an answered card, and later stages alone", () => {
    const systems = [
      makeSystem({ stage: "grill" }),
      makeSystem({ grillAnswerer: "human", stage: "grill" }),
      makeSystem({ grillAnswerer: "judge", stage: "grill", answered: true }),
      makeSystem({ grillAnswerer: "judge", stage: "spec-authoring" }),
    ];
    return Effect.gen(function* () {
      for (const system of systems) {
        yield* system.evaluate.pipe(Effect.provide(system.layer));
        assert.lengthOf(system.nativeCommands, 0);
        assert.lengthOf(system.workflowCommands, 0);
      }
    });
  });
});
