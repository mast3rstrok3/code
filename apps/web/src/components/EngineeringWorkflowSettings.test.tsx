import {
  ProviderInstanceId,
  type ImplementationWorkflowSettings,
  type ModelSelection,
} from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import { EngineeringWorkflowSettings } from "./EngineeringWorkflowSettings";
import type { WorkflowModelChoices } from "./WorkflowModelPins";

const modelSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.6-sol",
};

const choices = {
  instanceEntries: [],
  modelOptionsByInstance: new Map(),
  describeSelection: (selection: ModelSelection) => selection.model,
} as WorkflowModelChoices;

const implementationSettings: ImplementationWorkflowSettings = {
  ticketAppReviewEnabled: true,
  appReviewEnabled: true,
  finalCodeReviewEnabled: true,
  pullRequestCreationEnabled: true,
  pullRequestBabysittingEnabled: true,
};

function render(
  settings: ImplementationWorkflowSettings = implementationSettings,
  preset: "quick-plan" | "planning" = "planning",
): string {
  return renderToStaticMarkup(
    <EngineeringWorkflowSettings
      preset={preset}
      pinFor={() => null}
      rootModelSelection={modelSelection}
      rootLabel="Workflow model"
      choices={choices}
      onSetStepModel={() => {}}
      onSetStepModels={() => {}}
      stepCycles={[]}
      onSetStepCycles={() => {}}
      stepReviewParts={[]}
      onSetStepReviewParts={() => {}}
      implementationSettings={settings}
      onSetImplementationSettings={() => {}}
    />,
  );
}

describe("EngineeringWorkflowSettings", () => {
  it("starts with the model, planning, and implementation sections collapsed", () => {
    const markup = render();

    expect(markup).toContain("Model setup");
    expect(markup).toContain("Planning phase");
    expect(markup).toContain("5 steps");
    expect(markup).toContain("Implementation phase");
    expect(markup).toContain("6 steps");
    expect(markup.match(/aria-expanded="false"/g)).toHaveLength(3);
  });

  it("counts removed implementation steps without changing their order", () => {
    const markup = render({
      ...implementationSettings,
      appReviewEnabled: false,
      finalCodeReviewEnabled: false,
    });

    expect(markup).toContain("4 of 6 steps added");
  });

  it("uses the same phase editor for Quick Feature", () => {
    const markup = render(implementationSettings, "quick-plan");

    expect(markup).toContain("Planning phase");
    expect(markup).toContain("1 step");
    expect(markup).toContain("Implementation phase");
    expect(markup).toContain("5 steps");
  });
});
