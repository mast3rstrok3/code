import type { FromClientEncoded, FromServerEncoded } from "effect/unstable/rpc/RpcMessage";

/**
 * Shared IPC envelope for the Electron transport.
 *
 * Electron IPC already gives us framing and structured clone, so the transport
 * can pass Effect RPC's encoded message objects directly instead of wrapping
 * them in JSON-RPC text.
 */

export const EFFECT_RPC_IPC_CHANNELS = {
  rendererToMain: "effect-rpc-ipc:poc:renderer-to-main",
  mainToRenderer: "effect-rpc-ipc:poc:main-to-renderer",
} as const;

export const EFFECT_RPC_IPC_RENDERER_BRIDGE_KEY = "effectRpcIpcPoc" as const;

export interface EffectRpcIpcRendererFrame {
  readonly version: 1;
  readonly rendererClientId: number;
  readonly message: FromClientEncoded;
}

export interface EffectRpcIpcMainFrame {
  readonly version: 1;
  readonly rendererClientId: number;
  readonly message: FromServerEncoded;
}

export interface EffectRpcIpcRendererPort {
  readonly send: (frame: EffectRpcIpcRendererFrame) => void;
  readonly subscribe: (listener: (frame: EffectRpcIpcMainFrame) => void) => () => void;
}

export type EffectRpcIpcRendererBridge = EffectRpcIpcRendererPort;

export interface EffectRpcIpcMainSource {
  readonly id: number;
  readonly send: (frame: EffectRpcIpcMainFrame) => void;
  readonly isClosed?: () => boolean;
  readonly onClose?: (listener: () => void) => () => void;
}

export interface EffectRpcIpcMainPort {
  readonly subscribe: (
    listener: (source: EffectRpcIpcMainSource, frame: EffectRpcIpcRendererFrame) => void,
  ) => () => void;
}

export function isEffectRpcIpcRendererFrame(value: unknown): value is EffectRpcIpcRendererFrame {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.rendererClientId === "number" &&
    isRecord(value.message)
  );
}

export function isEffectRpcIpcMainFrame(value: unknown): value is EffectRpcIpcMainFrame {
  return (
    isRecord(value) &&
    value.version === 1 &&
    typeof value.rendererClientId === "number" &&
    isRecord(value.message)
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
