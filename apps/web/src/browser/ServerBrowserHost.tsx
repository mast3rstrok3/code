"use client";

import { useAtomValue } from "@effect/atom-react";
import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import {
  FILL_PREVIEW_VIEWPORT,
  type PreviewFrameEvent,
  type PreviewInputEvent,
  type PreviewViewportSetting,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { useShallow } from "zustand/react/shallow";

import { isElectron } from "~/env";
import { resolvePreviewRuntimeCapability } from "~/previewStateStore";
import { previewEnvironment } from "~/state/preview";
import { useAtomCommand } from "~/state/use-atom-command";
import { useServerConfigs } from "~/state/entities";
import { useActivePreviewSessions } from "~/previewStateStore";

import { BrowserDeviceToolbar } from "./BrowserDeviceToolbar";
import { BrowserViewportResizeHandles } from "./BrowserViewportResizeHandles";
import { resolveBrowserSurfacePanelRect, useBrowserSurfaceStore } from "./browserSurfaceStore";
import { browserViewportSettingKey } from "./browserViewportLayout";
import { resolveHostedBrowserWebviewWrapperStyle } from "./hostedBrowserWebviewStyle";
import { useBrowserViewportResize } from "./useBrowserViewportResize";

const EMPTY_MODIFIERS: ReadonlyArray<"Alt" | "Control" | "Meta" | "Shift"> = [];
const EMPTY_FRAME_ATOM = Atom.make(AsyncResult.initial<PreviewFrameEvent, never>(false)).pipe(
  Atom.withLabel("preview:server-browser-frame-empty"),
);

const keyboardModifiers = (
  event: Pick<
    KeyboardEvent | MouseEvent | WheelEvent,
    "altKey" | "ctrlKey" | "metaKey" | "shiftKey"
  >,
): ReadonlyArray<"Alt" | "Control" | "Meta" | "Shift"> => {
  const modifiers: Array<"Alt" | "Control" | "Meta" | "Shift"> = [];
  if (event.altKey) modifiers.push("Alt");
  if (event.ctrlKey) modifiers.push("Control");
  if (event.metaKey) modifiers.push("Meta");
  if (event.shiftKey) modifiers.push("Shift");
  return modifiers.length === 0 ? EMPTY_MODIFIERS : modifiers;
};

function usePreviewFrame(input: {
  readonly active: boolean;
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
}): PreviewFrameEvent | null {
  const atom = useMemo(
    () =>
      input.active
        ? previewEnvironment.frames({
            environmentId: input.threadRef.environmentId,
            input: { threadId: input.threadRef.threadId, tabId: input.tabId },
          })
        : null,
    [input.active, input.tabId, input.threadRef.environmentId, input.threadRef.threadId],
  );
  const result = useAtomValue(atom ?? EMPTY_FRAME_ATOM);
  if (atom === null) return null;
  return Option.getOrNull(AsyncResult.value(result));
}

function ServerBrowserCanvas(props: {
  readonly threadRef: ScopedThreadRef;
  readonly tabId: string;
  readonly viewport: PreviewViewportSetting;
}) {
  const { threadRef, tabId, viewport } = props;
  const wrapperRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [aspectRatioLocked, setAspectRatioLocked] = useState(false);
  const sendInput = useAtomCommand(previewEnvironment.input, { reportFailure: false });
  const resize = useAtomCommand(previewEnvironment.resize, { reportFailure: false });
  const presentation = useBrowserSurfaceStore(
    useShallow((state) => {
      const current = state.byTabId[tabId];
      return {
        rect: resolveBrowserSurfacePanelRect(state.byTabId, tabId),
        visible: current?.visible ?? false,
      };
    }),
  );
  const active = presentation.visible && presentation.rect !== null;
  const lastRect = presentation.rect;
  const hiddenSize =
    viewport._tag !== "fill"
      ? { width: viewport.width, height: viewport.height }
      : { width: lastRect?.width ?? 1280, height: lastRect?.height ?? 800 };
  const containerSize = active && lastRect ? lastRect : hiddenSize;
  const deviceToolbarVisible = active && viewport._tag !== "fill";
  const viewportAspectRatio = viewport._tag === "fill" ? null : viewport.width / viewport.height;
  const lockedAspectRatio =
    aspectRatioLocked && viewportAspectRatio !== null ? viewportAspectRatio : null;
  const {
    activeDrag,
    commitViewportChange,
    effectiveViewport,
    handleResizeKeyDown,
    handleResizePointerDown,
    layout,
  } = useBrowserViewportResize({
    tabId,
    viewport,
    zoomFactor: 1,
    containerSize,
    deviceToolbarVisible,
    aspectRatio: lockedAspectRatio,
  });
  const renderedViewport =
    effectiveViewport._tag === "fill"
      ? {
          width: Math.max(1, Math.round(layout.viewportWidth)),
          height: Math.max(1, Math.round(layout.viewportHeight)),
        }
      : { width: effectiveViewport.width, height: effectiveViewport.height };
  const frame = usePreviewFrame({ active, threadRef, tabId });

  const syncContentPresentation = useCallback(() => {
    const wrapper = wrapperRef.current;
    if (!wrapper) return;
    useBrowserSurfaceStore.getState().presentContent(tabId, {
      x: layout.viewportX,
      y: layout.viewportY,
      width: layout.viewportWidth,
      height: layout.viewportHeight,
      scale: layout.viewportScale,
      scrollLeft: wrapper.scrollLeft,
      scrollTop: wrapper.scrollTop,
    });
  }, [layout, tabId]);

  useEffect(() => {
    const frameId = window.requestAnimationFrame(syncContentPresentation);
    return () => window.cancelAnimationFrame(frameId);
  }, [syncContentPresentation]);

  useEffect(() => {
    if (!active) return;
    void resize({
      environmentId: threadRef.environmentId,
      input: {
        threadId: threadRef.threadId,
        tabId,
        viewport: effectiveViewport,
        renderedViewport,
      },
    });
  }, [
    active,
    effectiveViewport,
    renderedViewport.height,
    renderedViewport.width,
    resize,
    tabId,
    threadRef.environmentId,
    threadRef.threadId,
  ]);

  useEffect(() => {
    if (!frame) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    let cancelled = false;
    const image = new Image();
    const handleLoad = () => {
      if (cancelled) return;
      canvas.width = frame.width;
      canvas.height = frame.height;
      context.drawImage(image, 0, 0, frame.width, frame.height);
    };
    image.addEventListener("load", handleLoad, { once: true });
    image.src = `data:${frame.mimeType};base64,${frame.data}`;
    return () => {
      cancelled = true;
      image.removeEventListener("load", handleLoad);
    };
  }, [frame]);

  const send = useCallback(
    (event: PreviewInputEvent) => {
      void sendInput({
        environmentId: threadRef.environmentId,
        input: event,
      });
    },
    [sendInput, threadRef.environmentId],
  );

  const viewportPoint = useCallback(
    (event: ReactPointerEvent<HTMLCanvasElement> | ReactWheelEvent<HTMLCanvasElement>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      const x =
        rect.width <= 0 ? 0 : ((event.clientX - rect.left) / rect.width) * renderedViewport.width;
      const y =
        rect.height <= 0 ? 0 : ((event.clientY - rect.top) / rect.height) * renderedViewport.height;
      return {
        x: Math.max(0, Math.min(renderedViewport.width, x)),
        y: Math.max(0, Math.min(renderedViewport.height, y)),
      };
    },
    [renderedViewport.height, renderedViewport.width],
  );

  const pointerInput = useCallback(
    (
      type: "pointerDown" | "pointerMove" | "pointerUp",
      event: ReactPointerEvent<HTMLCanvasElement>,
    ) => {
      const point = viewportPoint(event);
      send({
        threadId: threadRef.threadId,
        tabId,
        type,
        ...point,
        button: event.button,
        buttons: event.buttons,
        pointerType:
          event.pointerType === "touch" || event.pointerType === "pen"
            ? event.pointerType
            : "mouse",
        modifiers: keyboardModifiers(event.nativeEvent),
      });
    },
    [send, tabId, threadRef.threadId, viewportPoint],
  );

  const keyboardInput = useCallback(
    (type: "keyDown" | "keyUp", event: ReactKeyboardEvent<HTMLCanvasElement>) => {
      event.preventDefault();
      send({
        threadId: threadRef.threadId,
        tabId,
        type,
        key: event.key,
        code: event.code,
        text:
          type === "keyDown" && event.key.length === 1 && !event.metaKey && !event.ctrlKey
            ? event.key
            : undefined,
        modifiers: keyboardModifiers(event.nativeEvent),
      });
    },
    [send, tabId, threadRef.threadId],
  );

  const wrapperStyle = resolveHostedBrowserWebviewWrapperStyle({
    active,
    rect: lastRect,
    hiddenSize,
  });

  return (
    <div
      ref={wrapperRef}
      className="fixed overflow-hidden bg-muted/35"
      style={{ ...wrapperStyle, overscrollBehavior: "contain" }}
      onScroll={syncContentPresentation}
      data-preview-viewport={tabId}
      data-server-browser-host
    >
      <div className="relative" style={{ width: layout.canvasWidth, height: layout.canvasHeight }}>
        {deviceToolbarVisible && effectiveViewport._tag !== "fill" ? (
          <BrowserDeviceToolbar
            setting={effectiveViewport}
            width={Math.max(1, Math.round(containerSize.width))}
            aspectRatio={lockedAspectRatio}
            onAspectRatioChange={(aspectRatio) => setAspectRatioLocked(aspectRatio !== null)}
            onChange={commitViewportChange}
          />
        ) : null}
        <canvas
          ref={canvasRef}
          tabIndex={active ? 0 : -1}
          aria-hidden={active ? undefined : true}
          data-preview-tab={tabId}
          data-preview-viewport-mode={effectiveViewport._tag}
          data-preview-viewport-key={browserViewportSettingKey(effectiveViewport)}
          className="absolute bg-background outline-none"
          style={{
            left: layout.viewportX,
            top: layout.viewportY,
            width: layout.viewportWidth,
            height: layout.viewportHeight,
          }}
          onPointerDown={(event) => {
            event.currentTarget.focus({ preventScroll: true });
            event.currentTarget.setPointerCapture(event.pointerId);
            pointerInput("pointerDown", event);
          }}
          onPointerMove={(event) => pointerInput("pointerMove", event)}
          onPointerUp={(event) => pointerInput("pointerUp", event)}
          onWheel={(event) => {
            event.preventDefault();
            const point = viewportPoint(event);
            send({
              threadId: threadRef.threadId,
              tabId,
              type: "wheel",
              ...point,
              deltaX: event.deltaX,
              deltaY: event.deltaY,
              modifiers: keyboardModifiers(event.nativeEvent),
            });
          }}
          onKeyDown={(event) => keyboardInput("keyDown", event)}
          onKeyUp={(event) => keyboardInput("keyUp", event)}
          onContextMenu={(event) => event.preventDefault()}
        />
        {active && effectiveViewport._tag !== "fill" ? (
          <>
            <BrowserViewportResizeHandles
              layout={layout}
              activeDirection={activeDrag?.direction ?? null}
              onPointerDown={handleResizePointerDown}
              onKeyDown={handleResizeKeyDown}
            />
            {activeDrag ? (
              <div
                className="pointer-events-none absolute z-40 -translate-x-1/2 rounded-md border border-border/80 bg-background/95 px-2 py-1 text-[11px] font-medium tabular-nums text-foreground shadow-md backdrop-blur-sm"
                style={{
                  left: layout.viewportX + layout.viewportWidth / 2,
                  top: layout.viewportY + 10,
                }}
                aria-hidden="true"
              >
                {activeDrag.width} × {activeDrag.height}
              </div>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

export function ServerBrowserHost() {
  const previewByThreadKey = useActivePreviewSessions();
  const serverConfigs = useServerConfigs();
  const sessions = useMemo(
    () =>
      Object.entries(previewByThreadKey).flatMap(([threadKey, previewState]) => {
        const threadRef = parseScopedThreadKey(threadKey);
        if (!threadRef) return [];
        const runtime = resolvePreviewRuntimeCapability(serverConfigs.get(threadRef.environmentId));
        if (!runtime.supported || runtime.mode !== "server") return [];
        return Object.values(previewState.sessions).map((snapshot) => ({
          threadRef,
          snapshot,
        }));
      }),
    [previewByThreadKey, serverConfigs],
  );

  if (isElectron) return null;
  return (
    <div className="contents" data-server-browser-host-root>
      {sessions.map(({ threadRef, snapshot }) => (
        <ServerBrowserCanvas
          key={snapshot.tabId}
          threadRef={threadRef}
          tabId={snapshot.tabId}
          viewport={snapshot.viewport ?? FILL_PREVIEW_VIEWPORT}
        />
      ))}
    </div>
  );
}
