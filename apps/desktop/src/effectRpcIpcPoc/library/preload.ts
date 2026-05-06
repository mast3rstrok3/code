import {
  EFFECT_RPC_IPC_CHANNELS,
  EFFECT_RPC_IPC_RENDERER_BRIDGE_KEY,
  type EffectRpcIpcRendererBridge,
  type EffectRpcIpcRendererFrame,
  isEffectRpcIpcMainFrame,
  isEffectRpcIpcRendererFrame,
} from "./ipc.ts";

export interface ElectronLikeIpcRenderer {
  readonly send: (channel: string, frame: EffectRpcIpcRendererFrame) => void;
  readonly on: (
    channel: string,
    listener: (event: unknown, frame: unknown) => void,
  ) => ElectronLikeIpcRenderer;
  readonly off?: (
    channel: string,
    listener: (event: unknown, frame: unknown) => void,
  ) => ElectronLikeIpcRenderer;
  readonly removeListener?: (
    channel: string,
    listener: (event: unknown, frame: unknown) => void,
  ) => ElectronLikeIpcRenderer;
}

export interface ElectronLikeContextBridge {
  readonly exposeInMainWorld: (apiKey: string, api: EffectRpcIpcRendererBridge) => void;
}

export function makeEffectRpcIpcPreloadBridge(
  electronIpcRenderer: ElectronLikeIpcRenderer,
  channels = EFFECT_RPC_IPC_CHANNELS,
): EffectRpcIpcRendererBridge {
  return {
    send: (frame) => {
      if (!isEffectRpcIpcRendererFrame(frame)) {
        throw new TypeError("Invalid Effect RPC renderer frame");
      }
      electronIpcRenderer.send(channels.rendererToMain, frame);
    },
    subscribe: (listener) => {
      const wrapped = (_event: unknown, frame: unknown) => {
        if (isEffectRpcIpcMainFrame(frame)) {
          listener(frame);
        }
      };

      electronIpcRenderer.on(channels.mainToRenderer, wrapped);
      return () => {
        removeIpcListener(electronIpcRenderer, channels.mainToRenderer, wrapped);
      };
    },
  };
}

export function exposeEffectRpcIpcPreloadBridge(options: {
  readonly contextBridge: ElectronLikeContextBridge;
  readonly ipcRenderer: ElectronLikeIpcRenderer;
  readonly globalKey?: string;
  readonly channels?: typeof EFFECT_RPC_IPC_CHANNELS;
}): void {
  options.contextBridge.exposeInMainWorld(
    options.globalKey ?? EFFECT_RPC_IPC_RENDERER_BRIDGE_KEY,
    makeEffectRpcIpcPreloadBridge(options.ipcRenderer, options.channels),
  );
}

function removeIpcListener<TListener>(
  target: {
    readonly off?: (channel: string, listener: TListener) => unknown;
    readonly removeListener?: (channel: string, listener: TListener) => unknown;
  },
  channel: string,
  listener: TListener,
): void {
  if (target.off) {
    target.off(channel, listener);
    return;
  }
  target.removeListener?.(channel, listener);
}
