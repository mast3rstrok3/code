import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ProviderInstanceConfigMap,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { WORKFLOW_PROMPT_IDS } from "../provider/WorkflowPromptRegistry.ts";
import {
  resolveWorkflowSubagentModelSelection,
  resolveWorkflowSubagentSpawnDefinition,
} from "./workflowSubagents.ts";

const codexDriver = ProviderDriverKind.make("codex");

const browserDevReviewDefinition = resolveWorkflowSubagentSpawnDefinition(
  WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
);
const planningReviewerDefinition = resolveWorkflowSubagentSpawnDefinition(
  WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex,
);

const claudeParentSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-4-8",
};

const hardlockOptions = [{ id: "reasoningEffort", value: "high" }];

function settingsWith(input: {
  readonly legacyCodexEnabled?: boolean;
  readonly providerInstances?: ProviderInstanceConfigMap;
}): ServerSettings {
  return {
    ...DEFAULT_SERVER_SETTINGS,
    ...(input.providerInstances !== undefined
      ? { providerInstances: input.providerInstances }
      : {}),
    providers: {
      ...DEFAULT_SERVER_SETTINGS.providers,
      codex: {
        ...DEFAULT_SERVER_SETTINGS.providers.codex,
        enabled: input.legacyCodexEnabled ?? true,
      },
    },
  };
}

describe("resolveWorkflowSubagentSpawnDefinition", () => {
  it("registers only the explicit Product workflow presets", () => {
    for (const workflowPromptId of [
      WORKFLOW_PROMPT_IDS.productFixCodex,
      WORKFLOW_PROMPT_IDS.productFastFeatureCodex,
      WORKFLOW_PROMPT_IDS.productFullFeatureCodex,
    ]) {
      expect(resolveWorkflowSubagentSpawnDefinition(workflowPromptId)).toMatchObject({
        workflowPromptId,
        interactionMode: "product-workflow",
        workflowRole: null,
        expectedResult: "product-intent-locked",
      });
    }
    expect(resolveWorkflowSubagentSpawnDefinition("product.workflow.codex")).toBeUndefined();
  });

  it("registers the implementation code reviewer sub-agent", () => {
    const definition = resolveWorkflowSubagentSpawnDefinition(
      WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
    );
    expect(definition).toMatchObject({
      workflowPromptId: WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
      interactionMode: "implementation-workflow",
      workflowRole: "implementation-code-reviewer",
      expectedResult: "implementation-code-review-result",
      allowedParentWorkflowRoles: [null, "implementation-orchestrator"],
    });
  });
});

describe("resolveWorkflowSubagentModelSelection", () => {
  it("inherits the parent selection for definitions without a model override", () => {
    const resolved = resolveWorkflowSubagentModelSelection({
      definition: planningReviewerDefinition,
      parentModelSelection: claudeParentSelection,
      settings: settingsWith({}),
    });
    expect(resolved).toEqual({
      modelSelection: claudeParentSelection,
      overrideApplied: false,
      fallbackDetail: null,
    });
  });

  it("prefers the parent's own codex instance when it is enabled", () => {
    const parentSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make("codex_work"),
      model: "gpt-5.4",
    };
    const resolved = resolveWorkflowSubagentModelSelection({
      definition: browserDevReviewDefinition,
      parentModelSelection: parentSelection,
      settings: settingsWith({
        providerInstances: {
          [ProviderInstanceId.make("codex")]: { driver: codexDriver, enabled: true },
          [ProviderInstanceId.make("codex_work")]: { driver: codexDriver, enabled: true },
        },
      }),
    });
    expect(resolved.overrideApplied).toBe(true);
    expect(resolved.fallbackDetail).toBeNull();
    expect(resolved.modelSelection).toEqual({
      instanceId: "codex_work",
      model: "gpt-5.6-sol",
      options: hardlockOptions,
    });
  });

  it("picks the default codex instance over other enabled instances", () => {
    const resolved = resolveWorkflowSubagentModelSelection({
      definition: browserDevReviewDefinition,
      parentModelSelection: claudeParentSelection,
      settings: settingsWith({
        providerInstances: {
          [ProviderInstanceId.make("codex_work")]: { driver: codexDriver, enabled: true },
          [ProviderInstanceId.make("codex")]: { driver: codexDriver, enabled: true },
        },
      }),
    });
    expect(resolved.modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-sol",
      options: hardlockOptions,
    });
  });

  it("falls back to another enabled codex instance when the default is disabled", () => {
    const resolved = resolveWorkflowSubagentModelSelection({
      definition: browserDevReviewDefinition,
      parentModelSelection: claudeParentSelection,
      settings: settingsWith({
        providerInstances: {
          [ProviderInstanceId.make("codex")]: { driver: codexDriver, enabled: false },
          [ProviderInstanceId.make("codex_work")]: { driver: codexDriver, enabled: true },
        },
      }),
    });
    expect(resolved.modelSelection).toEqual({
      instanceId: "codex_work",
      model: "gpt-5.6-sol",
      options: hardlockOptions,
    });
  });

  it("falls back to the parent selection when every codex instance is disabled", () => {
    const resolved = resolveWorkflowSubagentModelSelection({
      definition: browserDevReviewDefinition,
      parentModelSelection: claudeParentSelection,
      settings: settingsWith({
        legacyCodexEnabled: true,
        providerInstances: {
          [ProviderInstanceId.make("codex")]: { driver: codexDriver, enabled: false },
          [ProviderInstanceId.make("codex_work")]: { driver: codexDriver, enabled: false },
          [ProviderInstanceId.make("claudeAgent")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: true,
          },
        },
      }),
    });
    expect(resolved.modelSelection).toEqual(claudeParentSelection);
    expect(resolved.overrideApplied).toBe(false);
    expect(resolved.fallbackDetail).toContain("codex");
    expect(resolved.fallbackDetail).toContain("gpt-5.6-sol");
  });

  it("uses the synthesized legacy codex instance when it is enabled", () => {
    const resolved = resolveWorkflowSubagentModelSelection({
      definition: browserDevReviewDefinition,
      parentModelSelection: claudeParentSelection,
      settings: settingsWith({ legacyCodexEnabled: true }),
    });
    expect(resolved.modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-sol",
      options: hardlockOptions,
    });
  });

  it("falls back when only the legacy codex settings exist and are disabled", () => {
    const resolved = resolveWorkflowSubagentModelSelection({
      definition: browserDevReviewDefinition,
      parentModelSelection: claudeParentSelection,
      settings: settingsWith({ legacyCodexEnabled: false }),
    });
    expect(resolved.modelSelection).toEqual(claudeParentSelection);
    expect(resolved.overrideApplied).toBe(false);
    expect(resolved.fallbackDetail).not.toBeNull();
  });

  it("falls back to the parent selection when settings could not be read", () => {
    const resolved = resolveWorkflowSubagentModelSelection({
      definition: browserDevReviewDefinition,
      parentModelSelection: claudeParentSelection,
      settings: undefined,
    });
    expect(resolved.modelSelection).toEqual(claudeParentSelection);
    expect(resolved.overrideApplied).toBe(false);
    expect(resolved.fallbackDetail).not.toBeNull();
  });
});
