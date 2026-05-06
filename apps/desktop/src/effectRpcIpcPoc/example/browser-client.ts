import { Effect, Scope, Stream } from "effect";
import { RpcClient } from "effect/unstable/rpc";

import {
  getEffectRpcIpcRendererBridge,
  makeEffectRpcIpcRendererPort,
  makeEffectRpcIpcRendererProtocol,
  type EffectRpcIpcBrowserGlobal,
} from "../library/client.ts";
import type { EffectRpcIpcRendererBridge } from "../library/ipc.ts";
import {
  DESKTOP_IPC_POC_METHODS,
  makeDesktopIpcPocClient,
  type DesktopIpcPocClient,
} from "./protocol.ts";

export interface DesktopIpcPocBrowserClientOptions {
  readonly bridge?: EffectRpcIpcRendererBridge;
  readonly globalObject?: EffectRpcIpcBrowserGlobal;
}

export interface DesktopIpcPocSnapshotOptions extends DesktopIpcPocBrowserClientOptions {
  readonly echoText?: string;
  readonly ticks?: number;
}

export const makeDesktopIpcPocBrowserClient = (
  options: DesktopIpcPocBrowserClientOptions = {},
): Effect.Effect<DesktopIpcPocClient, never, Scope.Scope> =>
  Effect.gen(function* () {
    const bridge = options.bridge ?? getEffectRpcIpcRendererBridge(options.globalObject);
    const rendererProtocol = yield* makeEffectRpcIpcRendererProtocol(
      makeEffectRpcIpcRendererPort(bridge),
    );

    return yield* makeDesktopIpcPocClient.pipe(
      Effect.provideService(RpcClient.Protocol, rendererProtocol),
    );
  });

export const loadDesktopIpcPocSnapshot = (options: DesktopIpcPocSnapshotOptions = {}) =>
  Effect.gen(function* () {
    const client = yield* makeDesktopIpcPocBrowserClient(options);
    const runtimeInfo = yield* client[DESKTOP_IPC_POC_METHODS.getRuntimeInfo]({});
    const echo = yield* client[DESKTOP_IPC_POC_METHODS.echo]({
      text: options.echoText ?? "hello from the renderer",
    });
    const ticks = yield* client[DESKTOP_IPC_POC_METHODS.subscribeTicks]({
      take: options.ticks ?? 3,
    }).pipe(
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
    );

    return {
      runtimeInfo,
      echo,
      ticks,
    };
  });

export const loadDesktopIpcPocSnapshotFromBrowser = (
  options: Omit<DesktopIpcPocSnapshotOptions, "bridge" | "globalObject"> = {},
) => Effect.runPromise(Effect.scoped(loadDesktopIpcPocSnapshot(options)));
