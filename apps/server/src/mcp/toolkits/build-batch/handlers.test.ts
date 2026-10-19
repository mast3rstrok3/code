import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";
import { McpSchema, McpServer } from "effect/ai";

import * as BuildBatchService from "../../../buildBatch/BuildBatchService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ProcessRunner from "../../../processRunner.ts";
import { layerBuildBatchToolkit } from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";

const NOT_FOUND = 'Error from server (NotFound): configmaps "healthcare-build-batches" not found\n';

const invocation: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("env-1"),
  capabilities: new Set(),
  issuedAt: 1,
  thread: {
    threadId: ThreadId.make("thread-1"),
    providerSessionId: "session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  requestNamespace: "build-batch-test",
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "build-batch-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "build-batch-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

interface Call {
  readonly args: ReadonlyArray<string>;
  readonly stdin: string | undefined;
}

/** The MCP server with the build batch tools, a fake kubectl, and a ConfigMap holding `data`. */
function harness(
  input: {
    readonly enabled?: boolean;
    readonly data?: Record<string, string> | null;
  } = {},
) {
  const calls: Array<Call> = [];
  const runner = Layer.succeed(
    ProcessRunner.ProcessRunner,
    ProcessRunner.ProcessRunner.of({
      run: (request) =>
        Effect.sync(() => {
          calls.push({ args: request.args, stdin: request.stdin });
          const missing = input.data === null;
          const stdout =
            request.args.includes("get") && !missing
              ? JSON.stringify({ kind: "ConfigMap", data: input.data ?? {} })
              : "";
          return {
            stdout,
            stderr: missing ? NOT_FOUND : "",
            code: ChildProcessSpawner.ExitCode(missing ? 1 : 0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          };
        }),
    }),
  );
  const service = BuildBatchService.layer.pipe(
    Layer.provide(runner),
    Layer.provide(
      Layer.effect(
        ServerConfig.ServerConfig,
        ServerConfig.ServerConfig.pipe(
          Effect.map((config) =>
            ServerConfig.make({ ...config, buildBatchesEnabled: input.enabled ?? true }),
          ),
        ),
      ).pipe(
        Layer.provide(
          ServerConfig.layerTest(process.cwd(), { prefix: "t3-build-batch-test-" }).pipe(
            Layer.provide(NodeServices.layer),
          ),
        ),
      ),
    ),
  );
  const layer = layerBuildBatchToolkit.pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provideMerge(Layer.mergeAll(service, McpToolAccessTestkit.liveThreadsLayer)),
  );
  const call = (name: string, arguments_: Record<string, unknown> = {}) =>
    McpServer.McpServer.pipe(
      Effect.flatMap((server) => server.callTool({ name, arguments: arguments_ })),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation),
      Effect.provideService(McpSchema.McpServerClient, client),
    );
  return { layer, calls, call };
}

const at = (iso: string) => TestClock.setTime(Date.parse(iso));

it.effect("start writes one merge patch with the end in whole seconds and the thread", () => {
  const test = harness();
  return Effect.gen(function* () {
    yield* at("2026-10-14T14:43:10.700Z");
    const result = yield* test.call("build_batch_start", { app: "rudi", hours: 1.5 });
    expect(result.isError).not.toBe(true);
    const until = Math.floor(Date.parse("2026-10-14T14:43:10.700Z") / 1000 + 1.5 * 3600);
    expect(result.structuredContent).toEqual({
      key: "rudi.dev",
      reason: "merging several pull requests (thread thread-1)",
      until: "2026-10-14T16:13:10.000Z",
    });
    expect(test.calls).toEqual([
      {
        args: [
          "-n",
          "argo",
          "patch",
          "configmap",
          "healthcare-build-batches",
          "--type=merge",
          "--patch-file=/dev/stdin",
        ],
        stdin: JSON.stringify({
          data: {
            "rudi.dev": JSON.stringify({
              reason: "merging several pull requests (thread thread-1)",
              until,
            }),
          },
        }),
      },
    ]);
    expect(Number.isInteger(until)).toBe(true);

    yield* test.call("build_batch_start", {
      app: "medical-repository",
      branch: "staging",
      reason: "three schema PRs",
    });
    expect(JSON.parse(test.calls[1]?.stdin ?? "")).toEqual({
      data: {
        "medical-repository.staging": JSON.stringify({
          reason: "three schema PRs (thread thread-1)",
          until: Math.floor(Date.parse("2026-10-14T14:43:10.700Z") / 1000) + 2 * 3600,
        }),
      },
    });
  }).pipe(Effect.provide(test.layer));
});

it.effect("start rejects hours outside 0 to 12, unknown branches and app names", () => {
  const test = harness();
  return Effect.gen(function* () {
    for (const arguments_ of [
      { app: "rudi", hours: 0 },
      { app: "rudi", hours: 13 },
      { app: "rudi", hours: -1 },
      { app: "rudi", branch: "feature" },
      { app: "Rudi" },
      { app: "rudi.dev" },
      {},
    ]) {
      const result = yield* test.call("build_batch_start", arguments_).pipe(Effect.result);
      expect(result._tag === "Failure" || result.success.isError === true).toBe(true);
    }
    const unknownBranch = yield* test
      .call("build_batch_finish", { app: "rudi", branch: "release" })
      .pipe(Effect.result);
    expect(unknownBranch._tag === "Failure" || unknownBranch.success.isError === true).toBe(true);
    const twelve = yield* test.call("build_batch_start", { app: "rudi", hours: 12 });
    expect(twelve.isError).not.toBe(true);
    expect(test.calls).toHaveLength(1);
  }).pipe(Effect.provide(test.layer));
});

it.effect("finish removes an open batch and reports the next 10-minute poll", () => {
  const test = harness({
    data: { "rudi.dev": JSON.stringify({ reason: "batch", until: 1_791_999_999 }) },
  });
  return Effect.gen(function* () {
    yield* at("2026-10-14T14:43:10Z");
    const finished = yield* test.call("build_batch_finish", { app: "rudi" });
    expect(finished.structuredContent).toEqual({
      key: "rudi.dev",
      wasOpen: true,
      buildsAt: "2026-10-14T14:50:00.000Z",
    });
    expect(test.calls.map((call) => call.args[2])).toEqual(["get", "patch"]);
    expect(test.calls[1]?.stdin).toBe(JSON.stringify({ data: { "rudi.dev": null } }));

    yield* at("2026-10-14T14:50:00Z");
    const onBoundary = yield* test.call("build_batch_finish", { app: "chat", branch: "main" });
    expect(onBoundary.structuredContent).toEqual({
      key: "chat.main",
      wasOpen: false,
      buildsAt: "2026-10-14T15:00:00.000Z",
    });
    // No batch was open, so nothing is patched.
    expect(test.calls.map((call) => call.args[2])).toEqual(["get", "patch", "get"]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("list returns batches sorted by key and marks those past their end", () => {
  const now = Date.parse("2026-10-14T14:43:10Z") / 1000;
  const test = harness({
    data: {
      "rudi.dev": JSON.stringify({ reason: "open", until: now + 600 }),
      "chat.dev": JSON.stringify({ reason: "ended", until: now }),
    },
  });
  return Effect.gen(function* () {
    yield* at("2026-10-14T14:43:10Z");
    const listed = yield* test.call("build_batch_list");
    expect(listed.isError).not.toBe(true);
    expect(listed.structuredContent).toEqual({
      batches: [
        { key: "chat.dev", reason: "ended", until: "2026-10-14T14:43:10.000Z", expired: true },
        { key: "rudi.dev", reason: "open", until: "2026-10-14T14:53:10.000Z", expired: false },
      ],
    });
    expect(test.calls).toEqual([
      {
        args: ["-n", "argo", "get", "configmap", "healthcare-build-batches", "-o", "json"],
        stdin: undefined,
      },
    ]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("every tool fails without kubectl while the setting is off", () => {
  const test = harness({ enabled: false });
  return Effect.gen(function* () {
    for (const [name, arguments_] of [
      ["build_batch_start", { app: "rudi" }],
      ["build_batch_finish", { app: "rudi" }],
      ["build_batch_list", {}],
    ] as const) {
      const result = yield* test.call(name, arguments_);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain("T3CODE_BUILD_BATCHES_ENABLED=true");
    }
    expect(test.calls).toEqual([]);
  }).pipe(Effect.provide(test.layer));
});

it.effect("a missing ConfigMap says how to create it", () => {
  const test = harness({ data: null });
  return Effect.gen(function* () {
    for (const [name, arguments_] of [
      ["build_batch_start", { app: "rudi" }],
      ["build_batch_finish", { app: "rudi" }],
      ["build_batch_list", {}],
    ] as const) {
      const result = yield* test.call(name, arguments_);
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toContain(
        "sudo python3 scripts/home/build_batch.py start <app>",
      );
    }
  }).pipe(Effect.provide(test.layer));
});

it.effect("registers the three tools", () => {
  const test = harness();
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const tools = server.tools.map(({ tool }) => tool);
    expect(tools.map((tool) => tool.name).toSorted()).toEqual([
      "build_batch_finish",
      "build_batch_list",
      "build_batch_start",
    ]);
    expect(tools.find((tool) => tool.name === "build_batch_list")?.annotations?.readOnlyHint).toBe(
      true,
    );
  }).pipe(Effect.provide(test.layer));
});
