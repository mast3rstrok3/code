import { ApprovalRequestId, type UserInputQuestion } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import type { PendingUserInput } from "../../session-logic";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";

function makeQuestion(index: number): UserInputQuestion {
  return {
    id: `question_${index}`,
    header: `Question ${index}`,
    question: `Which direction should question ${index} take?`,
    options: [
      { label: "Complete", description: "Ship every path together." },
      { label: "Incremental", description: "Ship the core path first." },
    ],
    recommendation: {
      optionLabel: "Incremental",
      rationale: "It creates the fastest useful feedback loop.",
    },
    multiSelect: false,
  };
}

function renderPanel(questions: ReadonlyArray<UserInputQuestion>, questionIndex: number) {
  const pendingUserInput: PendingUserInput = {
    requestId: ApprovalRequestId.make("request-1"),
    createdAt: "2026-08-09T00:00:00.000Z",
    questions,
  };
  return renderToStaticMarkup(
    <ComposerPendingUserInputPanel
      pendingUserInputs={[pendingUserInput]}
      respondingRequestIds={[]}
      answers={{}}
      questionIndex={questionIndex}
      onToggleOption={() => undefined}
      onAdvance={() => undefined}
    />,
  );
}

describe("ComposerPendingUserInputPanel", () => {
  it("renders unchanged option descriptions and a separate recommendation through 7/7", () => {
    const markup = renderPanel(
      Array.from({ length: 7 }, (_, index) => makeQuestion(index + 1)),
      6,
    );

    expect(markup).toContain("7/7");
    expect(markup).toContain("Complete");
    expect(markup).toContain("Ship every path together.");
    expect(markup).toContain("Incremental");
    expect(markup).toContain("Ship the core path first.");
    expect(markup).toContain("Recommended: Incremental");
    expect(markup).toContain("It creates the fastest useful feedback loop.");
    expect(markup).not.toContain("Incremental (Recommended)");
    expect(markup).not.toContain("Why that?");
  });

  it("keeps historic questions unchanged when recommendation metadata is absent", () => {
    const { recommendation: _recommendation, ...historicQuestion } = makeQuestion(1);
    const markup = renderPanel([historicQuestion], 0);

    expect(markup).toContain("Incremental");
    expect(markup).not.toContain("Recommended:");
  });
});
