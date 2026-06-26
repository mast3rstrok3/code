import { type ServerConfig, WS_METHODS } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import type * as Scope from "effect/Scope";
import * as RpcClient from "effect/unstable/rpc/RpcClient";
import * as RpcSerialization from "effect/unstable/rpc/RpcSerialization";
import * as Socket from "effect/unstable/socket/Socket";

import { makeWsRpcProtocolClient, type WsRpcProtocolClient } from "./protocol.ts";
import type {
  ConnectionAttemptError,
  ConnectionTransientError,
  PreparedConnection,
} from "../connection/model.ts";
import {
  ConnectionBlockedError,
  ConnectionTransientError as ConnectionTransientErrorClass,
} from "../connection/model.ts";

const SOCKET_OPEN_TIMEOUT = "15 seconds";
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

export interface RpcSession {
  readonly client: WsRpcProtocolClient;
  readonly initialConfig: Effect.Effect<ServerConfig, ConnectionAttemptError>;
  readonly ready: Effect.Effect<void, ConnectionAttemptError>;
  readonly probe: Effect.Effect<void, ConnectionAttemptError>;
  readonly closed: Effect.Effect<never, ConnectionTransientError>;
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

function currentElapsedTimeMs(): number {
  return performance.now();
}

function elapsedSince(startedAtMs: number | null, fallbackStartedAtMs: number): number {
  return Math.max(0, Math.round(currentElapsedTimeMs() - (startedAtMs ?? fallbackStartedAtMs)));
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

function disconnectDetail(input: {
  readonly label: string;
  readonly observed: ObservedWebSocketLifecycle | null;
  readonly wasConnected: boolean;
}): string {
  const base = input.wasConnected
    ? `${input.label} disconnected.`
    : `${input.label} could not establish a WebSocket connection.`;
  const detail = observedDisconnectDetail(input.observed);
  return detail ? `${base} ${detail}` : base;
}

function disconnectLogAttributes(input: {
  readonly connection: PreparedConnection;
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

function mapInitialConfigError(error: InitialConfigError): ConnectionAttemptError {
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
        detail: error.message,
      });
  }
}

export const make = Effect.gen(function* () {
  const webSocketConstructor = yield* Socket.WebSocketConstructor;

  const connect = Effect.fnUntraced(function* (connection: PreparedConnection) {
    yield* Effect.annotateCurrentSpan({
      "connection.environment.id": connection.environmentId,
    });

    const connected = yield* Deferred.make<void>();
    const disconnected = yield* Deferred.make<never, ConnectionTransientError>();
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
            detail: disconnectDetail({
              label: connection.label,
              observed,
              wasConnected,
            }),
          });
          return Effect.logWarning("Environment WebSocket disconnected.").pipe(
            Effect.annotateLogs(
              disconnectLogAttributes({
                connection,
                observed,
                wasConnected,
              }),
            ),
            Effect.andThen(Deferred.fail(disconnected, error)),
          );
        }),
        Effect.asVoid,
      ),
    });
    const socketLayer = Socket.layerWebSocket(connection.socketUrl, {
      openTimeout: SOCKET_OPEN_TIMEOUT,
    }).pipe(
      Layer.provide(Layer.succeed(Socket.WebSocketConstructor, observedWebSocketConstructor)),
    );
    const protocolLayer = Layer.effect(
      RpcClient.Protocol,
      RpcClient.makeProtocolSocket({
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
    const client = yield* makeWsRpcProtocolClient.pipe(Effect.provide(protocolContext));
    const initialConfig = yield* Effect.cached(
      client[WS_METHODS.serverGetConfig]({}).pipe(
        Effect.mapError(mapInitialConfigError),
        Effect.withSpan("environment.initialSync"),
      ),
    );
    const probe = client[WS_METHODS.serverGetConfig]({}).pipe(
      Effect.mapError(mapInitialConfigError),
      Effect.asVoid,
      Effect.withSpan("clientRuntime.connection.rpcSession.probe"),
    );

    return {
      client,
      initialConfig,
      ready: Deferred.await(connected).pipe(
        Effect.andThen(initialConfig),
        Effect.asVoid,
        Effect.raceFirst(Deferred.await(disconnected)),
      ),
      probe,
      closed: Deferred.await(disconnected),
    } satisfies RpcSession;
  });

  return RpcSessionFactory.of({ connect });
});

export const layer = Layer.effect(RpcSessionFactory, make);
