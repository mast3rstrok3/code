import {
  CommandId,
  EventId,
  ProviderDriverKind,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationReadModel,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { createEmptyReadModel, projectEvent } from "./projector.ts";

const CREATED_AT = "2026-03-01T00:00:00.000Z";
const SET_AT = "2026-03-01T01:00:00.000Z";

const APP_REVIEW_PROMPT_ID = "implementation.browser-app-review.codex";
const TICKET_WAVE_PROMPT_ID = "implementation.tdd.codex";

let sequence = 0;

function makeEvent(input: {
  readonly type: OrchestrationEvent["type"];
  readonly occurredAt: string;
  readonly payload: unknown;
}): OrchestrationEvent {
  sequence += 1;
  return {
    sequence,
    eventId: EventId.make(`event-${String(sequence)}`),
    type: input.type,
    aggregateKind: "thread",
    aggregateId: ThreadId.make("thread-1"),
    occurredAt: input.occurredAt,
    commandId: CommandId.make(`cmd-${String(sequence)}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
    payload: input.payload as never,
  } as OrchestrationEvent;
}

const threadCreated = () =>
  makeEvent({
    type: "thread.created",
    occurredAt: CREATED_AT,
    payload: {
      threadId: "thread-1",
      projectId: "project-1",
      title: "Workflow",
      modelSelection: { provider: ProviderDriverKind.make("codex"), model: "gpt-5.6-sol" },
      runtimeMode: "full-access",
      branch: null,
      worktreePath: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
    },
  });

const setCycles = (input: {
  readonly workflowPromptId: string;
  readonly stepWorkflowPromptId?: string;
  readonly maxCycles: number | null;
}) =>
  makeEvent({
    type: "thread.workflow-step-cycles-set",
    occurredAt: SET_AT,
    payload: {
      threadId: "thread-1",
      workflowPromptId: input.workflowPromptId,
      ...(input.stepWorkflowPromptId === undefined
        ? {}
        : { stepWorkflowPromptId: input.stepWorkflowPromptId }),
      maxCycles: input.maxCycles,
      updatedAt: SET_AT,
    },
  });

const applyAll = (events: ReadonlyArray<OrchestrationEvent>) =>
  Effect.gen(function* () {
    let model: OrchestrationReadModel = createEmptyReadModel(CREATED_AT);
    for (const event of events) {
      model = yield* projectEvent(model, event);
    }
    return model;
  });

it.effect("keeps a ticket App Review budget separate from the run's own", () =>
  Effect.gen(function* () {
    const model = yield* applyAll([
      threadCreated(),
      setCycles({ workflowPromptId: APP_REVIEW_PROMPT_ID, maxCycles: 20 }),
      setCycles({
        workflowPromptId: APP_REVIEW_PROMPT_ID,
        stepWorkflowPromptId: TICKET_WAVE_PROMPT_ID,
        maxCycles: 2,
      }),
    ]);

    expect(model.threads[0]?.workflowStepCycles).toEqual([
      { workflowPromptId: APP_REVIEW_PROMPT_ID, maxCycles: 20 },
      {
        workflowPromptId: APP_REVIEW_PROMPT_ID,
        stepWorkflowPromptId: TICKET_WAVE_PROMPT_ID,
        maxCycles: 2,
      },
    ]);
  }),
);

it.effect("replaces a budget in place and clears only the one it names", () =>
  Effect.gen(function* () {
    const model = yield* applyAll([
      threadCreated(),
      setCycles({ workflowPromptId: "planning.ticket-reviewer.codex", maxCycles: 8 }),
      setCycles({ workflowPromptId: APP_REVIEW_PROMPT_ID, maxCycles: 20 }),
      setCycles({ workflowPromptId: APP_REVIEW_PROMPT_ID, maxCycles: 15 }),
      setCycles({ workflowPromptId: APP_REVIEW_PROMPT_ID, maxCycles: null }),
    ]);

    expect(model.threads[0]?.workflowStepCycles).toEqual([
      { workflowPromptId: "planning.ticket-reviewer.codex", maxCycles: 8 },
    ]);
  }),
);

it.effect("does not move the thread's updatedAt", () =>
  Effect.gen(function* () {
    // A budget is configuration. Touching updatedAt would jump the run around
    // the inbox every time a step is retuned.
    const model = yield* applyAll([
      threadCreated(),
      setCycles({ workflowPromptId: APP_REVIEW_PROMPT_ID, maxCycles: 20 }),
    ]);

    expect(model.threads[0]?.updatedAt).toBe(CREATED_AT);
  }),
);
