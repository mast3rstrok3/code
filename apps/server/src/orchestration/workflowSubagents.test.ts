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
  findWorkflowStepModels,
  isWorkflowSubagentParentRoleAllowed,
  resolveWorkflowStepModelSelection,
  resolveWorkflowSubagentModelSelection,
  resolveWorkflowSubagentSpawnDefinition,
} from "./workflowSubagents.ts";

const codexDriver = ProviderDriverKind.make("codex");

const browserAppReviewDefinition = resolveWorkflowSubagentSpawnDefinition(
  WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
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
  it("allows Browser App Review owners to launch focused browser lanes", () => {
    expect(browserAppReviewDefinition).toBeDefined();
    expect(
      isWorkflowSubagentParentRoleAllowed(
        browserAppReviewDefinition!,
        "implementation-qa-reviewer",
      ),
    ).toBe(true);
    expect(
      isWorkflowSubagentParentRoleAllowed(browserAppReviewDefinition!, "app-review-reviewer"),
    ).toBe(true);
    expect(isWorkflowSubagentParentRoleAllowed(browserAppReviewDefinition!, null)).toBe(true);
    expect(
      isWorkflowSubagentParentRoleAllowed(
        browserAppReviewDefinition!,
        "implementation-orchestrator",
      ),
    ).toBe(true);
  });

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
      definition: browserAppReviewDefinition,
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
      definition: browserAppReviewDefinition,
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
      definition: browserAppReviewDefinition,
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
      definition: browserAppReviewDefinition,
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
      definition: browserAppReviewDefinition,
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
      definition: browserAppReviewDefinition,
      parentModelSelection: claudeParentSelection,
      settings: settingsWith({ legacyCodexEnabled: false }),
    });
    expect(resolved.modelSelection).toEqual(claudeParentSelection);
    expect(resolved.overrideApplied).toBe(false);
    expect(resolved.fallbackDetail).not.toBeNull();
  });

  it("falls back to the parent selection when settings could not be read", () => {
    const resolved = resolveWorkflowSubagentModelSelection({
      definition: browserAppReviewDefinition,
      parentModelSelection: claudeParentSelection,
      settings: undefined,
    });
    expect(resolved.modelSelection).toEqual(claudeParentSelection);
    expect(resolved.overrideApplied).toBe(false);
    expect(resolved.fallbackDetail).not.toBeNull();
  });
});

const pinnedSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-opus-5",
};

const enabledClaudeSettings = settingsWith({
  providerInstances: {
    [ProviderInstanceId.make("claudeAgent")]: {
      driver: ProviderDriverKind.make("claudeAgent"),
      enabled: true,
    },
  },
});

describe("resolveWorkflowStepModelSelection", () => {
  it("keeps the definition hardlock when the step carries no pin", () => {
    const resolved = resolveWorkflowStepModelSelection({
      workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
      definition: browserAppReviewDefinition,
      stepModels: [],
      parentModelSelection: claudeParentSelection,
      settings: settingsWith({ legacyCodexEnabled: true }),
    });
    expect(resolved.modelSelection).toEqual({
      instanceId: "codex",
      model: "gpt-5.6-sol",
      options: hardlockOptions,
    });
    expect(resolved.overrideApplied).toBe(true);
  });

  it("prefers the user's pin over the definition hardlock", () => {
    const resolved = resolveWorkflowStepModelSelection({
      workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
      definition: browserAppReviewDefinition,
      stepModels: [
        {
          workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
          modelSelection: pinnedSelection,
        },
      ],
      parentModelSelection: claudeParentSelection,
      settings: enabledClaudeSettings,
    });
    expect(resolved.modelSelection).toEqual(pinnedSelection);
    expect(resolved.overrideApplied).toBe(true);
    expect(resolved.fallbackDetail).toBeNull();
  });

  it("ignores a pin for a different step", () => {
    const resolved = resolveWorkflowStepModelSelection({
      workflowPromptId: WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex,
      definition: planningReviewerDefinition,
      stepModels: [
        {
          workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
          modelSelection: pinnedSelection,
        },
      ],
      parentModelSelection: claudeParentSelection,
      settings: enabledClaudeSettings,
    });
    expect(resolved.modelSelection).toEqual(claudeParentSelection);
    expect(resolved.overrideApplied).toBe(false);
  });

  it("lets a step's pin cover the agents that step starts", () => {
    // A per-ticket Code Review runs inside "Execute ticket waves", so pinning
    // that step moves the reviewer too — the step label promises exactly that.
    const resolved = resolveWorkflowStepModelSelection({
      workflowPromptId: WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
      stepWorkflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
      definition: resolveWorkflowSubagentSpawnDefinition(
        WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
      ),
      stepModels: [
        {
          workflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
          modelSelection: pinnedSelection,
        },
      ],
      parentModelSelection: claudeParentSelection,
      settings: enabledClaudeSettings,
    });
    expect(resolved.modelSelection).toEqual(pinnedSelection);
    expect(resolved.overrideApplied).toBe(true);
  });

  it("prefers a sub-step's own pin over the pin of the step that starts it", () => {
    const ownSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-5",
    };
    const resolved = resolveWorkflowStepModelSelection({
      workflowPromptId: WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
      stepWorkflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
      definition: resolveWorkflowSubagentSpawnDefinition(
        WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
      ),
      stepModels: [
        {
          workflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
          modelSelection: pinnedSelection,
        },
        {
          workflowPromptId: WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
          stepWorkflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
          modelSelection: ownSelection,
        },
      ],
      parentModelSelection: claudeParentSelection,
      settings: enabledClaudeSettings,
    });
    expect(resolved.modelSelection).toEqual(ownSelection);
  });

  it("keeps a sub-step out of the identically named step's pin", () => {
    // The final Code Review step and the per-ticket Code Review share a prompt
    // id. Pinning the final step must not silently move every ticket review.
    const finalReviewSelection: ModelSelection = {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-sonnet-5",
    };
    const stepModels = [
      {
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
        modelSelection: finalReviewSelection,
      },
    ];
    const definition = resolveWorkflowSubagentSpawnDefinition(
      WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
    );

    const ticketReview = resolveWorkflowStepModelSelection({
      workflowPromptId: WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
      stepWorkflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
      definition,
      stepModels,
      parentModelSelection: claudeParentSelection,
      settings: enabledClaudeSettings,
    });
    expect(ticketReview.modelSelection).toEqual(claudeParentSelection);

    const finalReview = resolveWorkflowStepModelSelection({
      workflowPromptId: WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
      definition,
      stepModels,
      parentModelSelection: claudeParentSelection,
      settings: enabledClaudeSettings,
    });
    expect(finalReview.modelSelection).toEqual(finalReviewSelection);
  });

  it("falls back and explains when the pinned instance is disabled", () => {
    const resolved = resolveWorkflowStepModelSelection({
      workflowPromptId: WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex,
      definition: planningReviewerDefinition,
      stepModels: [
        {
          workflowPromptId: WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex,
          modelSelection: pinnedSelection,
        },
      ],
      parentModelSelection: claudeParentSelection,
      settings: settingsWith({
        providerInstances: {
          [ProviderInstanceId.make("claudeAgent")]: {
            driver: ProviderDriverKind.make("claudeAgent"),
            enabled: false,
          },
        },
      }),
    });
    expect(resolved.modelSelection).toEqual(claudeParentSelection);
    expect(resolved.overrideApplied).toBe(false);
    expect(resolved.fallbackDetail).toContain("no longer enabled");
  });
});

describe("findWorkflowStepModels", () => {
  const pins = [
    {
      workflowPromptId: WORKFLOW_PROMPT_IDS.implementationTddCodex,
      modelSelection: pinnedSelection,
    },
  ];

  it("reads pins from the workflow root for a nested thread", () => {
    const root = { id: "root", workflowStepModels: pins };
    const child = {
      id: "child",
      workflowContext: { rootThreadId: "root" },
    };
    expect(findWorkflowStepModels(child, [root, child])).toEqual(pins);
  });

  it("reads its own pins when the thread is the root", () => {
    const root = {
      id: "root",
      workflowContext: { rootThreadId: "root" },
      workflowStepModels: pins,
    };
    expect(findWorkflowStepModels(root, [root])).toEqual(pins);
  });

  it("returns undefined when the run has no pins", () => {
    const child = { id: "child", workflowContext: { rootThreadId: "root" } };
    expect(findWorkflowStepModels(child, [{ id: "root" }, child])).toBeUndefined();
  });
});
