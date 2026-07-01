import * as NodeModule from "node:module";

import {
  DevReviewReplayError,
  type DevReviewId,
  type DevReviewRecord,
  type DevReviewReplayMetadata,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import {
  HttpRouter,
  HttpServer,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/unstable/http";

import * as ServerConfig from "../config.ts";
import { DevReviewReplayEventRepository } from "../persistence/Services/DevReviewReplayEvents.ts";

export const DEV_REVIEW_REPLAY_INGEST_PATH = "/api/dev-review/replay/ingest";

export const DevReviewReplayIngestInput = Schema.Struct({
  events: Schema.Array(Schema.Unknown),
});
export type DevReviewReplayIngestInput = typeof DevReviewReplayIngestInput.Type;

export interface DevReviewReplayCaptureStartInput {
  readonly review: DevReviewRecord;
}

export interface DevReviewReplayCaptureStopInput {
  readonly review: DevReviewRecord;
}

export interface DevReviewReplayCaptureIngestInput {
  readonly token: string;
  readonly events: ReadonlyArray<unknown>;
}

export class DevReviewReplayCapture extends Context.Service<
  DevReviewReplayCapture,
  {
    readonly start: (
      input: DevReviewReplayCaptureStartInput,
    ) => Effect.Effect<DevReviewReplayMetadata, DevReviewReplayError>;
    readonly stop: (
      input: DevReviewReplayCaptureStopInput,
    ) => Effect.Effect<DevReviewReplayMetadata, DevReviewReplayError>;
    readonly ingest: (
      input: DevReviewReplayCaptureIngestInput,
    ) => Effect.Effect<DevReviewReplayMetadata, DevReviewReplayError>;
  }
>()("t3/review/DevReviewReplayCapture") {}

interface ActiveReplayCapture {
  readonly reviewId: DevReviewId;
  readonly namespace: string;
  readonly session: string;
  readonly evidenceDir: string;
  readonly initScriptPath: string;
  readonly ingestUrl: string;
  readonly token: string;
  readonly startedAt: string;
  readonly startedAtMillis: number;
  readonly eventCount: number;
  readonly ingestFailed: boolean;
  readonly error: string | null;
}

interface CaptureState {
  readonly captures: ReadonlyMap<DevReviewId, ActiveReplayCapture>;
}

const require = NodeModule.createRequire(import.meta.url);
const decodeIngestInput = Schema.decodeUnknownEffect(DevReviewReplayIngestInput);

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const tokenFromBytes = (bytes: Uint8Array): string => Buffer.from(bytes).toString("base64url");

function safeSegment(value: string): string {
  const normalized = value.replace(/[^a-zA-Z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 72) : "review";
}

function httpEndpointHost(hostname: string): string {
  const normalized = hostname.toLowerCase();
  const endpointHostname =
    normalized === "0.0.0.0" || normalized === "::" || normalized === "[::]"
      ? "127.0.0.1"
      : hostname;
  return endpointHostname.includes(":") && !endpointHostname.startsWith("[")
    ? `[${endpointHostname}]`
    : endpointHostname;
}

function resolveHttpOrigin(server: HttpServer.HttpServer["Service"]): string {
  const address = server.address;
  if (typeof address === "string" || !("port" in address)) {
    return "http://127.0.0.1";
  }
  return `http://${httpEndpointHost(address.hostname)}:${address.port}`;
}

function replayDurationMs(startedAtMillis: number, completedAtMillis: number): number {
  return Math.max(0, completedAtMillis - startedAtMillis);
}

function captureMetadata(
  capture: ActiveReplayCapture,
  overrides: Partial<DevReviewReplayMetadata> = {},
): DevReviewReplayMetadata {
  return {
    status: "recording",
    eventCount: capture.eventCount,
    startedAt: capture.startedAt,
    completedAt: null,
    durationMs: null,
    error: null,
    agentBrowser: {
      namespace: capture.namespace,
      session: capture.session,
      evidenceDir: capture.evidenceDir,
      initScriptPath: capture.initScriptPath,
      ingestUrl: capture.ingestUrl,
    },
    ...overrides,
  };
}

const replayError = (reviewId: DevReviewId | undefined, message: string, cause?: unknown) =>
  new DevReviewReplayError({
    ...(reviewId === undefined ? {} : { reviewId }),
    message,
    ...(cause === undefined ? {} : { cause }),
  });

function buildRrwebInitScript(input: {
  readonly rrwebRecordSource: string;
  readonly ingestUrl: string;
  readonly token: string;
}): string {
  return `;(() => {
${input.rrwebRecordSource}

;(() => {
  if (globalThis.__T3_DEV_REVIEW_RRWEB_CAPTURE__) return;
  const endpoint = ${JSON.stringify(input.ingestUrl)};
  const token = ${JSON.stringify(input.token)};
  const batchSize = 50;
  const flushMs = 1000;
  const state = {
    pending: [],
    flushTimer: null,
    stopped: false,
  };

  const clearFlushTimer = () => {
    if (state.flushTimer === null) return;
    globalThis.clearTimeout(state.flushTimer);
    state.flushTimer = null;
  };

  const postEvents = (events, keepalive) => {
    if (events.length === 0) return;
    void fetch(endpoint, {
      method: "POST",
      headers: {
        "authorization": "Bearer " + token,
        "content-type": "application/json",
      },
      body: JSON.stringify({ events }),
      keepalive,
    }).catch((error) => {
      console.error("T3 Dev Review RRweb ingest failed", error);
    });
  };

  const flush = (keepalive = false) => {
    clearFlushTimer();
    if (state.pending.length === 0) return;
    const events = state.pending.splice(0, state.pending.length);
    postEvents(events, keepalive);
  };

  const scheduleFlush = () => {
    if (state.flushTimer !== null) return;
    state.flushTimer = globalThis.setTimeout(() => flush(false), flushMs);
  };

  const recorder = globalThis.rrwebRecord;
  if (!recorder || typeof recorder.record !== "function") {
    console.error("T3 Dev Review RRweb recorder is unavailable.");
    return;
  }

  const stop = recorder.record({
    emit(event) {
      state.pending.push(event);
      if (state.pending.length >= batchSize) {
        flush(false);
      } else {
        scheduleFlush();
      }
    },
    maskAllInputs: true,
  });

  globalThis.__T3_DEV_REVIEW_RRWEB_CAPTURE__ = {
    flush,
    stop() {
      if (state.stopped) return;
      state.stopped = true;
      try {
        if (typeof stop === "function") stop();
      } finally {
        flush(true);
      }
    },
  };

  globalThis.addEventListener("pagehide", () => flush(true), { capture: true });
  globalThis.addEventListener("beforeunload", () => flush(true), { capture: true });
})();
})();`;
}

export const make = Effect.gen(function* DevReviewReplayCaptureMake() {
  const config = yield* ServerConfig.ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  const server = yield* HttpServer.HttpServer;
  const replayEventsRepository = yield* DevReviewReplayEventRepository;
  const state = yield* SynchronizedRef.make<CaptureState>({ captures: new Map() });
  const rrwebRecordEntryPath = require.resolve("@rrweb/record");
  const rrwebRecordPath = path.join(
    path.dirname(path.dirname(rrwebRecordEntryPath)),
    "umd",
    "record.min.js",
  );
  const ingestUrl = `${resolveHttpOrigin(server)}${DEV_REVIEW_REPLAY_INGEST_PATH}`;

  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  const randomHex = (byteCount: number) =>
    crypto.randomBytes(byteCount).pipe(Effect.map(bytesToHex), Effect.orDie);
  const randomToken = crypto.randomBytes(32).pipe(Effect.map(tokenFromBytes), Effect.orDie);

  const start: DevReviewReplayCapture["Service"]["start"] = Effect.fn(
    "DevReviewReplayCapture.start",
  )(function* ({ review }) {
    const startedAt = yield* nowIso;
    const startedAtMillis = yield* Clock.currentTimeMillis;
    const suffix = yield* randomHex(4);
    const token = yield* randomToken;
    const reviewSegment = safeSegment(review.id);
    const namespace = `t3-dev-review-${suffix}`;
    const session = `${reviewSegment}-${suffix}`;
    const evidenceDir = path.join(
      config.attachmentsDir,
      "dev-review-replays",
      reviewSegment,
      suffix,
    );
    const initScriptPath = path.join(evidenceDir, "rrweb-init.js");
    const rrwebRecordSource = yield* fs
      .readFileString(rrwebRecordPath)
      .pipe(
        Effect.mapError((cause) =>
          replayError(review.id, "Failed to read the RRweb recorder bundle.", cause),
        ),
      );

    yield* fs
      .makeDirectory(evidenceDir, { recursive: true })
      .pipe(
        Effect.mapError((cause) =>
          replayError(review.id, "Failed to create Dev Review replay evidence directory.", cause),
        ),
      );
    yield* fs
      .writeFileString(
        initScriptPath,
        buildRrwebInitScript({
          rrwebRecordSource,
          ingestUrl,
          token,
        }),
      )
      .pipe(
        Effect.mapError((cause) =>
          replayError(review.id, "Failed to write Dev Review replay init script.", cause),
        ),
      );

    const capture: ActiveReplayCapture = {
      reviewId: review.id,
      namespace,
      session,
      evidenceDir,
      initScriptPath,
      ingestUrl,
      token,
      startedAt,
      startedAtMillis,
      eventCount: 0,
      ingestFailed: false,
      error: null,
    };
    yield* SynchronizedRef.update(state, ({ captures }) => {
      const next = new Map(captures);
      next.set(review.id, capture);
      return { captures: next };
    });
    return captureMetadata(capture);
  });

  const stop: DevReviewReplayCapture["Service"]["stop"] = Effect.fn("DevReviewReplayCapture.stop")(
    function* ({ review }) {
      const completedAt = yield* nowIso;
      const completedAtMillis = yield* Clock.currentTimeMillis;
      const capture = yield* SynchronizedRef.modify(state, ({ captures }) => {
        const current = captures.get(review.id);
        if (!current) return [undefined, { captures }] as const;
        const next = new Map(captures);
        next.delete(review.id);
        return [current, { captures: next }] as const;
      });

      if (!capture) {
        return {
          status: "failed",
          eventCount: 0,
          startedAt: review.replay.startedAt,
          completedAt,
          durationMs: null,
          error: "No active Agent Browser replay capture was found for this Dev Review.",
        };
      }

      const durationMs = replayDurationMs(capture.startedAtMillis, completedAtMillis);
      if (capture.ingestFailed) {
        return captureMetadata(capture, {
          status: "failed",
          completedAt,
          durationMs,
          error: capture.error ?? "Dev Review replay ingest failed.",
        });
      }
      if (capture.eventCount <= 0) {
        return captureMetadata(capture, {
          status: "failed",
          completedAt,
          durationMs,
          error: "RRweb replay capture produced zero events.",
        });
      }
      return captureMetadata(capture, {
        status: "saved",
        completedAt,
        durationMs,
        error: null,
      });
    },
  );

  const ingest: DevReviewReplayCapture["Service"]["ingest"] = Effect.fn(
    "DevReviewReplayCapture.ingest",
  )(function* ({ token, events }) {
    const capture = yield* SynchronizedRef.get(state).pipe(
      Effect.map(({ captures }) =>
        Array.from(captures.values()).find((entry) => entry.token === token),
      ),
    );
    if (!capture) {
      return yield* replayError(undefined, "Invalid Dev Review replay ingest token.");
    }
    if (events.length === 0) return captureMetadata(capture);

    const createdAt = yield* nowIso;
    const appendResult = yield* Effect.exit(
      replayEventsRepository.appendEvents({
        reviewId: capture.reviewId,
        events: [...events],
        createdAt,
      }),
    );
    if (appendResult._tag === "Failure") {
      const error = "Failed to append Dev Review replay events.";
      yield* SynchronizedRef.update(state, ({ captures }) => {
        const current = captures.get(capture.reviewId);
        if (!current) return { captures };
        const next = new Map(captures);
        next.set(capture.reviewId, {
          ...current,
          ingestFailed: true,
          error,
        });
        return { captures: next };
      });
      return yield* replayError(capture.reviewId, error, appendResult.cause);
    }

    return yield* SynchronizedRef.modify(state, ({ captures }) => {
      const current = captures.get(capture.reviewId);
      if (!current) return [captureMetadata(capture), { captures }] as const;
      const nextCapture = {
        ...current,
        eventCount: current.eventCount + events.length,
      };
      const next = new Map(captures);
      next.set(capture.reviewId, nextCapture);
      return [captureMetadata(nextCapture), { captures: next }] as const;
    });
  });

  return DevReviewReplayCapture.of({ start, stop, ingest });
});

export const layer = Layer.effect(DevReviewReplayCapture, make);

const unauthorized = () =>
  HttpServerResponse.jsonUnsafe(
    {
      error: "invalid_dev_review_replay_token",
      message: "A valid Dev Review replay ingest bearer token is required.",
    },
    { status: 401, headers: { "cache-control": "no-store" } },
  );

export const routeLayer = HttpRouter.add(
  "POST",
  DEV_REVIEW_REPLAY_INGEST_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const authorization = request.headers.authorization;
    const token =
      authorization?.startsWith("Bearer ") === true
        ? authorization.slice("Bearer ".length).trim()
        : "";
    if (token.length === 0) return unauthorized();

    const payloadExit = yield* Effect.exit(request.json);
    if (payloadExit._tag === "Failure") {
      return HttpServerResponse.jsonUnsafe({ error: "invalid_json" }, { status: 400 });
    }

    const inputExit = yield* Effect.exit(decodeIngestInput(payloadExit.value));
    if (inputExit._tag === "Failure") {
      return HttpServerResponse.jsonUnsafe({ error: "invalid_payload" }, { status: 400 });
    }

    const capture = yield* DevReviewReplayCapture;
    return yield* capture
      .ingest({
        token,
        events: inputExit.value.events,
      })
      .pipe(
        Effect.match({
          onFailure: (error) =>
            HttpServerResponse.jsonUnsafe(
              { error: error._tag, message: error.message },
              {
                status: error.message === "Invalid Dev Review replay ingest token." ? 401 : 500,
                headers: { "cache-control": "no-store" },
              },
            ),
          onSuccess: (metadata) =>
            HttpServerResponse.jsonUnsafe(metadata, {
              status: 202,
              headers: { "cache-control": "no-store" },
            }),
        }),
      );
  }),
);
