import { Effect, Layer, Queue, Scope } from "effect";
import { RpcClient } from "effect/unstable/rpc";

import {
  EFFECT_RPC_IPC_RENDERER_BRIDGE_KEY,
  type EffectRpcIpcMainFrame,
  type EffectRpcIpcRendererBridge,
  type EffectRpcIpcRendererPort,
} from "./ipc.ts";

export interface EffectRpcIpcBrowserGlobal {
  readonly [EFFECT_RPC_IPC_RENDERER_BRIDGE_KEY]?: EffectRpcIpcRendererBridge;
}

export function getEffectRpcIpcRendererBridge(
  globalObject: EffectRpcIpcBrowserGlobal = globalThis as EffectRpcIpcBrowserGlobal,
): EffectRpcIpcRendererBridge {
  const bridge = globalObject[EFFECT_RPC_IPC_RENDERER_BRIDGE_KEY];
  if (!bridge) {
    throw new Error(`Missing preload bridge: window.${EFFECT_RPC_IPC_RENDERER_BRIDGE_KEY}`);
  }
  return bridge;
}

export const makeEffectRpcIpcRendererPort = (
  bridge: EffectRpcIpcRendererBridge,
): EffectRpcIpcRendererPort => bridge;

export const makeEffectRpcIpcRendererProtocol = (
  port: EffectRpcIpcRendererPort,
): Effect.Effect<RpcClient.Protocol["Service"], never, Scope.Scope> =>
  RpcClient.Protocol.make((writeResponse) =>
    Effect.gen(function* () {
      const scope = yield* Effect.scope;
      const responses = yield* Queue.make<EffectRpcIpcMainFrame>();
      const unsubscribe = port.subscribe((frame) => {
        Queue.offerUnsafe(responses, frame);
      });

      yield* Queue.take(responses).pipe(
        Effect.flatMap((frame) => writeResponse(frame.rendererClientId, frame.message)),
        Effect.forever,
        Effect.forkScoped,
      );

      yield* Scope.addFinalizer(
        scope,
        Effect.sync(unsubscribe).pipe(Effect.andThen(Queue.shutdown(responses))),
      );

      return {
        send: (rendererClientId, message) =>
          Effect.sync(() => {
            port.send({
              version: 1,
              rendererClientId,
              message,
            });
          }),
        supportsAck: true,
        supportsTransferables: false,
      };
    }),
  );

export const layerEffectRpcIpcRendererProtocol = (port: EffectRpcIpcRendererPort) =>
  Layer.effect(RpcClient.Protocol, makeEffectRpcIpcRendererProtocol(port));
