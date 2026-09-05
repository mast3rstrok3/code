import {
  type ServerConfig,
  type ServerConfigStreamEvent,
  WsSubscribeServerConfigRpc,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Equal from "effect/Equal";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as Rpc from "effect/unstable/rpc/Rpc";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcClientError from "effect/unstable/rpc/RpcClientError";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "./protocol.ts";
import { NETWORK_BLOCKING_HINT } from "../errors/network.ts";
import type {
  ConnectionAttemptError,
  ConnectionTransientError,
  PreparedConnection,
} from "../connection/model.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError as ConnectionTransientErrorClass,
} from "../connection/model.ts";
import {
  applyServerConfigProjection,
  type ServerConfigProjection,
  withoutEnvironmentThemes,
} from "../state/serverConfigProjection.ts";

const SOCKET_OPEN_TIMEOUT = "15 seconds";
const RPC_PING_MISS_TOLERANCE = 3;
const MAX_CLOSE_REASON_LENGTH = 200;

interface ObservedWebSocketClose {
  readonly ageMs: number;
  readonly code: number;
  readonly reason: string;
  readonly wasClean: boolean | null;
}

interface ObservedWebSocketError {
  readonly ageMs: number;
  readonly type: string;
}

interface ObservedWebSocketLifecycle {
  close: ObservedWebSocketClose | null;
  error: ObservedWebSocketError | null;
  openedAtMs: number | null;
}

interface ObservedRpcHeartbeat {
  awaitingPong: boolean;
  consecutiveMissedPongs: number;
  lastPingAtMs: number | null;
  lastPongAtMs: number | null;
  pingCount: number;
  pongCount: number;
  timedOut: boolean;
  timeoutAtMs: number | null;
}

export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly initialConfig: Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly subscribeServerConfig: (
    input: ServerConfigSubscriptionInput,
  ) => ServerConfigSubscription;
  readonly ready: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionAttemptError>;
}

export interface RpcSessionOptions {
  readonly environmentThemes?: boolean;
  readonly usageLimitSources?: boolean;
}

export class RpcSessionFactory extends Context.Service<
  RpcSessionFactory,
  {
    readonly connect: (
      connection: PreparedConnection,
    ) => Effect.Effect<RpcSession, ConnectionAttemptError, Scope.Scope>;
  }
>()("@t3tools/client-runtime/rpc/session/RpcSessionFactory") {}

type InitialConfigError = Effect.Error<
  ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverGetConfig]>
>;
type ProbeError = Effect.Error<ReturnType<WsRpcProtocolClient[typeof WS_METHODS.serverProbe]>>;
type ServerConfigSubscriptionError =
  | Rpc.ErrorExit<typeof WsSubscribeServerConfigRpc>
  | RpcClientError.RpcClientError;
type ServerConfigSubscription = Stream.Stream<
  ServerConfigStreamEvent,
  ServerConfigSubscriptionError
>;
type ServerConfigSubscriptionInput = Parameters<
  WsRpcProtocolClient[typeof WS_METHODS.subscribeServerConfig]
>[0];
type EnvironmentThemesUpdatedEvent = Extract<
  ServerConfigStreamEvent,
  { readonly type: "environmentThemesUpdated" }
>;
type UsageLimitSourcesUpdatedEvent = Extract<
  ServerConfigStreamEvent,
  { readonly type: "usageLimitSourcesUpdated" }
>;

interface ServerConfigReplayState {
  readonly projection: ServerConfigProjection;
  readonly revision: number;
  readonly themesEvent: EnvironmentThemesUpdatedEvent | undefined;
  readonly sourcesEvent: UsageLimitSourcesUpdatedEvent | undefined;
}

interface BufferedServerConfigEvent {
  readonly event: ServerConfigStreamEvent;
  readonly replay: ServerConfigReplayState;
  readonly revision: number;
}

function serverConfigReplayEvents(
  state: ServerConfigReplayState,
): ReadonlyArray<ServerConfigStreamEvent> {
  const snapshot = {
    version: 1 as const,
    type: "snapshot" as const,
    config: withoutEnvironmentThemes(state.projection.config),
  };
  return [
    snapshot,
    ...(state.themesEvent === undefined ? [] : [state.themesEvent]),
    ...(state.sourcesEvent === undefined ? [] : [state.sourcesEvent]),
  ];
}

function currentElapsedTimeMs(): number {
  return performance.now();
}

function elapsedSince(startedAtMs: number | null, fallbackStartedAtMs: number): number {
  return Math.max(0, Math.round(currentElapsedTimeMs() - (startedAtMs ?? fallbackStartedAtMs)));
}

function elapsedSinceOptional(startedAtMs: number | null): number | null {
  return startedAtMs === null
    ? null
    : Math.max(0, Math.round(currentElapsedTimeMs() - startedAtMs));
}

function truncateCloseReason(reason: string): string {
  return reason.length > MAX_CLOSE_REASON_LENGTH
    ? `${reason.slice(0, MAX_CLOSE_REASON_LENGTH)}...`
    : reason;
}

function formatCloseDetail(close: ObservedWebSocketClose): string {
  const cleanDetail = close.wasClean === null ? "" : close.wasClean ? " (clean)" : " (unclean)";
  const reason = truncateCloseReason(close.reason.trim());
  return `WebSocket close code ${close.code}${cleanDetail} after ${close.ageMs}ms${
    reason.length > 0 ? `: ${reason}` : ""
  }.`;
}

function formatErrorDetail(error: ObservedWebSocketError): string {
  return `WebSocket ${error.type} event after ${error.ageMs}ms.`;
}

function observedDisconnectDetail(observed: ObservedWebSocketLifecycle | null): string | null {
  if (!observed) {
    return null;
  }
  const close = observed.close;
  const error = observed.error;
  if (error && close?.code === 1000 && close.wasClean === true) {
    return formatErrorDetail(error);
  }
  if (close) {
    return formatCloseDetail(close);
  }
  return error ? formatErrorDetail(error) : null;
}

function observedHeartbeatDisconnectDetail(heartbeat: ObservedRpcHeartbeat): string | null {
  if (!heartbeat.timedOut) {
    return null;
  }
  const missed = Math.max(heartbeat.consecutiveMissedPongs, RPC_PING_MISS_TOLERANCE);
  const plural = missed === 1 ? "" : "s";
  return `RPC heartbeat timed out after ${missed} missed pong${plural}.`;
}

function disconnectDetail(input: {
  readonly heartbeat: ObservedRpcHeartbeat;
  readonly label: string;
  readonly observed: ObservedWebSocketLifecycle | null;
  readonly wasConnected: boolean;
}): string {
  const base = input.wasConnected
    ? `${input.label} disconnected.`
    : `${input.label} could not establish a WebSocket connection.`;
  const detail = observedDisconnectDetail(input.observed);
  const heartbeatDetail = observedHeartbeatDisconnectDetail(input.heartbeat);
  return [base, detail, heartbeatDetail].filter((value) => value !== null).join(" ");
}

function disconnectLogAttributes(input: {
  readonly connection: PreparedConnection;
  readonly heartbeat: ObservedRpcHeartbeat;
  readonly observed: ObservedWebSocketLifecycle | null;
  readonly wasConnected: boolean;
}): Record<string, string | number | boolean> {
  const attributes: Record<string, string | number | boolean> = {
    "environment.id": input.connection.environmentId,
    "environment.label": input.connection.label,
    "environment.target.kind": input.connection.target._tag,
    "websocket.was_connected": input.wasConnected,
  };
  if (input.observed?.close) {
    attributes["websocket.close.code"] = input.observed.close.code;
    attributes["websocket.close.age_ms"] = input.observed.close.ageMs;
    if (input.observed.close.wasClean !== null) {
      attributes["websocket.close.clean"] = input.observed.close.wasClean;
    }
    const reason = truncateCloseReason(input.observed.close.reason.trim());
    if (reason.length > 0) {
      attributes["websocket.close.reason"] = reason;
    }
  }
  if (input.observed?.error) {
    attributes["websocket.error.type"] = input.observed.error.type;
    attributes["websocket.error.age_ms"] = input.observed.error.ageMs;
  }
  if (input.heartbeat.pingCount > 0 || input.heartbeat.pongCount > 0 || input.heartbeat.timedOut) {
    attributes["rpc.heartbeat.ping_count"] = input.heartbeat.pingCount;
    attributes["rpc.heartbeat.pong_count"] = input.heartbeat.pongCount;
    attributes["rpc.heartbeat.consecutive_missed_pongs"] = input.heartbeat.consecutiveMissedPongs;
    attributes["rpc.heartbeat.awaiting_pong"] = input.heartbeat.awaitingPong;
    attributes["rpc.heartbeat.timed_out"] = input.heartbeat.timedOut;
    const lastPingAgeMs = elapsedSinceOptional(input.heartbeat.lastPingAtMs);
    const lastPongAgeMs = elapsedSinceOptional(input.heartbeat.lastPongAtMs);
    const timeoutAgeMs = elapsedSinceOptional(input.heartbeat.timeoutAtMs);
    if (lastPingAgeMs !== null) {
      attributes["rpc.heartbeat.last_ping_age_ms"] = lastPingAgeMs;
    }
    if (lastPongAgeMs !== null) {
      attributes["rpc.heartbeat.last_pong_age_ms"] = lastPongAgeMs;
    }
    if (timeoutAgeMs !== null) {
      attributes["rpc.heartbeat.timeout_age_ms"] = timeoutAgeMs;
    }
  }
  return attributes;
}

function observeWebSocket(
  socket: globalThis.WebSocket,
  observed: ObservedWebSocketLifecycle,
  createdAtMs: number,
) {
  socket.addEventListener(
    "open",
    () => {
      observed.openedAtMs = currentElapsedTimeMs();
    },
    { once: true },
  );
  socket.addEventListener(
    "close",
    (event) => {
      observed.close = {
        ageMs: elapsedSince(observed.openedAtMs, createdAtMs),
        code: typeof event.code === "number" ? event.code : 1001,
        reason: typeof event.reason === "string" ? event.reason : "",
        wasClean: typeof event.wasClean === "boolean" ? event.wasClean : null,
      };
    },
    { once: true },
  );
  socket.addEventListener(
    "error",
    (event) => {
      observed.error = {
        ageMs: elapsedSince(observed.openedAtMs, createdAtMs),
        type: event.type || "error",
      };
    },
    { once: true },
  );
}

const isSocketErrorReason = Schema.is(Socket.SocketErrorReason);

function mapSessionRpcError(
  error: InitialConfigError | ProbeError | ServerConfigSubscriptionError,
  networkHint: string,
): ConnectionAttemptError {
  switch (error._tag) {
    case "EnvironmentAuthorizationError":
      return new ConnectionBlockedError({
        reason: "permission",
        detail: error.message,
      });
    case "KeybindingsConfigParseError":
    case "ServerSettingsError":
      return new ConnectionTransientErrorClass({
        reason: "remote-unavailable",
        detail: error.message,
      });
    case "RpcClientError":
      return new ConnectionTransientErrorClass({
        reason: "transport",
        detail: `${error.message}${isSocketErrorReason(error.reason) ? networkHint : ""}`,
      });
  }
}

export const make = Effect.fn("RpcSessionFactory.make")(function* (
  options: RpcSessionOptions = {},
) {
  const webSocketConstructor = yield* Socket.WebSocketConstructor;
  const serverConfigInput: ServerConfigSubscriptionInput = {
    ...(options.environmentThemes === true ? { environmentThemes: true } : {}),
    ...(options.usageLimitSources === true ? { usageLimitSources: true } : {}),
  };

  const connect = Effect.fnUntraced(function* (connection: PreparedConnection) {
    const networkHint =
      connection.target._tag === "RelayConnectionTarget" ? ` ${NETWORK_BLOCKING_HINT}` : "";
    const mapRpcError = (error: Parameters<typeof mapSessionRpcError>[0]) =>
      mapSessionRpcError(error, networkHint);
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": connection.environmentId,
    });

    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, ConnectionTransientError>();
    const heartbeat: ObservedRpcHeartbeat = {
      awaitingPong: false,
      consecutiveMissedPongs: 0,
      lastPingAtMs: null,
      lastPongAtMs: null,
      pingCount: 0,
      pongCount: 0,
      timedOut: false,
      timeoutAtMs: null,
    };
    let observedWebSocket: ObservedWebSocketLifecycle | null = null;
    const observedWebSocketConstructor: typeof webSocketConstructor = (url, protocols) => {
      const createdAtMs = currentElapsedTimeMs();
      const observed: ObservedWebSocketLifecycle = {
        close: null,
        error: null,
        openedAtMs: null,
      };
      observedWebSocket = observed;
      const socket = webSocketConstructor(url, protocols);
      observeWebSocket(socket, observed, createdAtMs);
      return socket;
    };
    const hooks = RpcClient.ConnectionHooks.of({
      onConnect: Deferred.succeed(connected, undefined).pipe(Effect.asVoid),
      onDisconnect: Deferred.isDone(connected).pipe(
        Effect.flatMap((wasConnected) => {
          const observed = observedWebSocket;
          const error = new ConnectionTransientErrorClass({
            reason: "transport",
            detail:
              disconnectDetail({
                heartbeat,
                label: connection.label,
                observed,
                wasConnected,
              }) + networkHint,
          });
          return Effect.logWarning("Environment WebSocket disconnected.").pipe(
            Effect.annotateLogs(
              disconnectLogAttributes({
                connection,
                heartbeat,
                observed,
                wasConnected,
              }),
            ),
            Effect.andThen(Deferred.fail(disconnected, error)),
          );
        }),
        Effect.asVoid,
      ),
      onPing: Effect.sync(() => {
        if (heartbeat.awaitingPong) {
          heartbeat.consecutiveMissedPongs += 1;
        }
        heartbeat.awaitingPong = true;
        heartbeat.lastPingAtMs = currentElapsedTimeMs();
        heartbeat.pingCount += 1;
      }),
      onPong: Effect.sync(() => {
        heartbeat.awaitingPong = false;
        heartbeat.consecutiveMissedPongs = 0;
        heartbeat.lastPongAtMs = currentElapsedTimeMs();
        heartbeat.pongCount += 1;
      }),
      onPingTimeout: Effect.sync(() => {
        heartbeat.timedOut = true;
        heartbeat.timeoutAtMs = currentElapsedTimeMs();
        heartbeat.consecutiveMissedPongs = heartbeat.awaitingPong
          ? Math.max(heartbeat.consecutiveMissedPongs + 1, RPC_PING_MISS_TOLERANCE)
          : Math.max(heartbeat.consecutiveMissedPongs, RPC_PING_MISS_TOLERANCE);
      }),
    });
    const socketLayer = Socket.layerWebSocket(connection.socketUrl, {
      openTimeout: SOCKET_OPEN_TIMEOUT,
    }).pipe(
      Layer.provide(Layer.succeed(Socket.WebSocketConstructor, observedWebSocketConstructor)),
    );
    const protocolLayer = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
        pingMissTolerance: RPC_PING_MISS_TOLERANCE,
        retryTransientErrors: false,
        retryPolicy: Schedule.recurs(0),
      }),
    ).pipe(
      Layer.provide(
        Layer.mergeAll(
          socketLayer,
          RpcSerialization.layerJson,
          Layer.succeed(RpcClient.ConnectionHooks, hooks),
        ),
      ),
    );
    const protocolContext = yield* Layer.build(protocolLayer).pipe(
      Effect.withSpan("environment.websocket.connect"),
    );
    const protocolClient = yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));
    const initialConfigDeferred = yield* Deferred.make<ServerConfig>();
    const serverConfigExit = yield* Deferred.make<void, ServerConfigSubscriptionError>();
    const configSubscriptionClosed = yield* Deferred.make<never, ConnectionAttemptError>();
    const serverConfigState = yield* Ref.make(Option.none<ServerConfigReplayState>());
    const serverConfigUpdates = yield* PubSub.sliding<BufferedServerConfigEvent>(64);
    const configSubscriptionEndedError = new ConnectionTransientErrorClass({
      reason: "remote-unavailable",
      detail: `${connection.label} config subscription ended.`,
    });
    const serverConfigSource = protocolClient[WS_METHODS.subscribeServerConfig](
      serverConfigInput,
    ).pipe(
      Stream.runForEach((event) =>
        Effect.gen(function* () {
          const buffered = yield* Ref.modify(serverConfigState, (current) => {
            const projection = applyServerConfigProjection(
              Option.map(current, (state) => state.projection),
              event,
            );
            if (Option.isNone(projection)) {
              return [Option.none<BufferedServerConfigEvent>(), current] as const;
            }
            const next = {
              projection: projection.value,
              revision: Option.match(current, {
                onNone: () => 1,
                onSome: (state) => state.revision + 1,
              }),
              themesEvent:
                event.type === "environmentThemesUpdated"
                  ? event
                  : event.type === "snapshot" &&
                      event.config.environment.capabilities.environmentThemes !== true
                    ? undefined
                    : Option.getOrUndefined(current)?.themesEvent,
              sourcesEvent:
                event.type === "usageLimitSourcesUpdated"
                  ? event
                  : event.type === "snapshot" &&
                      event.config.environment.capabilities.usageLimitSources !== true
                    ? undefined
                    : Option.getOrUndefined(current)?.sourcesEvent,
            } satisfies ServerConfigReplayState;
            return [
              Option.some({ event, replay: next, revision: next.revision }),
              Option.some(next),
            ] as const;
          });
          if (Option.isSome(buffered)) {
            yield* PubSub.publish(serverConfigUpdates, buffered.value);
          }
          if (event.type === "snapshot") {
            yield* Deferred.succeed(initialConfigDeferred, event.config);
          }
        }),
      ),
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit)) {
          return Effect.all([
            Deferred.succeed(serverConfigExit, undefined),
            Deferred.fail(configSubscriptionClosed, configSubscriptionEndedError),
          ]).pipe(Effect.asVoid);
        }
        if (Cause.hasInterruptsOnly(exit.cause)) {
          return Effect.void;
        }
        return Effect.all([
          Deferred.failCause(serverConfigExit, exit.cause),
          Deferred.failCause(configSubscriptionClosed, Cause.map(exit.cause, mapRpcError)),
        ]).pipe(Effect.asVoid);
      }),
    );
    yield* serverConfigSource.pipe(Effect.forkScoped);
    const initialConfig = Effect.raceFirst(
      Deferred.await(initialConfigDeferred),
      Deferred.await(serverConfigExit).pipe(
        Effect.mapError(mapRpcError),
        Effect.flatMap(() => Effect.fail(configSubscriptionEndedError)),
      ),
    ).pipe(Effect.withSpan("environment.initialSync"));
    const serverConfigEvents = Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(serverConfigUpdates);
        yield* Effect.raceFirst(
          Deferred.await(initialConfigDeferred).pipe(Effect.asVoid),
          Deferred.await(serverConfigExit),
        );
        const snapshot = yield* Ref.get(serverConfigState);
        if (Option.isNone(snapshot)) {
          return Stream.empty;
        }
        const updates = Stream.fromSubscription(subscription).pipe(
          Stream.filter((buffered) => buffered.revision > snapshot.value.revision),
          Stream.mapAccum(
            () => snapshot.value.revision,
            (revision, buffered) => [
              buffered.revision,
              buffered.revision === revision + 1
                ? [buffered.event]
                : serverConfigReplayEvents(buffered.replay),
            ],
          ),
        );
        const terminal = Stream.fromEffect(Deferred.await(serverConfigExit)).pipe(Stream.drain);
        return Stream.concat(
          Stream.fromIterable(serverConfigReplayEvents(snapshot.value)),
          Stream.merge(updates, terminal, { haltStrategy: "either" }),
        );
      }),
    ).pipe(
      Stream.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) {
          return Stream.failCause(cause);
        }
        // The supervisor keeps the original cause. Shared durable consumers
        // need a transport-shaped failure so they wait for its replacement.
        return Stream.fail(
          new RpcClientError.RpcClientError({
            reason: new RpcClientError.RpcClientDefect({
              message: `${connection.label} config subscription failed.`,
              cause,
            }),
          }),
        );
      }),
    );
    const subscribeServerConfig = (input: ServerConfigSubscriptionInput) =>
      Equal.equals(input, serverConfigInput)
        ? serverConfigEvents
        : protocolClient[WS_METHODS.subscribeServerConfig](input);
    const probe = initialConfig.pipe(
      Effect.flatMap((config) =>
        (config.environment.capabilities.connectionProbe === true
          ? protocolClient[WS_METHODS.serverProbe]({})
          : protocolClient[WS_METHODS.serverGetConfig]({})
        ).pipe(Effect.mapError(mapRpcError)),
      ),
      Effect.asVoid,
      Effect.withSpan("clientRuntime.connection.rpcSession.probe"),
    );

    return {
      client: protocolClient,
      initialConfig,
      subscribeServerConfig,
      ready: Deferred.await(connected).pipe(
        Effect.andThen(initialConfig),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(disconnected)),
      ),
      probe,
      closed: Effect.raceFirst(
        Deferred.await(disconnected),
        Deferred.await(configSubscriptionClosed),
      ),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layerWithOptions = (options: RpcSessionOptions) =>
  Layer.effect(RpcSessionFactory, make(options));

export const layer = layerWithOptions({});
