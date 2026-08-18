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
const PINNED_AT = "2026-03-01T01:00:00.000Z";

const claudeSelection = { instanceId: "claudeAgent", model: "claude-opus-5" };
const codexSelection = { instanceId: "codex", model: "gpt-5.6-sol" };

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

const pin = (input: {
  readonly workflowPromptId: string;
  readonly stepWorkflowPromptId?: string;
  readonly modelSelection: unknown;
}) =>
  makeEvent({
    type: "thread.workflow-step-model-set",
    occurredAt: PINNED_AT,
    payload: {
      threadId: "thread-1",
      workflowPromptId: input.workflowPromptId,
      ...(input.stepWorkflowPromptId === undefined
        ? {}
        : { stepWorkflowPromptId: input.stepWorkflowPromptId }),
      modelSelection: input.modelSelection,
      updatedAt: PINNED_AT,
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

it.effect("keeps a sub-step pin separate from the step pin that shares its prompt id", () =>
  Effect.gen(function* () {
    // The per-ticket Code Review and the final Code Review are the same prompt
    // under different steps. Keying pins by prompt id alone would make setting
    // one clear the other.
    const model = yield* applyAll([
      threadCreated(),
      pin({
        workflowPromptId: "implementation.code-review.codex",
        modelSelection: codexSelection,
      }),
      pin({
        workflowPromptId: "implementation.code-review.codex",
        stepWorkflowPromptId: "implementation.tdd.codex",
        modelSelection: claudeSelection,
      }),
    ]);

    expect(model.threads[0]?.workflowStepModels).toEqual([
      {
        workflowPromptId: "implementation.code-review.codex",
        modelSelection: codexSelection,
      },
      {
        workflowPromptId: "implementation.code-review.codex",
        stepWorkflowPromptId: "implementation.tdd.codex",
        modelSelection: claudeSelection,
      },
    ]);
  }),
);

it.effect("replaces a sub-step pin in place and leaves its step's pin standing", () =>
  Effect.gen(function* () {
    const model = yield* applyAll([
      threadCreated(),
      pin({ workflowPromptId: "implementation.tdd.codex", modelSelection: codexSelection }),
      pin({
        workflowPromptId: "implementation.code-review.codex",
        stepWorkflowPromptId: "implementation.tdd.codex",
        modelSelection: codexSelection,
      }),
      pin({
        workflowPromptId: "implementation.code-review.codex",
        stepWorkflowPromptId: "implementation.tdd.codex",
        modelSelection: claudeSelection,
      }),
    ]);

    expect(model.threads[0]?.workflowStepModels).toEqual([
      { workflowPromptId: "implementation.tdd.codex", modelSelection: codexSelection },
      {
        workflowPromptId: "implementation.code-review.codex",
        stepWorkflowPromptId: "implementation.tdd.codex",
        modelSelection: claudeSelection,
      },
    ]);
  }),
);

it.effect("clears only the sub-step pin it names", () =>
  Effect.gen(function* () {
    const model = yield* applyAll([
      threadCreated(),
      pin({ workflowPromptId: "implementation.tdd.codex", modelSelection: codexSelection }),
      pin({
        workflowPromptId: "implementation.code-review.codex",
        stepWorkflowPromptId: "implementation.tdd.codex",
        modelSelection: claudeSelection,
      }),
      pin({
        workflowPromptId: "implementation.code-review.codex",
        stepWorkflowPromptId: "implementation.tdd.codex",
        modelSelection: null,
      }),
    ]);

    expect(model.threads[0]?.workflowStepModels).toEqual([
      { workflowPromptId: "implementation.tdd.codex", modelSelection: codexSelection },
    ]);
  }),
);
