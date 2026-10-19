/**
 * Merge batches on the home cluster's app builds (healthcare-infra
 * `scripts/home/build_batch.py`). While a batch is open for `<app>.<branch>`,
 * every build of that route exits without building, so several pull requests
 * can merge and build once. A batch is one key of the ConfigMap
 * `healthcare-build-batches` in namespace `argo`, holding
 * `{"reason": <text>, "until": <epoch seconds>}`. The server's kubectl account
 * may only get and patch that ConfigMap, so it cannot create it or submit a
 * build: a finished batch builds the branch tip at the next 10-minute poll.
 *
 * @module BuildBatchService
 */
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";

const CONFIG_MAP = "healthcare-build-batches";
const NAMESPACE = "argo";
const DEFAULT_REASON = "merging several pull requests";
const DEFAULT_HOURS = 2;
const MAX_HOURS = 12;
/** Builds poll every 10 minutes (cron `*\/10 * * * *`, UTC). */
const POLL_INTERVAL_MS = 10 * 60 * 1000;

export const BuildBatchApp = Schema.String.check(
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
).annotate({ description: "The app, such as rudi, cortex, chat, medical-repository." });

export const BuildBatchBranch = Schema.Literals(["dev", "staging", "main"]).annotate({
  description: "The app branch whose builds the batch holds. Defaults to dev.",
});
type BuildBatchBranch = typeof BuildBatchBranch.Type;

export const BuildBatchHours = Schema.Number.check(
  Schema.isGreaterThan(0),
  Schema.isLessThanOrEqualTo(MAX_HOURS),
).annotate({
  description: `How long the batch stays open unless finished, above 0 and at most ${MAX_HOURS}. Defaults to ${DEFAULT_HOURS}.`,
});

export class BuildBatchDisabledError extends Schema.TaggedError<BuildBatchDisabledError>()(
  "BuildBatchDisabledError",
  {},
) {
  override get message(): string {
    return "Build batches are disabled on this server. It needs T3CODE_BUILD_BATCHES_ENABLED=true.";
  }
}

export class BuildBatchConfigMapMissingError extends Schema.TaggedError<BuildBatchConfigMapMissingError>()(
  "BuildBatchConfigMapMissingError",
  {},
) {
  override get message(): string {
    return `The ConfigMap ${CONFIG_MAP} does not exist in namespace ${NAMESPACE}, and this server may not create it. Run \`sudo python3 scripts/home/build_batch.py start <app>\` in healthcare-infra once to create it.`;
  }
}

export class BuildBatchKubectlError extends Schema.TaggedError<BuildBatchKubectlError>()(
  "BuildBatchKubectlError",
  {
    operation: Schema.Literals(["get", "patch"]),
    exitCode: Schema.NullOr(Schema.Number),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    const exit = this.exitCode === null ? "" : ` (exit code ${this.exitCode})`;
    return `kubectl could not ${this.operation} the ConfigMap ${CONFIG_MAP} in namespace ${NAMESPACE}${exit}. Check the server's KUBECONFIG and its access to that ConfigMap.`;
  }
}

export class BuildBatchInvalidDataError extends Schema.TaggedError<BuildBatchInvalidDataError>()(
  "BuildBatchInvalidDataError",
  { key: Schema.NullOr(Schema.String), cause: Schema.Defect() },
) {
  override get message(): string {
    return this.key === null
      ? `kubectl returned a ConfigMap ${CONFIG_MAP} this server cannot read.`
      : `The batch ${this.key} in ConfigMap ${CONFIG_MAP} is not {"reason": <text>, "until": <epoch seconds>}.`;
  }
}

export type BuildBatchError =
  | BuildBatchDisabledError
  | BuildBatchConfigMapMissingError
  | BuildBatchKubectlError
  | BuildBatchInvalidDataError;

const decodeConfigMap = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Struct({ data: Schema.optional(Schema.Record(Schema.String, Schema.String)) }),
  ),
);
const BatchEntry = Schema.Struct({ reason: Schema.String, until: Schema.Number });
const decodeEntry = Schema.decodeUnknownEffect(Schema.fromJsonString(BatchEntry));
const encodeEntry = Schema.encodeSync(Schema.fromJsonString(BatchEntry));

interface Route {
  readonly app: string;
  readonly branch?: BuildBatchBranch | undefined;
}

interface StartInput extends Route {
  readonly hours?: number | undefined;
  readonly reason?: string | undefined;
  /** Appended to the reason so a batch can be traced to the thread that opened it. */
  readonly threadId?: string | undefined;
}

const routeKey = (route: Route) => `${route.app}.${route.branch ?? "dev"}`;

const isoAt = (millis: number) => DateTime.formatIso(DateTime.makeUnsafe(millis));

export class BuildBatchService extends Context.Service<
  BuildBatchService,
  {
    /** Opens the route's batch, or moves the end of an open one to `hours` from now. */
    readonly start: (
      input: StartInput,
    ) => Effect.Effect<
      { readonly key: string; readonly reason: string; readonly until: string },
      BuildBatchError
    >;
    /** Removes the route's batch; the route builds its branch tip at the next poll. */
    readonly finish: (
      input: Route,
    ) => Effect.Effect<
      { readonly key: string; readonly wasOpen: boolean; readonly buildsAt: string },
      BuildBatchError
    >;
    readonly list: Effect.Effect<
      ReadonlyArray<{
        readonly key: string;
        readonly reason: string;
        readonly until: string;
        readonly expired: boolean;
      }>,
      BuildBatchError
    >;
  }
>()("t3/buildBatch/BuildBatchService") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const runner = yield* ProcessRunner.ProcessRunner;

  const requireEnabled = config.buildBatchesEnabled
    ? Effect.void
    : Effect.fail(new BuildBatchDisabledError());

  // kubectl runs with the server's environment, so its KUBECONFIG picks the account.
  const kubectl = Effect.fn("BuildBatchService.kubectl")(function* (
    operation: "get" | "patch",
    args: ReadonlyArray<string>,
    stdin?: string,
  ) {
    const result = yield* runner
      .run({
        command: "kubectl",
        args: ["-n", NAMESPACE, operation, "configmap", CONFIG_MAP, ...args],
        stdin,
        timeout: "30 seconds",
      })
      .pipe(
        Effect.mapError(
          (cause) => new BuildBatchKubectlError({ operation, exitCode: null, cause }),
        ),
      );
    if (result.code === 0) return result.stdout;
    if (/\(NotFound\)/u.test(result.stderr)) return yield* new BuildBatchConfigMapMissingError();
    return yield* new BuildBatchKubectlError({
      operation,
      exitCode: result.code === null ? null : Number(result.code),
      cause: result.stderr.trim(),
    });
  });

  const readBatches = kubectl("get", ["-o", "json"]).pipe(
    Effect.flatMap((stdout) =>
      decodeConfigMap(stdout).pipe(
        Effect.mapError((cause) => new BuildBatchInvalidDataError({ key: null, cause })),
      ),
    ),
    Effect.map((configMap) => configMap.data ?? {}),
  );

  // A JSON merge patch: a null value removes the key.
  const patch = (data: Record<string, string | null>) =>
    kubectl("patch", ["--type=merge", "--patch-file=/dev/stdin"], JSON.stringify({ data }));

  const start = Effect.fn("BuildBatchService.start")(function* (input: StartInput) {
    yield* requireEnabled;
    const hours = input.hours ?? DEFAULT_HOURS;
    const key = routeKey(input);
    const reason =
      (input.reason?.trim() || DEFAULT_REASON) +
      (input.threadId === undefined ? "" : ` (thread ${input.threadId})`);
    const now = yield* Clock.currentTimeMillis;
    const until = Math.floor(now / 1000 + hours * 3600);
    yield* patch({ [key]: encodeEntry({ reason, until }) });
    return { key, reason, until: isoAt(until * 1000) };
  });

  const finish = Effect.fn("BuildBatchService.finish")(function* (input: Route) {
    yield* requireEnabled;
    const key = routeKey(input);
    const wasOpen = Object.hasOwn(yield* readBatches, key);
    if (wasOpen) yield* patch({ [key]: null });
    const now = yield* Clock.currentTimeMillis;
    const nextPoll = (Math.floor(now / POLL_INTERVAL_MS) + 1) * POLL_INTERVAL_MS;
    return { key, wasOpen, buildsAt: isoAt(nextPoll) };
  });

  const list = Effect.gen(function* () {
    yield* requireEnabled;
    const batches = yield* readBatches;
    const now = yield* Clock.currentTimeMillis;
    return yield* Effect.forEach(Object.keys(batches).toSorted(), (key) =>
      decodeEntry(batches[key]).pipe(
        Effect.mapError((cause) => new BuildBatchInvalidDataError({ key, cause })),
        Effect.map((entry) => ({
          key,
          reason: entry.reason,
          until: isoAt(entry.until * 1000),
          // Builds treat a batch whose end has passed as finished.
          expired: entry.until * 1000 <= now,
        })),
      ),
    );
  }).pipe(Effect.withSpan("BuildBatchService.list"));

  return BuildBatchService.of({ start, finish, list });
});

export const layer = Layer.effect(BuildBatchService, make);
