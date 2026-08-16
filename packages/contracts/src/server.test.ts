import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  ServerConfig,
  ServerProvider,
  ServerProviders,
  ServerUpsertKeybindingResult,
  WorkflowCatalog,
  WorkflowPromptContract,
} from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeServerProviders = Schema.decodeUnknownSync(ServerProviders);
const decodeWorkflowPromptContract = Schema.decodeUnknownSync(WorkflowPromptContract);
const decodeWorkflowCatalog = Schema.decodeUnknownSync(WorkflowCatalog);
const decodeUpsertKeybindingResult = Schema.decodeUnknownSync(ServerUpsertKeybindingResult);
const decodeAvailableEditors = Schema.decodeUnknownSync(ServerConfig.fields.availableEditors);

const baseProviderSnapshot = {
  instanceId: "codex",
  driver: "codex",
  enabled: true,
  installed: true,
  version: "1.0.0",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-04-10T00:00:00.000Z",
  models: [],
};

describe("ServerProvider", () => {
  it("decodes workflow catalogs with linked skills and docs", () => {
    const parsed = decodeWorkflowCatalog({
      workflows: [
        {
          id: "fix",
          order: 1,
          title: "Fix",
          description: "Fix it.",
          interactionMode: "product-workflow",
          steps: [{ label: "Intent", skillId: "product.fix.codex" }],
        },
      ],
      skills: [
        {
          id: "product.fix.codex",
          order: 1,
          workflow: "product",
          role: "planning-thread",
          stage: "intent",
          title: "Fix",
          description: "Fix intent.",
          promptText: "Prompt.",
          docIds: ["context"],
          buildModes: ["build"],
          workflowIds: ["fix"],
        },
      ],
      docs: [
        {
          id: "context",
          title: "Context",
          path: "CONTEXT.md",
          description: "Project context.",
          content: "# Context",
          skillIds: ["product.fix.codex"],
        },
      ],
    });
    expect(parsed.workflows[0]?.steps[0]?.skillId).toBe("product.fix.codex");
    expect(parsed.skills[0]?.buildModes).toEqual(["build"]);
    expect(parsed.docs[0]?.description).toBe("Project context.");
  });

  it("defaults new catalog relationship fields from older servers", () => {
    const parsed = decodeWorkflowCatalog({
      workflows: [],
      skills: [
        {
          id: "legacy",
          order: 1,
          workflow: "shared",
          role: "workflow-communications",
          stage: "legacy",
          title: "Legacy",
          description: "Legacy skill.",
          promptText: "Prompt.",
          docIds: [],
          workflowIds: [],
        },
      ],
      docs: [
        { id: "legacy", title: "Legacy", path: "legacy.md", content: "# Legacy", skillIds: [] },
      ],
    });

    expect(parsed.skills[0]?.buildModes).toEqual([]);
    expect(parsed.docs[0]?.description).toBe("Supporting reference for a workflow skill.");
  });

  it("rejects unknown workflow discriminators", () => {
    expect(() =>
      decodeWorkflowPromptContract({
        id: "yolo.grill-stage.codex",
        order: 1,
        workflow: "yolo",
        role: "planning-thread",
        stage: "grill",
        title: "1. Intent Grill",
        description: "Legacy workflow discriminator.",
        promptText: "Prompt text.",
      }),
    ).toThrow();
  });

  it("defaults capability arrays when decoding provider snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.versionAdvisory).toBeUndefined();
    expect(parsed.updateState).toBeUndefined();
  });

  it("defaults one-click update support when decoding older advisory snapshots", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
      versionAdvisory: {
        status: "behind_latest",
        currentVersion: "1.0.0",
        latestVersion: "1.0.1",
        updateCommand: "npm install -g @openai/codex@latest",
        checkedAt: "2026-04-10T00:00:00.000Z",
        message: "Update available.",
      },
    });

    expect(parsed.versionAdvisory?.canUpdate).toBe(false);
  });

  it("decodes continuation group metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex_personal",
      driver: "codex",
      continuation: { groupKey: "codex:home:/Users/julius/.codex" },
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: {
        status: "authenticated",
      },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [],
    });

    expect(parsed.continuation?.groupKey).toBe("codex:home:/Users/julius/.codex");
  });

  it("decodes optional legacy model metadata", () => {
    const parsed = decodeServerProvider({
      instanceId: "codex",
      driver: "codex",
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-04-10T00:00:00.000Z",
      models: [
        {
          slug: "gpt-5.4",
          name: "GPT-5.4",
          isCustom: false,
          isLegacy: true,
          capabilities: null,
        },
      ],
    });

    expect(parsed.models[0]?.isLegacy).toBe(true);
  });
});

describe("server config forward compatibility", () => {
  it("drops config tickets with kinds this build does not know", () => {
    const parsed = decodeUpsertKeybindingResult({
      keybindings: [],
      tickets: [
        { kind: "keybindings.invalid-entry", message: "Bad entry", index: 2 },
        { kind: "keybindings.future-issue", message: "From a newer server" },
      ],
    });

    expect(parsed.tickets).toEqual([
      { kind: "keybindings.invalid-entry", message: "Bad entry", index: 2 },
    ]);
  });

  it("drops editor ids this build does not know", () => {
    const parsed = decodeAvailableEditors(["zed", "some-future-editor", "vscode"]);

    expect(parsed).toEqual(["zed", "vscode"]);
  });

  // A provider status this build has never seen (a new ServerProviderState,
  // ServerProviderAuthStatus, etc. member) previously failed the whole
  // `providers` array, taking every other provider down with it and, since
  // `providers` sits inside `ServerConfig`, failing the whole config decode —
  // an older client would drop its connection over one provider it can't
  // render. Dropping just that element keeps every other provider working.
  it("drops providers this build cannot decode instead of failing the whole array", () => {
    const decodedBase = decodeServerProvider(baseProviderSnapshot);

    const parsed = decodeServerProviders([
      baseProviderSnapshot,
      { ...baseProviderSnapshot, instanceId: "future", status: "some-future-status" },
    ]);

    expect(parsed).toEqual([decodedBase]);
  });
});
