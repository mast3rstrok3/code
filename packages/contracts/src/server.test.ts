import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ServerProvider, WorkflowCatalog, WorkflowPromptContract } from "./server.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeWorkflowPromptContract = Schema.decodeUnknownSync(WorkflowPromptContract);
const decodeWorkflowCatalog = Schema.decodeUnknownSync(WorkflowCatalog);

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
          workflowIds: ["fix"],
        },
      ],
      docs: [
        {
          id: "context",
          title: "Context",
          path: "CONTEXT.md",
          content: "# Context",
          skillIds: ["product.fix.codex"],
        },
      ],
    });
    expect(parsed.workflows[0]?.steps[0]?.skillId).toBe("product.fix.codex");
  });

  it("rejects legacy YOLO workflow prompt contracts", () => {
    expect(() =>
      decodeWorkflowPromptContract({
        id: "product.workflow.codex",
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
});
