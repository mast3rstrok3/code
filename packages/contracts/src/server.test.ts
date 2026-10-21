import { ServerConfig, ServerObservability } from "./server.ts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  OtlpEndpointCheckInput,
  resolveEnvironmentMachineKind,
  ServerProvider,
  ServerProviders,
  ServerUpsertKeybindingResult,
  WorkflowCatalog,
  WorkflowPromptContract,
} from "./server.ts";
import { ServerSettings } from "./settings.ts";

const decodeServerProvider = Schema.decodeUnknownSync(ServerProvider);
const decodeServerProviders = Schema.decodeUnknownSync(ServerProviders);
const decodeWorkflowPromptContract = Schema.decodeUnknownSync(WorkflowPromptContract);
const decodeWorkflowCatalog = Schema.decodeUnknownSync(WorkflowCatalog);
const decodeServerObservability = Schema.decodeUnknownSync(ServerObservability);
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
          workflowAnnotations: [
            {
              workflowPromptId: "fix.workflow",
              title: "Workflow variation",
              text: "Use the shared environment.",
            },
          ],
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
    expect(parsed.skills[0]?.workflowAnnotations[0]?.text).toBe("Use the shared environment.");
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

  it.each([undefined, true, false])("decodes workspace command discovery pending=%s", (pending) => {
    const workspace = {
      cwd: "/workspace/project",
      checkedAt: baseProviderSnapshot.checkedAt,
      slashCommands: [{ name: "compact" }],
      ...(pending === undefined ? {} : { slashCommandsPending: pending }),
      skills: [{ name: "project", path: "/workspace/project/SKILL.md", enabled: true }],
    };
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      workspaceSnapshots: [workspace],
    });
    expect(parsed.workspaceSnapshots).toEqual([workspace]);
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
      supportedRuntimeModes: ["approval-required", "future-mode", "full-access"],
      models: [],
    });

    expect(parsed.slashCommands).toEqual([]);
    expect(parsed.skills).toEqual([]);
    expect(parsed.supportedRuntimeModes).toEqual(["approval-required", "full-access"]);
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

  it("preserves installed-version presence through the provider wire codec", () => {
    const encode = Schema.encodeSync(ServerProvider);
    for (const installation of [{}, { installedVersion: null }, { installedVersion: "1.2.3" }]) {
      const decoded = decodeServerProvider({ ...baseProviderSnapshot, ...installation });
      const wire = JSON.parse(JSON.stringify(encode(decoded)));
      expect(wire).toMatchObject({ version: "1.0.0", ...installation });
      expect(Object.hasOwn(wire, "installedVersion")).toBe(
        Object.hasOwn(installation, "installedVersion"),
      );
      expect(decodeServerProvider(wire)).toEqual(decoded);
    }
  });
});

describe("server config forward compatibility", () => {
  it("drops config tickets with kinds this build does not know", () => {
    const parsed = decodeUpsertKeybindingResult({
      keybindings: [],
      issues: [
        { kind: "keybindings.invalid-entry", message: "Bad entry", index: 2 },
        { kind: "keybindings.future-issue", message: "From a newer server" },
      ],
    });

    expect(parsed.issues).toEqual([
      { kind: "keybindings.invalid-entry", message: "Bad entry", index: 2 },
    ]);
  });

  it("drops editor ids this build does not know", () => {
    const parsed = decodeAvailableEditors(["zed", "some-future-editor", "vscode"]);

    expect(parsed).toEqual(["zed", "vscode"]);
  });

  it("drops providers this build cannot decode instead of failing the whole array", () => {
    const decodedBase = decodeServerProvider(baseProviderSnapshot);

    const parsed = decodeServerProviders([
      baseProviderSnapshot,
      { ...baseProviderSnapshot, instanceId: "future", status: "some-future-status" },
    ]);

    expect(parsed).toEqual([decodedBase]);
  });

  it("drops usage windows this build cannot decode instead of failing the provider", () => {
    const parsed = decodeServerProvider({
      ...baseProviderSnapshot,
      usageLimits: {
        checkedAt: "2026-04-10T00:00:00.000Z",
        windows: [
          { id: "primary", kind: "session", label: "Session", usedPercent: 12 },
          { id: "future", kind: "some-future-kind", label: "Future", usedPercent: 1 },
          { id: "bad", kind: "weekly", label: "Weekly", usedPercent: 120 },
        ],
      },
    });

    expect(parsed.usageLimits?.windows).toEqual([
      { id: "primary", kind: "session", label: "Session", usedPercent: 12 },
    ]);
  });
});

describe("resolveEnvironmentMachineKind", () => {
  const decodeDescriptor = Schema.decodeUnknownSync(ExecutionEnvironmentDescriptor);
  const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
  const descriptor = (platform: Record<string, unknown>) =>
    decodeDescriptor({
      environmentId: "env-1",
      label: "Box",
      platform: { os: "linux", arch: "x64", ...platform },
      serverVersion: "1.0.0",
      capabilities: {},
    });

  it("prefers the user's pick over what the server detected", () => {
    expect(
      resolveEnvironmentMachineKind({
        environment: descriptor({ machine: "mac-mini" }),
        settings: decodeSettings({ environmentIcon: "laptop" }),
      }),
    ).toBe("laptop");
  });

  it("drops a machine kind this build does not know instead of failing the descriptor", () => {
    const parsed = descriptor({ machine: "toaster" });

    expect(parsed.platform.machine).toBeUndefined();
    expect(
      resolveEnvironmentMachineKind({ environment: parsed, settings: decodeSettings({}) }),
    ).toBe("server");
  });
});

describe("OtlpEndpointCheckInput", () => {
  const decode = Schema.decodeUnknownSync(OtlpEndpointCheckInput);

  it("accepts HTTP receivers only", () => {
    expect(decode({ signal: "traces", url: "https://collector.example.com/v1/traces" }).url).toBe(
      "https://collector.example.com/v1/traces",
    );
    for (const url of ["data:text/plain,ok", "file:///etc/hosts", "collector:4318/v1/traces"]) {
      expect(() => decode({ signal: "traces", url })).toThrow();
    }
  });
});
