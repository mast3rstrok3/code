import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { WorkflowStepReviewPartPins } from "./WorkflowStepReviewParts";

const APP_REVIEW = "implementation.browser-app-review.codex";
const TDD = "implementation.tdd.codex";

describe("WorkflowStepReviewPartPins", () => {
  it("shows the run's own parts, not the standing default, and offers to clear them", () => {
    // The run layer outranks Settings entirely: what the user set on the run
    // they are looking at is what that run does.
    const markup = renderToStaticMarkup(
      <WorkflowStepReviewPartPins
        workflowPromptId={APP_REVIEW}
        subStepWorkflowPromptIds={[]}
        overrides={[{ workflowPromptId: APP_REVIEW, e2e: true, browser: false }]}
        defaults={[{ workflowPromptId: APP_REVIEW, e2e: false, browser: true }]}
        onSetStepReviewParts={() => {}}
      />,
    );

    expect(markup).toContain("App Review parts");
    expect(markup).toContain("E2E tests: yes · Browser review: no");
    expect(markup).toContain("Auto");
  });

  it("follows the standing default until the run sets its own", () => {
    const markup = renderToStaticMarkup(
      <WorkflowStepReviewPartPins
        workflowPromptId={APP_REVIEW}
        subStepWorkflowPromptIds={[]}
        overrides={[]}
        defaults={[{ workflowPromptId: APP_REVIEW, e2e: true, browser: false }]}
        onSetStepReviewParts={() => {}}
      />,
    );

    expect(markup).toContain("E2E tests: yes · Browser review: no");
    // Nothing to clear: the run is following the layer below it.
    expect(markup).not.toContain("Auto");
  });

  it("warns that a step with both parts off is skipped", () => {
    const markup = renderToStaticMarkup(
      <WorkflowStepReviewPartPins
        workflowPromptId={APP_REVIEW}
        subStepWorkflowPromptIds={[]}
        overrides={[{ workflowPromptId: APP_REVIEW, e2e: false, browser: false }]}
        onSetStepReviewParts={() => {}}
      />,
    );

    expect(markup).toContain("this review step is skipped entirely");
  });

  it("targets the ticket review from the step that starts it", () => {
    const markup = renderToStaticMarkup(
      <WorkflowStepReviewPartPins
        workflowPromptId={TDD}
        subStepWorkflowPromptIds={[APP_REVIEW]}
        overrides={[]}
        onSetStepReviewParts={() => {}}
      />,
    );

    expect(markup).toContain("Ticket App Review parts");
    expect(markup).not.toContain(">App Review parts<");
  });

  it("renders nothing for a step that starts no App Review", () => {
    const markup = renderToStaticMarkup(
      <WorkflowStepReviewPartPins
        workflowPromptId="implementation.code-review.codex"
        subStepWorkflowPromptIds={[]}
        overrides={[]}
        onSetStepReviewParts={() => {}}
      />,
    );

    expect(markup).toBe("");
  });
});
