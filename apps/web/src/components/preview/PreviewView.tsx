"use client";

import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  FILL_PREVIEW_VIEWPORT,
  type PreviewAnnotationPayload,
  type PreviewViewportSetting,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT,
  recordVisitForThread,
  removeUrlForThread,
  setTitleForThreadUrl,
  useThreadRecentHistory,
} from "~/browserHistoryStore";
import { type ComposerImageAttachment, useComposerDraftStore } from "~/composerDraftStore";
import { previewAnnotationScreenshotFile } from "~/lib/previewAnnotation";
import { ensureLocalApi } from "~/localApi";
import {
  rememberPreviewUrl,
  updatePreviewServerSnapshot,
  useThreadPreviewState,
} from "~/previewStateStore";
import { resolveDiscoveredServerUrl } from "~/browser/browserTargetResolver";
import { useServerConfigs } from "~/state/entities";
import { useEnvironmentHttpBaseUrl } from "~/state/environments";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { selectThreadPreviewMiniPlayer, usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { useRightPanelStore } from "~/rightPanelStore";

import { previewBridge } from "./previewBridge";
import { usePreviewRuntimeBridge } from "./usePreviewRuntimeBridge";
import { subscribePreviewAction } from "./previewActionBus";
import { openPreviewSession } from "./openPreviewSession";
import { PreviewChromeRow } from "./PreviewChromeRow";
import { PreviewEmptyState } from "./PreviewEmptyState";
import { PreviewMoreMenu } from "./PreviewMoreMenu";
import {
  commitBrowserViewportChange,
  subscribeBrowserViewportChange,
} from "~/browser/browserViewportActions";
import { browserResponsiveViewportForToggle, useBrowserDefaults } from "~/browser/browserDefaults";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { PreviewUnreachable } from "./PreviewUnreachable";
import { revealInFileExplorerLabel } from "./fileExplorerLabel";
import { shouldShowPreviewEmptyState } from "./previewEmptyStateLogic";
import { BrowserSurfaceSlot } from "~/browser/BrowserSurfaceSlot";
import { useBrowserSurfaceStore } from "~/browser/browserSurfaceStore";
import { usePreviewSession } from "./usePreviewSession";
import { ZoomIndicator } from "./ZoomIndicator";
import { AgentBrowserCursor } from "./AgentBrowserCursor";
import {
  findActiveBrowserRecordingRuntimeTabId,
  startBrowserRecording,
  stopBrowserRecording,
  useActiveBrowserRecordingTabIds,
} from "~/browser/browserRecording";
import { stackedThreadToast, toastManager } from "~/components/ui/toast";

interface Props {
  threadRef: ScopedThreadRef;
  tabId?: string | null;
  configuredUrls?: ReadonlyArray<string> | undefined;
  visible: boolean;
  onSendAnnotation?: (
    annotation: PreviewAnnotationPayload,
    image: ComposerImageAttachment | null,
  ) => void;
}

const localApi = typeof window === "undefined" ? null : ensureLocalApi();

/**
 * Single-tab preview surface: chrome row on top, one webview below, empty
 * state when no session exists for the thread.
 */
export function PreviewView({
  threadRef,
  tabId: requestedTabId,
  configuredUrls,
  visible,
  onSendAnnotation,
}: Props) {
  const [focusUrlNonce, setFocusUrlNonce] = useState<number | undefined>(undefined);
  const [pickActive, setPickActive] = useState(false);
  const activeRecordingTabIds = useActiveBrowserRecordingTabIds();
  const pickActiveRef = useRef(false);
  const isMountedRef = useRef(true);
  // Kept in sync so the title effect can depend on the stable thread key
  // instead of the thread object, which is recreated on every update.
  const threadRefRef = useRef(threadRef);
  threadRefRef.current = threadRef;
  const previewState = useThreadPreviewState(threadRef);
  const recentHistoryEntries = useThreadRecentHistory(
    threadRef,
    BROWSER_HISTORY_MAX_ENTRIES_PER_PROJECT,
  );
  const miniPlayer = usePreviewMiniPlayerStore((state) =>
    selectThreadPreviewMiniPlayer(state.byThreadKey, threadRef),
  );
  const addPreviewAnnotation = useComposerDraftStore((store) => store.addPreviewAnnotation);
  const addImage = useComposerDraftStore((store) => store.addImage);
  const environmentHttpBaseUrl = useEnvironmentHttpBaseUrl(threadRef.environmentId);
  const serverConfigs = useServerConfigs();
  const environmentHostname = environmentHttpBaseUrl
    ? new URL(environmentHttpBaseUrl).hostname
    : null;
  const open = useAtomCommand(previewEnvironment.open);
  const resize = useAtomCommand(previewEnvironment.resize, "preview viewport resize");
  const runtimeBridge = usePreviewRuntimeBridge(threadRef);

  usePreviewSession(threadRef);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
    };
  }, []);

  const tabId = requestedTabId ?? previewState.activeTabId;
  const runtimeTabId = tabId
    ? previewRuntimeTabId(threadRef, previewState.serverEpoch, tabId)
    : null;
  const runtimeBridgeTabId = runtimeBridge?.kind === "desktop" ? runtimeTabId : tabId;
  const recordingRuntimeTabId =
    tabId && runtimeTabId
      ? activeRecordingTabIds.has(runtimeTabId)
        ? runtimeTabId
        : findActiveBrowserRecordingRuntimeTabId(threadRef, tabId)
      : null;
  const snapshot = tabId ? (previewState.sessions[tabId] ?? null) : null;
  const desktopOverlay = tabId ? (previewState.desktopByTabId[tabId] ?? null) : null;
  const navStatus = snapshot?.navStatus ?? { _tag: "Idle" as const };
  const url = navStatus._tag === "Idle" ? "" : navStatus.url;
  const loading = desktopOverlay?.loading ?? navStatus._tag === "Loading";
  const canGoBack = desktopOverlay?.canGoBack ?? snapshot?.canGoBack ?? false;
  const canGoForward = desktopOverlay?.canGoForward ?? snapshot?.canGoForward ?? false;
  const refreshDisabled = navStatus._tag === "Idle";
  const isUnreachable = navStatus._tag === "LoadFailed";
  const showEmptyState = shouldShowPreviewEmptyState(snapshot);
  const controller = desktopOverlay?.controller ?? "none";
  const viewport = snapshot?.viewport ?? FILL_PREVIEW_VIEWPORT;
  const browserDefaults = useBrowserDefaults();
  const panelRect = useBrowserSurfaceStore((state) =>
    runtimeBridgeTabId ? (state.byTabId[runtimeBridgeTabId]?.rect ?? null) : null,
  );
  const browserSurfaceReady =
    runtimeBridge?.kind === "server" ? snapshot !== null : desktopOverlay !== null;
  const desktopPreviewBridge = previewBridge;

  const navUrl = navStatus._tag === "Success" ? navStatus.url : null;
  const navTitle = navStatus._tag === "Success" ? navStatus.title : null;
  const latestHistoryUrl = recentHistoryEntries[0]?.url;
  const threadKey = scopedThreadKey(threadRef);
  useEffect(() => {
    if (!navUrl || !navTitle || !latestHistoryUrl) return;
    // Agent-driven pages only enrich an existing requested URL.
    setTitleForThreadUrl(threadRefRef.current, navUrl, navTitle, environmentHostname);
    // threadKey stands in for threadRef, whose identity churns on every thread update.
  }, [environmentHostname, latestHistoryUrl, navTitle, navUrl, threadKey]);

  const navigateToResolvedUrl = useCallback(
    async (resolvedUrl: string) => {
      if (runtimeBridgeTabId && runtimeBridge) {
        // Drive the webview imperatively; `usePreviewBridge` mirrors the
        // resolved URL back to the server so other clients stay in sync.
        await runtimeBridge.navigate(runtimeBridgeTabId, resolvedUrl);
        rememberPreviewUrl(threadRef, resolvedUrl);
        return true;
      }
      const result = await openPreviewSession({ openPreview: open, threadRef, url: resolvedUrl });
      return result._tag === "Success";
    },
    [open, runtimeBridge, runtimeBridgeTabId, threadRef],
  );

  const handleSubmitUrl = useCallback(
    async (next: string) => {
      try {
        const normalized = normalizePreviewUrl(next);
        if (await navigateToResolvedUrl(normalized)) {
          recordVisitForThread(threadRef, normalized);
        }
      } catch {
        // Server-side `failed` event renders the unreachable view.
      }
    },
    [navigateToResolvedUrl, threadRef],
  );

  const handleOpenServerUrl = useCallback(
    async (next: string) => {
      try {
        const resolved = resolveDiscoveredServerUrl(threadRef.environmentId, next);
        if (await navigateToResolvedUrl(resolved)) {
          recordVisitForThread(threadRef, next);
        }
      } catch {
        // Server-side `failed` event renders the unreachable view.
      }
    },
    [navigateToResolvedUrl, threadRef],
  );

  const handleRefresh = useCallback(() => {
    if (runtimeBridge && runtimeBridgeTabId) void runtimeBridge.refresh(runtimeBridgeTabId);
  }, [runtimeBridge, runtimeBridgeTabId]);

  const handleZoomIn = useCallback(() => {
    if (runtimeBridge && runtimeBridgeTabId) void runtimeBridge.zoomIn(runtimeBridgeTabId);
  }, [runtimeBridge, runtimeBridgeTabId]);

  const handleZoomOut = useCallback(() => {
    if (runtimeBridge && runtimeBridgeTabId) void runtimeBridge.zoomOut(runtimeBridgeTabId);
  }, [runtimeBridge, runtimeBridgeTabId]);

  const handleResetZoom = useCallback(() => {
    if (runtimeBridge && runtimeBridgeTabId) void runtimeBridge.resetZoom(runtimeBridgeTabId);
  }, [runtimeBridge, runtimeBridgeTabId]);

  const handleViewportChange = useCallback(
    async (nextViewport: PreviewViewportSetting) => {
      if (!tabId) return;
      const result = await resize({
        environmentId: threadRef.environmentId,
        input: {
          threadId: threadRef.threadId,
          tabId,
          viewport: nextViewport,
        },
      });
      if (result._tag === "Failure") {
        const error = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Unable to resize browser viewport",
          description: error instanceof Error ? error.message : "An error occurred.",
        });
        throw error;
      }
      updatePreviewServerSnapshot(threadRef, result.value);
    },
    [resize, tabId, threadRef],
  );

  const handleToggleDeviceToolbar = () => {
    if (!runtimeTabId) return;
    if (viewport._tag !== "fill") {
      void commitBrowserViewportChange(runtimeTabId, FILL_PREVIEW_VIEWPORT).catch(() => undefined);
      return;
    }

    void commitBrowserViewportChange(
      runtimeTabId,
      browserResponsiveViewportForToggle({
        defaults: browserDefaults,
        panelRect,
        zoomFactor: desktopOverlay?.zoomFactor,
      }),
    ).catch(() => undefined);
  };

  useEffect(() => {
    if (!runtimeTabId) return;
    return subscribeBrowserViewportChange(runtimeTabId, handleViewportChange);
  }, [handleViewportChange, runtimeTabId]);

  const handleBack = useCallback(() => {
    if (runtimeBridge && runtimeBridgeTabId) void runtimeBridge.goBack(runtimeBridgeTabId);
  }, [runtimeBridge, runtimeBridgeTabId]);

  const handleForward = useCallback(() => {
    if (runtimeBridge && runtimeBridgeTabId) void runtimeBridge.goForward(runtimeBridgeTabId);
  }, [runtimeBridge, runtimeBridgeTabId]);

  const handleOpenInBrowser = useCallback(() => {
    if (!url) return;
    if (localApi) {
      void localApi.shell.openExternal(url).catch(() => undefined);
      return;
    }
    window.open(url, "_blank", "noopener,noreferrer");
  }, [url]);

  const handlePictureInPicture = useCallback(() => {
    if (!tabId) return;
    if (miniPlayer?.tabId === tabId) {
      usePreviewMiniPlayerStore.getState().close(threadRef);
      return;
    }
    usePreviewMiniPlayerStore.getState().open(threadRef, tabId);
    useRightPanelStore.getState().close(threadRef);
  }, [miniPlayer?.tabId, tabId, threadRef]);

  const handleNativePictureInPicture = useCallback(() => {
    if (!previewBridge || !runtimeTabId) return;
    const operation = desktopOverlay?.pictureInPicture
      ? previewBridge.pictureInPicture.close
      : previewBridge.pictureInPicture.open;
    void operation(runtimeTabId).catch((error) => {
      toastManager.add({
        type: "error",
        title: "Unable to update popped-out preview",
        description: error instanceof Error ? error.message : "An error occurred.",
      });
    });
  }, [desktopOverlay?.pictureInPicture, runtimeTabId]);

  const handleCapture = useCallback(
    (record: boolean) => {
      if (!runtimeBridge || !runtimeBridgeTabId || !tabId) return;
      const bridge = runtimeBridge;
      if (bridge.kind === "server") {
        if (record) {
          const recordingAvailable =
            serverConfigs.get(threadRef.environmentId)?.previewBrowser?.capabilities.recording ??
            false;
          toastManager.add({
            type: "warning",
            title: "Recording unavailable",
            description: recordingAvailable
              ? "The server can record this preview for App Reviews, but the manual record button is not wired up yet."
              : "Recording requires ffmpeg on the server. Install ffmpeg or run `pnpm --filter t3 run install:preview-browser`.",
          });
          return;
        }
        void bridge.captureScreenshot(runtimeBridgeTabId).then(
          (artifact) => {
            const copyPath = () => {
              if (!navigator.clipboard?.writeText) return;
              void navigator.clipboard.writeText(artifact.path).catch(() => undefined);
            };
            toastManager.add(
              stackedThreadToast({
                type: "success",
                title: "Screenshot saved",
                data: {
                  secondaryActionProps: {
                    children: "Copy path",
                    onClick: copyPath,
                  },
                  secondaryActionVariant: "outline",
                },
              }),
            );
          },
          (error) => {
            toastManager.add({
              type: "error",
              title: "Unable to capture screenshot",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          },
        );
        return;
      }
      if (recordingRuntimeTabId) {
        void stopBrowserRecording(recordingRuntimeTabId).then(
          (artifact) => {
            if (!artifact) return;
            let pathCopied = false;
            let toastId: ReturnType<typeof toastManager.add>;

            const copyPath = () => {
              if (!navigator.clipboard?.writeText) {
                toastManager.update(
                  toastId,
                  stackedThreadToast({
                    type: "error",
                    title: "Unable to copy recording path",
                    description: "Clipboard API unavailable.",
                    actionProps: revealAction,
                  }),
                );
                return;
              }

              void navigator.clipboard.writeText(artifact.path).then(
                () => {
                  pathCopied = true;
                  updateRecordingToast();
                  window.setTimeout(() => {
                    pathCopied = false;
                    updateRecordingToast();
                  }, 2_000);
                },
                (error) => {
                  toastManager.update(
                    toastId,
                    stackedThreadToast({
                      type: "error",
                      title: "Unable to copy recording path",
                      description: error instanceof Error ? error.message : "An error occurred.",
                      actionProps: revealAction,
                    }),
                  );
                },
              );
            };

            const revealAction = {
              children: revealInFileExplorerLabel(navigator.platform),
              onClick: () => void bridge.revealArtifact?.(artifact.path),
            };
            const updateRecordingToast = () => {
              toastManager.update(
                toastId,
                stackedThreadToast({
                  type: "success",
                  title: "Recording saved",
                  actionProps: revealAction,
                  data: {
                    secondaryActionProps: {
                      children: pathCopied ? "Copied!" : "Copy path",
                      disabled: pathCopied,
                      onClick: copyPath,
                    },
                    secondaryActionVariant: "outline",
                  },
                }),
              );
            };

            toastId = toastManager.add(
              stackedThreadToast({
                type: "success",
                title: "Recording saved",
                actionProps: revealAction,
                data: {
                  secondaryActionProps: {
                    children: "Copy path",
                    onClick: copyPath,
                  },
                  secondaryActionVariant: "outline",
                },
              }),
            );
          },
          (error) => {
            toastManager.add({
              type: "error",
              title: "Unable to stop recording",
              description: error instanceof Error ? error.message : "An error occurred.",
            });
          },
        );
        return;
      }
      if (record) {
        if (!runtimeTabId) return;
        void startBrowserRecording(runtimeTabId, threadRef, tabId).catch((error) => {
          toastManager.add({
            type: "error",
            title: "Unable to start recording",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        });
        return;
      }
      void bridge.captureScreenshot(runtimeBridgeTabId).then(
        (artifact) => {
          const revealAction = {
            children: revealInFileExplorerLabel(navigator.platform),
            onClick: () => void bridge.revealArtifact?.(artifact.path),
          };
          let pathCopied = false;
          let imageCopied = false;
          let toastId: ReturnType<typeof toastManager.add>;

          const updateScreenshotToast = (
            type: "success" | "error" = "success",
            title = "Screenshot saved",
            description?: string,
          ) => {
            toastManager.update(
              toastId,
              stackedThreadToast({
                type,
                title,
                description,
                actionProps: {
                  children: imageCopied ? "Copied!" : "Copy image",
                  disabled: imageCopied,
                  onClick: copyImage,
                },
                data: {
                  additionalActions: [
                    {
                      id: "copy-path",
                      props: {
                        children: pathCopied ? "Copied!" : "Copy path",
                        disabled: pathCopied,
                        onClick: copyPath,
                      },
                    },
                  ],
                  secondaryActionProps: {
                    ...revealAction,
                  },
                  secondaryActionVariant: "outline",
                },
              }),
            );
          };

          const copyPath = () => {
            if (!navigator.clipboard?.writeText) {
              updateScreenshotToast(
                "error",
                "Unable to copy screenshot path",
                "Clipboard API unavailable.",
              );
              return;
            }

            void navigator.clipboard.writeText(artifact.path).then(
              () => {
                pathCopied = true;
                updateScreenshotToast();
                window.setTimeout(() => {
                  pathCopied = false;
                  updateScreenshotToast();
                }, 2_000);
              },
              (error) => {
                updateScreenshotToast(
                  "error",
                  "Unable to copy screenshot path",
                  error instanceof Error ? error.message : "An error occurred.",
                );
              },
            );
          };

          const copyImage = () => {
            const copyArtifactToClipboard = bridge.copyArtifactToClipboard;
            if (!copyArtifactToClipboard) {
              updateScreenshotToast(
                "error",
                "Unable to copy screenshot",
                "Clipboard integration unavailable.",
              );
              return;
            }
            void copyArtifactToClipboard(artifact.path).then(
              () => {
                imageCopied = true;
                updateScreenshotToast();
                window.setTimeout(() => {
                  imageCopied = false;
                  updateScreenshotToast();
                }, 2_000);
              },
              (error) => {
                updateScreenshotToast(
                  "error",
                  "Unable to copy screenshot",
                  error instanceof Error ? error.message : "An error occurred.",
                );
              },
            );
          };

          toastId = toastManager.add(
            stackedThreadToast({
              type: "success",
              title: "Screenshot saved",
              actionProps: {
                children: "Copy image",
                onClick: copyImage,
              },
              data: {
                additionalActions: [
                  {
                    id: "copy-path",
                    props: {
                      children: "Copy path",
                      onClick: copyPath,
                    },
                  },
                ],
                secondaryActionProps: {
                  ...revealAction,
                },
                secondaryActionVariant: "outline",
              },
            }),
          );
        },
        (error) => {
          toastManager.add({
            type: "error",
            title: "Unable to capture screenshot",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        },
      );
    },
    [
      recordingRuntimeTabId,
      runtimeBridge,
      runtimeBridgeTabId,
      runtimeTabId,
      serverConfigs,
      tabId,
      threadRef,
    ],
  );

  const handlePickElement = useCallback(() => {
    if (!previewBridge || !runtimeTabId) return;
    if (pickActiveRef.current) {
      void previewBridge.cancelPickElement(runtimeTabId).catch(() => undefined);
      return;
    }
    // Snapshot whatever the user was focused on (typically the chat
    // composer textarea or the chrome-row pick button) BEFORE main steals
    // focus into the guest webContents. We restore it when the pick
    // resolves so the user's typing context isn't lost — otherwise after
    // every pick they'd have to click back into the textarea.
    const previouslyFocused =
      typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    pickActiveRef.current = true;
    setPickActive(true);
    void (async () => {
      try {
        const result = await previewBridge.pickElement(runtimeTabId);
        if (!result) return;
        const { annotation, submission } = result;
        addPreviewAnnotation(threadRef, annotation);
        let screenshotFile: File | null = null;
        try {
          screenshotFile = await previewAnnotationScreenshotFile(annotation);
        } catch {
          // The structured annotation is still sendable when converting its
          // optional screenshot into a composer attachment fails.
        }
        const image =
          screenshotFile && annotation.screenshot
            ? ({
                type: "image",
                id: annotation.id,
                name: screenshotFile.name,
                mimeType: screenshotFile.type,
                sizeBytes: screenshotFile.size,
                previewUrl: annotation.screenshot.dataUrl,
                file: screenshotFile,
              } satisfies ComposerImageAttachment)
            : null;
        if (image) {
          addImage(threadRef, image);
        }
        if (submission === "send") {
          onSendAnnotation?.(annotation, image);
        }
      } catch {
        // Picker failed (e.g. webview navigated). Treat as silent cancel.
      } finally {
        pickActiveRef.current = false;
        // Avoid `setState on unmounted component` if the panel/thread closed
        // while the pick was in flight.
        if (isMountedRef.current) setPickActive(false);
        // Best-effort: restore focus to whatever the user had before the
        // pick stole it into the guest webContents. Skip if the previously-
        // focused element was unmounted or is no longer focusable.
        if (
          previouslyFocused &&
          previouslyFocused.isConnected &&
          typeof previouslyFocused.focus === "function"
        ) {
          try {
            previouslyFocused.focus({ preventScroll: true });
          } catch {
            // Some elements throw on .focus() (detached iframes, etc.).
          }
        }
      }
    })();
  }, [addImage, addPreviewAnnotation, onSendAnnotation, runtimeTabId, threadRef]);

  // If the active tab changes mid-pick (close, thread switch, hot restart),
  // tell main to tear down the in-flight session AND reset our local toggle
  // state so the button doesn't get stuck pressed against a stale tab id.
  useEffect(() => {
    return () => {
      if (!pickActiveRef.current) return;
      pickActiveRef.current = false;
      if (previewBridge && runtimeTabId) {
        void previewBridge.cancelPickElement(runtimeTabId).catch(() => undefined);
      }
      if (isMountedRef.current) setPickActive(false);
    };
  }, [runtimeTabId]);

  // Subscribe only while visible; `toggle-panel` is owned by ChatView's
  // URL-aware handler regardless of whether the panel is currently mounted.
  useEffect(() => {
    if (!visible) return;
    return subscribePreviewAction((action) => {
      switch (action) {
        case "refresh":
          handleRefresh();
          return;
        case "focus-url":
          setFocusUrlNonce((value) => (value ?? 0) + 1);
          return;
        case "zoom-in":
          handleZoomIn();
          return;
        case "zoom-out":
          handleZoomOut();
          return;
        case "reset-zoom":
          handleResetZoom();
          return;
        case "toggle-panel":
          return;
      }
    });
  }, [handleRefresh, handleResetZoom, handleZoomIn, handleZoomOut, visible]);

  return (
    <div
      className="flex min-h-0 flex-1 flex-col bg-background"
      data-thread-key={scopedThreadKey(threadRef)}
    >
      <PreviewChromeRow
        url={url}
        loading={loading}
        canGoBack={canGoBack}
        canGoForward={canGoForward}
        refreshDisabled={refreshDisabled}
        focusUrlNonce={focusUrlNonce}
        onBack={handleBack}
        onForward={handleForward}
        onRefresh={handleRefresh}
        onSubmit={(next) => void handleSubmitUrl(next)}
        onOpenInBrowser={tabId ? handleOpenInBrowser : undefined}
        onCapture={runtimeBridge && tabId ? handleCapture : undefined}
        captureDisabled={!browserSurfaceReady || isUnreachable}
        recording={recordingRuntimeTabId !== null}
        onPictureInPicture={previewBridge && tabId ? handlePictureInPicture : undefined}
        pictureInPicture={miniPlayer?.tabId === tabId}
        pictureInPictureDisabled={!desktopOverlay?.hasWebContents || isUnreachable}
        onPickElement={
          runtimeBridge?.supportsElementPicking && previewBridge && tabId
            ? handlePickElement
            : undefined
        }
        pickActive={pickActive}
        // Disable when there's no tab (nothing to pick on) OR the page
        // failed to load (a React overlay covers the webview, so the
        // user wouldn't be able to actually click anything underneath).
        pickDisabled={!tabId || isUnreachable}
        pickDisabledReason={
          isUnreachable ? "Page didn't load — pick unavailable until the page renders" : undefined
        }
        trailingActions={
          runtimeBridge ? (
            <PreviewMoreMenu
              tabId={runtimeBridgeTabId}
              hasWebContents={browserSurfaceReady}
              zoomFactor={desktopOverlay?.zoomFactor ?? 1}
              colorScheme={desktopOverlay?.colorScheme ?? "system"}
              deviceToolbarVisible={viewport._tag !== "fill"}
              onToggleDeviceToolbar={handleToggleDeviceToolbar}
              onHardReload={
                runtimeBridgeTabId
                  ? () => void runtimeBridge.hardReload(runtimeBridgeTabId).catch(() => undefined)
                  : undefined
              }
              onOpenDevTools={
                runtimeBridge.supportsDevTools && runtimeTabId && desktopPreviewBridge
                  ? () =>
                      void desktopPreviewBridge.openDevTools(runtimeTabId).catch(() => undefined)
                  : undefined
              }
              onZoomIn={
                runtimeBridgeTabId
                  ? () => void runtimeBridge.zoomIn(runtimeBridgeTabId).catch(() => undefined)
                  : undefined
              }
              onZoomOut={
                runtimeBridgeTabId
                  ? () => void runtimeBridge.zoomOut(runtimeBridgeTabId).catch(() => undefined)
                  : undefined
              }
              onResetZoom={
                runtimeBridgeTabId
                  ? () => void runtimeBridge.resetZoom(runtimeBridgeTabId).catch(() => undefined)
                  : undefined
              }
              onClearCookies={() => void runtimeBridge.clearCookies().catch(() => undefined)}
              onClearCache={() => void runtimeBridge.clearCache().catch(() => undefined)}
              nativePictureInPicture={desktopOverlay?.pictureInPicture ?? false}
              onNativePictureInPicture={
                runtimeBridge.kind === "desktop" ? handleNativePictureInPicture : undefined
              }
            />
          ) : null
        }
      />

      <div className="relative min-h-0 flex-1 overflow-hidden">
        {runtimeBridgeTabId && snapshot && !showEmptyState ? (
          <BrowserSurfaceSlot
            key={runtimeBridgeTabId}
            tabId={runtimeBridgeTabId}
            visible={visible && !isUnreachable}
            className="absolute inset-0 h-full w-full"
          />
        ) : null}
        {showEmptyState ? (
          <PreviewEmptyState
            threadRef={threadRef}
            environmentId={threadRef.environmentId}
            configuredUrls={configuredUrls}
            recentEntries={recentHistoryEntries}
            onRemoveRecent={(url) => removeUrlForThread(threadRef, url)}
            onOpenUrl={(next) => void handleOpenServerUrl(next)}
          />
        ) : null}
        {snapshot && desktopOverlay ? (
          <ZoomIndicator zoomFactor={desktopOverlay.zoomFactor} />
        ) : null}
        {runtimeTabId && desktopOverlay && !showEmptyState && !isUnreachable ? (
          <AgentBrowserCursor
            tabId={runtimeTabId}
            zoomFactor={desktopOverlay.zoomFactor}
            controller={controller}
          />
        ) : null}
        {controller !== "none" ? (
          <div className="pointer-events-none absolute left-3 top-3 z-40 rounded-full border border-border/70 bg-background/90 px-2.5 py-1 text-[11px] font-medium shadow-sm backdrop-blur">
            {controller === "agent" ? "Agent controlling browser" : "Human control"}
          </div>
        ) : null}
        {navStatus._tag === "LoadFailed" ? (
          <div className="absolute inset-0 z-10 bg-background">
            <PreviewUnreachable
              url={navStatus.url}
              code={navStatus.code}
              description={navStatus.description}
              onReload={handleRefresh}
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
