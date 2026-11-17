import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  type AppStack,
  EnvironmentId,
  MessageId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2TurnItem,
  type Project,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as AppStackManager from "../appStack/AppStackManager.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as WizardService from "./WizardService.ts";

const NOW = DateTime.makeUnsafe("2026-11-17T10:00:00.000Z");
const PROJECT_ID = ProjectId.make("project-wizard");
const CODEX = ProviderInstanceId.make("codex");

const project: Project = {
  id: PROJECT_ID,
  title: "healthcare-platform",
  workspaceRoot: "/home/wizard/repos/healthcare-platform",
  defaultModelSelection: { instanceId: CODEX, model: "gpt-5.4" },
  scripts: [],
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
  deletedAt: null,
};

const codex: ServerProvider = {
  instanceId: CODEX,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "test",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-17T00:00:00.000Z",
  models: [
    {
      slug: "gpt-5.4",
      name: "GPT-5.4",
      isCustom: false,
      capabilities: {
        optionDescriptors: [
          {
            id: "reasoningEffort",
            label: "Reasoning",
            type: "select",
            options: [
              { id: "medium", label: "Medium", isDefault: true },
              { id: "high", label: "High" },
            ],
          },
        ],
      },
    },
  ],
  slashCommands: [],
  skills: [],
};

const shellFor = (input: {
  readonly id: ThreadId;
  readonly title: string;
  readonly branch: string;
}): OrchestrationV2ThreadShell => ({
  id: input.id,
  projectId: PROJECT_ID,
  title: input.title,
  providerInstanceId: CODEX,
  modelSelection: { instanceId: CODEX, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: input.branch,
  worktreePath: `/worktrees/${input.id}`,
  activeProviderThreadId: null,
  lineage: { rootThreadId: input.id, parentThreadId: null, relationshipToParent: null },
  forkedFrom: null,
  createdBy: "user",
  creationSource: "server",
  activeRunId: null,
  latestRunId: null,
  status: "running",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  lastVisitedAt: null,
  deletedAt: null,
  tags: [],
});

const assistantItem = (id: string, text: string, streaming: boolean): OrchestrationV2TurnItem =>
  ({
    id: TurnItemId.make(id),
    threadId: ThreadId.make("unused"),
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: streaming ? "running" : "completed",
    title: null,
    startedAt: NOW,
    completedAt: null,
    updatedAt: NOW,
    type: "assistant_message",
    messageId: MessageId.make(`message-${id}`),
    text,
    streaming,
  }) as OrchestrationV2TurnItem;

const stackRecord = (fields: Partial<AppStack> & { readonly id: string }): AppStack =>
  ({
    uuid: fields.id,
    userId: "wizard",
    worktreePath: "/worktrees/unused",
    composePath: "infra/compose/compose.app-dev.yml",
    displayName: null,
    description: null,
    status: "running",
    services: null,
    serviceCount: 0,
    lastError: null,
    errorCount: 0,
    createdAt: "2026-11-17T09:00:00.000Z",
    updatedAt: "2026-11-17T09:00:00.000Z",
    testPassword: "stack-password",
    ...fields,
  }) as AppStack;

const makeHarness = Effect.gen(function* () {
  const shells = new Map<string, OrchestrationV2ThreadShell>();
  const stacks = {
    byWorktree: {
      stack: stackRecord({
        id: "stack-1",
        previewUrls: { frontend: "https://stack.example" },
      }) as AppStack | null,
      frontendUrl: "https://stack.example" as string | null,
      frontendServiceName: "frontend" as string | null,
    },
    all: [] as AppStack[],
    stopped: [] as string[],
    lookups: [] as string[],
  };
  const turnItems: OrchestrationV2TurnItem[] = [];
  const launches: ThreadLaunch.ThreadLaunchInput[] = [];
  const commands: OrchestrationV2ServerCommand[] = [];
  const events = yield* Queue.unbounded<void>();
  const dependencies = Layer.mergeAll(
    NodeCrypto.layer,
    Layer.succeed(WizardService.WizardConfig, {
      token: null,
      projectPath: project.workspaceRoot,
      baseBranch: "origin/dev",
      publicUrl: "https://wizard.example/",
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
      dispatch: (command) =>
        Effect.sync(() => {
          commands.push(command);
          if (command.type === "thread.archive") {
            const shell = shells.get(command.threadId)!;
            shells.set(command.threadId, { ...shell, archivedAt: NOW });
          }
          if (command.type === "thread.tag.set") {
            const shell = shells.get(command.threadId)!;
            const tags = shell.tags ?? [];
            if (!tags.includes(command.tag)) {
              shells.set(command.threadId, { ...shell, tags: [...tags, command.tag] });
            }
          }
          return { sequence: 1, storedEvents: [] };
        }),
      getShellSnapshot: () =>
        Effect.succeed({
          schemaVersion: 1,
          snapshotSequence: 1,
          threads: [...shells.values()],
          archivedThreads: [],
        }),
      getThreadRecords: () =>
        Effect.succeed({ thread: {} as never, turnItems: [...turnItems] }) as never,
      getThreadEventSequence: () => Effect.succeed(1),
      streamStoredEventsFrom: () => Stream.fromQueue(events).pipe(Stream.map(() => ({}) as never)),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: () => Effect.void,
      launch: (input) =>
        Effect.sync(() => {
          launches.push(input);
          const branch =
            input.workspaceStrategy.type === "worktree"
              ? (input.workspaceStrategy.branch ?? "")
              : "";
          shells.set(
            input.threadId!,
            shellFor({ id: input.threadId!, title: input.title, branch }),
          );
          return { threadId: input.threadId! } as never;
        }),
    }),
    Layer.mock(ProjectService.ProjectService)({
      getByWorkspaceRoot: (root) =>
        Effect.succeed(root === project.workspaceRoot ? Option.some(project) : Option.none()),
    }),
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([codex]) }),
    ServerSettings.layerTest(),
    Layer.mock(ServerEnvironment.ServerEnvironment)({
      getEnvironmentId: Effect.succeed(EnvironmentId.make("env-1")),
    }),
    Layer.mock(GitWorkflow.GitWorkflowService)({
      listLocalBranchNames: () => Effect.succeed(["dev", "wizard/dr-anna-weber/fix-the-login"]),
    }),
    Layer.mock(AppStackManager.AppStackManager)({
      status: Effect.succeed({ enabled: true, backendUrl: "https://stacks.example" }),
      getByWorktree: (input) =>
        Effect.sync(() => {
          stacks.lookups.push(`${input.worktreePath}:${input.variant ?? "dev"}`);
          return (input.variant ?? "dev") === "dev"
            ? stacks.byWorktree
            : { stack: null, frontendUrl: null, frontendServiceName: null };
        }),
      list: () => Effect.sync(() => ({ stacks: [...stacks.all] })),
      stop: (input) =>
        Effect.sync(() => {
          stacks.stopped.push(input.stackId);
          return stacks.byWorktree.stack!;
        }),
    }),
  );
  const service = yield* WizardService.WizardService.pipe(
    Effect.provide(WizardService.layer.pipe(Layer.provide(dependencies))),
  );
  return { service, shells, turnItems, launches, commands, events, stacks };
});

const wizard = { id: "user-17", name: "Dr. Anna Weber" };

it.effect("creates one tagged thread per clientRequestId on a fresh wizard branch", () =>
  Effect.gen(function* () {
    const { service, launches, commands } = yield* makeHarness;
    const request = {
      wizard,
      message: "Fix the login\nIt fails for PIs.",
      clientRequestId: "req-1",
    };
    const first = yield* service.createThread(request);
    const again = yield* service.createThread(request);
    assert.strictEqual(again.threadId, first.threadId);
    assert.strictEqual(launches.length, 1);

    const launch = launches[0]!;
    assert.deepStrictEqual(launch.workspaceStrategy, {
      type: "worktree",
      baseRef: "dev",
      startFromOrigin: true,
      // The plain name is taken, so the next free suffix is used.
      branch: "wizard/dr-anna-weber/fix-the-login-2",
    });
    assert.strictEqual(launch.initialMessage?.text, request.message);
    assert.strictEqual(launch.title, "Fix the login");

    const tags = commands.flatMap((command) =>
      command.type === "thread.tag.set" ? [command.tag] : [],
    );
    assert.deepStrictEqual(
      [...new Set(tags)],
      ["wizard", "wizard:user-17", "wizard-name:Dr. Anna Weber"],
    );
    assert.deepStrictEqual(first.wizard, wizard);
    assert.strictEqual(first.url, `https://wizard.example/env-1/${first.threadId}`);
    assert.deepStrictEqual(first.stack, {
      stackId: "stack-1",
      status: "running",
      urls: { frontend: "https://stack.example" },
      testPassword: "stack-password",
    });
    assert.strictEqual(first.state, "working");

    // Another Wizard's request with the same key is a different thread.
    const other = yield* service.createThread({
      ...request,
      wizard: { id: "user-18", name: "Dr. Ben Roth" },
    });
    assert.notStrictEqual(other.threadId, first.threadId);
    assert.deepStrictEqual(
      (yield* service.listThreads("user-18")).map((thread) => thread.threadId),
      [other.threadId],
    );
  }),
);

it.effect("hides threads without the wizard tag", () =>
  Effect.gen(function* () {
    const { service, shells } = yield* makeHarness;
    const id = ThreadId.make("owner-thread");
    shells.set(id, shellFor({ id, title: "Owner work", branch: "main" }));
    const result = yield* service.getThread(id).pipe(Effect.flip);
    assert.strictEqual(result.status, 404);
    assert.deepStrictEqual(yield* service.listThreads(null), []);
  }),
);

it.effect("long-polls the transcript until an item changes, then resends it with a new seq", () =>
  Effect.gen(function* () {
    const { service, turnItems, events } = yield* makeHarness;
    const created = yield* service.createThread({ wizard, message: "Hi", clientRequestId: "r" });
    turnItems.push(assistantItem("a1", "Hel", true));
    const first = yield* service.transcript({ threadId: created.threadId, after: 0, waitMs: 0 });
    assert.deepStrictEqual(
      first.items.map((item) => [item.id, item.text, item.final]),
      [["a1", "Hel", false]],
    );

    const waiting = yield* service
      .transcript({ threadId: created.threadId, after: first.cursor, waitMs: 25_000 })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    turnItems[0] = assistantItem("a1", "Hello", false);
    yield* Queue.offer(events, undefined);
    const grown = yield* Fiber.join(waiting);
    assert.deepStrictEqual(
      grown.items.map((item) => [item.id, item.text, item.final]),
      [["a1", "Hello", true]],
    );
    assert.isAbove(grown.items[0]!.seq, first.items[0]!.seq);
    assert.strictEqual(grown.cursor, grown.items[0]!.seq);

    const idle = yield* service
      .transcript({ threadId: created.threadId, after: grown.cursor, waitMs: 25_000 })
      .pipe(Effect.forkChild);
    yield* TestClock.adjust("25 seconds");
    const empty = yield* Fiber.join(idle);
    assert.deepStrictEqual(empty.items, []);
    assert.strictEqual(empty.cursor, grown.cursor);
  }),
);

it.effect("lists models with their effort options and the project default", () =>
  Effect.gen(function* () {
    const { service } = yield* makeHarness;
    const result = yield* service.models;
    assert.deepStrictEqual(result.models, [
      {
        provider: "codex",
        model: "gpt-5.4",
        label: "codex · GPT-5.4",
        efforts: ["medium", "high"],
        defaultEffort: "medium",
      },
    ]);
    assert.deepStrictEqual(result.default, { provider: "codex", model: "gpt-5.4" });
    const refused = yield* service
      .createThread({
        wizard,
        message: "Hi",
        clientRequestId: "bad-model",
        model: { provider: "codex", model: "gpt-5.4", effort: "max" },
      })
      .pipe(Effect.flip);
    assert.strictEqual(refused.code, "invalid_model");
  }),
);

it.effect("archives once: stops the turn and the stack, then refuses messages with 409", () =>
  Effect.gen(function* () {
    const { service, commands, stacks } = yield* makeHarness;
    const created = yield* service.createThread({ wizard, message: "Hi", clientRequestId: "a" });
    // The harness records commands; it applies thread.archive to the shell as the server would.
    const archiveCommands = () =>
      commands.filter((c) => c.type === "thread.stop" || c.type === "thread.archive");

    yield* service.archive(created.threadId);
    assert.deepStrictEqual(
      archiveCommands().map((command) => command.type),
      ["thread.stop", "thread.archive"],
    );
    assert.deepStrictEqual(stacks.stopped, ["stack-1"]);
    assert.deepStrictEqual(stacks.lookups, [
      `/worktrees/${created.threadId}:dev`,
      `/worktrees/${created.threadId}:dev`,
      `/worktrees/${created.threadId}:prod`,
    ]);

    const archived = yield* service.getThread(created.threadId);
    assert.strictEqual(archived.state, "archived");
    // Worktree and branch stay, so an open pull request stays intact.
    assert.strictEqual(archived.branch, "wizard/dr-anna-weber/hi");

    // Repeating it changes nothing.
    yield* service.archive(created.threadId);
    assert.strictEqual(archiveCommands().length, 2);
    assert.deepStrictEqual(stacks.stopped, ["stack-1"]);

    const refused = yield* service
      .sendMessage(created.threadId, { message: "More", clientRequestId: "m1" })
      .pipe(Effect.flip);
    assert.deepStrictEqual([refused.status, refused.code], [409, "archived"]);
  }),
);

it.effect("archives an idle thread without a Stop and leaves stopped or protected stacks", () =>
  Effect.gen(function* () {
    const { service, shells, commands, stacks } = yield* makeHarness;
    const created = yield* service.createThread({ wizard, message: "Hi", clientRequestId: "b" });
    shells.set(created.threadId, { ...shells.get(created.threadId)!, status: "completed" });
    stacks.byWorktree = {
      ...stacks.byWorktree,
      stack: stackRecord({ id: "stack-1", protected: true }),
    };
    yield* service.archive(created.threadId);
    assert.deepStrictEqual(
      commands.filter((c) => c.type === "thread.stop").map((c) => c.type),
      [],
    );
    assert.deepStrictEqual(stacks.stopped, []);
    assert.strictEqual((yield* service.getThread(created.threadId)).state, "archived");
  }),
);

it.effect("keys a platform stack's URLs by its members' service names", () =>
  Effect.gen(function* () {
    const { service, stacks } = yield* makeHarness;
    stacks.byWorktree = {
      // A healthcare-platform worktree's record runs no pods and has no preview URLs.
      stack: stackRecord({ id: "bundle-1", bundleId: "bundle-1", platform: true }),
      frontendUrl: "https://rudi.example",
      frontendServiceName: "frontend",
    };
    stacks.all = [
      stackRecord({ id: "bundle-1", bundleId: "bundle-1", platform: true }),
      stackRecord({
        id: "mr-1",
        app: "medical-repository",
        bundleId: "bundle-1",
        previewUrls: { api: "https://mr.example" },
      }),
      stackRecord({
        id: "rudi-1",
        app: "rudi",
        bundleId: "bundle-1",
        previewUrls: {
          frontend: "https://rudi.example",
          backend: "https://rudi-api.example",
          metro: "https://metro.example",
        },
      }),
      stackRecord({
        id: "other",
        app: "cortex",
        bundleId: "bundle-2",
        previewUrls: { frontend: "https://cortex.example" },
      }),
    ];
    const created = yield* service.createThread({ wizard, message: "Hi", clientRequestId: "c" });
    assert.deepStrictEqual(created.stack, {
      stackId: "bundle-1",
      status: "running",
      urls: {
        frontend: "https://rudi.example",
        backend: "https://rudi-api.example",
        metro: "https://metro.example",
        "medical-repository/api": "https://mr.example",
      },
      testPassword: "stack-password",
    });

    // An app stack names its frontend service itself, here Study Network's `web`.
    stacks.byWorktree = {
      stack: stackRecord({ id: "sn-1", previewUrls: { web: "https://sn.example" } }),
      frontendUrl: "https://sn.example",
      frontendServiceName: "web",
    };
    assert.deepStrictEqual((yield* service.getThread(created.threadId)).stack?.urls, {
      web: "https://sn.example",
    });
  }),
);
