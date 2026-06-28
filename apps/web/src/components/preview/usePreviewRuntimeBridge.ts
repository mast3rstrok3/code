"use client";

import type {
  DesktopPreviewScreenshotArtifact,
  PreviewScreenshotArtifact,
  ScopedThreadRef,
} from "@t3tools/contracts";

import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { resolvePreviewRuntimeCapability } from "~/previewStateStore";
import { useServerConfigs } from "~/state/entities";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";

import { previewBridge } from "./previewBridge";

type ScreenshotArtifact = DesktopPreviewScreenshotArtifact | PreviewScreenshotArtifact;

export interface PreviewRuntimeBridge {
  readonly kind: "desktop" | "server";
  readonly supportsDevTools: boolean;
  readonly supportsRecording: boolean;
  readonly supportsElementPicking: boolean;
  readonly navigate: (tabId: string, url: string) => Promise<void>;
  readonly refresh: (tabId: string) => Promise<void>;
  readonly hardReload: (tabId: string) => Promise<void>;
  readonly goBack: (tabId: string) => Promise<void>;
  readonly goForward: (tabId: string) => Promise<void>;
  readonly zoomIn: (tabId: string) => Promise<void>;
  readonly zoomOut: (tabId: string) => Promise<void>;
  readonly resetZoom: (tabId: string) => Promise<void>;
  readonly clearCookies: () => Promise<void>;
  readonly clearCache: () => Promise<void>;
  readonly captureScreenshot: (tabId: string) => Promise<ScreenshotArtifact>;
  readonly revealArtifact?: ((path: string) => Promise<void>) | undefined;
  readonly copyArtifactToClipboard?: ((path: string) => Promise<void>) | undefined;
}

export function usePreviewRuntimeBridge(threadRef: ScopedThreadRef): PreviewRuntimeBridge | null {
  const serverConfigs = useServerConfigs();
  const navigate = useAtomCommand(previewEnvironment.navigate, { reportFailure: false });
  const refresh = useAtomCommand(previewEnvironment.refresh, { reportFailure: false });
  const goBack = useAtomCommand(previewEnvironment.goBack, { reportFailure: false });
  const goForward = useAtomCommand(previewEnvironment.goForward, { reportFailure: false });
  const zoom = useAtomCommand(previewEnvironment.zoom, { reportFailure: false });
  const captureScreenshot = useAtomCommand(previewEnvironment.captureScreenshot, {
    reportFailure: false,
  });
  const clearBrowserData = useAtomCommand(previewEnvironment.clearBrowserData, {
    reportFailure: false,
  });

  if (previewBridge) {
    return {
      kind: "desktop",
      supportsDevTools: true,
      supportsRecording: true,
      supportsElementPicking: true,
      navigate: previewBridge.navigate,
      refresh: previewBridge.refresh,
      hardReload: previewBridge.hardReload,
      goBack: previewBridge.goBack,
      goForward: previewBridge.goForward,
      zoomIn: previewBridge.zoomIn,
      zoomOut: previewBridge.zoomOut,
      resetZoom: previewBridge.resetZoom,
      clearCookies: previewBridge.clearCookies,
      clearCache: previewBridge.clearCache,
      captureScreenshot: previewBridge.captureScreenshot,
      revealArtifact: previewBridge.revealArtifact,
      copyArtifactToClipboard: previewBridge.copyArtifactToClipboard,
    };
  }

  const runtime = resolvePreviewRuntimeCapability(serverConfigs.get(threadRef.environmentId));
  if (!runtime.supported || runtime.mode !== "server") return null;

  const run = async <A>(result: Promise<AtomCommandResult<A, unknown>>): Promise<A> => {
    const settled = await result;
    if (settled._tag === "Failure") throw squashAtomCommandFailure(settled);
    return settled.value;
  };
  const target = <I>(input: I) => ({ environmentId: threadRef.environmentId, input });
  const tabTarget = (tabId: string) => ({ threadId: threadRef.threadId, tabId });

  return {
    kind: "server",
    supportsDevTools: false,
    supportsRecording: false,
    supportsElementPicking: false,
    navigate: (tabId, url) => run(navigate(target({ ...tabTarget(tabId), url }))).then(() => {}),
    refresh: (tabId) => run(refresh(target(tabTarget(tabId)))).then(() => {}),
    hardReload: (tabId) =>
      run(refresh(target({ ...tabTarget(tabId), bypassCache: true }))).then(() => {}),
    goBack: (tabId) => run(goBack(target(tabTarget(tabId)))).then(() => {}),
    goForward: (tabId) => run(goForward(target(tabTarget(tabId)))).then(() => {}),
    zoomIn: (tabId) =>
      run(zoom(target({ ...tabTarget(tabId), action: "in" as const }))).then(() => {}),
    zoomOut: (tabId) =>
      run(zoom(target({ ...tabTarget(tabId), action: "out" as const }))).then(() => {}),
    resetZoom: (tabId) =>
      run(zoom(target({ ...tabTarget(tabId), action: "reset" as const }))).then(() => {}),
    clearCookies: () => run(clearBrowserData(target({ data: "cookies" as const }))).then(() => {}),
    clearCache: () => run(clearBrowserData(target({ data: "cache" as const }))).then(() => {}),
    captureScreenshot: (tabId) => run(captureScreenshot(target(tabTarget(tabId)))),
  };
}
