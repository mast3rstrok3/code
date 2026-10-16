import { assert, describe, it } from "@effect/vitest";
import { ThreadId, type UserInputQuestion } from "@t3tools/contracts";

import {
  grillJudgeThreadId,
  grillRootOfJudgeThread,
  grillTask,
  nextGrillJudgeAction,
  openGrillQuestions,
  parseGrillJudgeAnswers,
} from "./grillJudge.ts";

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
const lockIn: UserInputQuestion = {
  id: "lock",
  header: "Lock in",
  question: "Is the shared understanding complete?",
  options: [
    { label: "Lock it in", description: "Continue to the Spec." },
    { label: "Keep grilling", description: "Ask more." },
  ],
  recommendation: { optionLabel: "Lock it in", rationale: "Every decision is settled." },
  multiSelect: false,
};

const activity = (kind: string, payload: Record<string, unknown>) =>
  ({
    id: `${kind}:${String(payload.requestId)}`,
    tone: "info",
    kind,
    summary: kind,
    payload,
    turnId: null,
    createdAt: "2026-10-16T10:00:00.000Z",
  }) as never;

const judgeReply = (answers: Record<string, unknown>) =>
  [
    "Scope: the ticket names one form, so the narrow fix stands.",
    "```json",
    JSON.stringify({ type: "grill-judge-answers", answers }),
    "```",
  ].join("\n");

describe("grillJudge", () => {
  it("names the judge thread after its root and back", () => {
    const root = ThreadId.make("thread-engineering");
    assert.strictEqual(grillRootOfJudgeThread(grillJudgeThreadId(root)), root);
    assert.strictEqual(grillRootOfJudgeThread(root), null);
  });

  it("lists only the question cards still waiting, oldest first", () => {
    const open = openGrillQuestions([
      activity("user-input.requested", { requestId: "r1", questions: [scope] }),
      activity("user-input.resolved", { requestId: "r1", answers: { scope: "Only the form" } }),
      activity("user-input.requested", { requestId: "r2", questions: [lockIn] }),
      activity("user-input.requested", {
        requestId: "r3",
        questions: [scope],
        responseMode: "message",
      }),
      activity("user-input.requested", { requestId: "r4", questions: [scope] }),
      activity("provider.user-input.respond.failed", { requestId: "r4" }),
    ]);
    assert.deepStrictEqual(
      open.map((question) => question.requestId),
      ["r2"],
    );
  });

  it("reads the task without the skill text the launch appended", () => {
    assert.strictEqual(
      grillTask([
        {
          role: "user",
          text: '{"feedbackId":"abc"}\n\n<workflow-skill id="x">grill</workflow-skill>',
        },
        { role: "user", text: "later" },
      ]),
      '{"feedbackId":"abc"}',
    );
    assert.strictEqual(grillTask([{ role: "assistant", text: "hi" }]), null);
  });

  it("takes the judge's answers from its last answers block", () => {
    assert.deepStrictEqual(
      parseGrillJudgeAnswers(judgeReply({ scope: " Only the form ", lock: "Lock it in" }), [
        scope,
        lockIn,
      ]),
      { ok: true, answers: { scope: "Only the form", lock: "Lock it in" } },
    );
  });

  it("refuses a reply that leaves a question unanswered or has no answers block", () => {
    const missing = parseGrillJudgeAnswers(judgeReply({ scope: "Only the form" }), [scope, lockIn]);
    assert.isFalse(missing.ok);
    assert.include(missing.ok ? "" : missing.problem, "lock");
    assert.isFalse(parseGrillJudgeAnswers("Only the form.", [scope]).ok);
    // A list answers only a question that allows several choices.
    assert.isFalse(parseGrillJudgeAnswers(judgeReply({ scope: ["Only the form"] }), [scope]).ok);
    assert.deepStrictEqual(
      parseGrillJudgeAnswers(judgeReply({ scope: ["Only the form", "Every form"] }), [
        { ...scope, multiSelect: true },
      ]),
      { ok: true, answers: { scope: ["Only the form", "Every form"] } },
    );
  });

  describe("nextGrillJudgeAction", () => {
    const question = { requestId: "r1", questions: [scope, lockIn] };
    const completed = (text: string) => ({
      run: { status: "completed" as const },
      finalText: text,
    });

    it("asks the judge, then waits while its turn runs", () => {
      assert.deepStrictEqual(nextGrillJudgeAction({ question, first: null, retry: null }), {
        type: "ask",
        attempt: 1,
        problem: null,
      });
      assert.isNull(
        nextGrillJudgeAction({
          question,
          first: { run: { status: "running" }, finalText: null },
          retry: null,
        }),
      );
    });

    it("answers the card with the judge's answers", () => {
      assert.deepStrictEqual(
        nextGrillJudgeAction({
          question,
          first: completed(judgeReply({ scope: "Every form", lock: "Lock it in" })),
          retry: null,
        }),
        {
          type: "answer",
          answers: { scope: "Every form", lock: "Lock it in" },
          fallbackReason: null,
        },
      );
    });

    it("retries once with the problem, then falls back to the Grill's recommendations", () => {
      const unusable = completed("I think the narrow fix is right.");
      const retry = nextGrillJudgeAction({ question, first: unusable, retry: null });
      assert.strictEqual(retry?.type, "ask");
      assert.strictEqual(retry?.type === "ask" ? retry.attempt : null, 2);

      const fallback = nextGrillJudgeAction({
        question,
        first: unusable,
        retry: { run: { status: "failed" }, finalText: null },
      });
      assert.deepStrictEqual(fallback, {
        type: "answer",
        answers: { scope: "Only the form", lock: "Lock it in" },
        fallbackReason: "the judge's turn ended as failed.",
      });
    });
  });
});
