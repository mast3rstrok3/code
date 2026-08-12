import { AlarmClockOffIcon, CheckIcon, Undo2Icon } from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

import { cn } from "~/lib/utils";
import { createLongPressContextMenuController } from "./longPressContextMenu";
import {
  createThreadRowTouchSwipeController,
  isThreadRowDirectActionPointer,
  THREAD_ROW_SWIPE_ACTION_WIDTH_PX,
  type ThreadRowTouchActionKind,
} from "./threadRowTouchSwipe";

export interface SidebarThreadTouchAction {
  readonly kind: ThreadRowTouchActionKind;
  readonly label: string;
  readonly onPress: () => void;
}

export type SidebarThreadTouchOpenCoordinator = (
  key: string,
  open: boolean,
  close: () => void,
) => void;

function isInteractiveTarget(target: EventTarget | null): boolean {
  return (
    target instanceof Element &&
    target.closest("button, a, input, textarea, select, [role='menuitem']") !== null
  );
}

/** Adds coarse-pointer swipe and long-press behavior without changing mouse rows. */
export function SidebarThreadTouchSurface(props: {
  readonly action: SidebarThreadTouchAction | null;
  readonly children: ReactNode;
  readonly className?: string;
  readonly coordinatorKey: string;
  readonly onContextMenu: (position: { x: number; y: number }) => void;
  readonly onOpenChange: SidebarThreadTouchOpenCoordinator;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const actionRef = useRef(props.action);
  const contextMenuRef = useRef(props.onContextMenu);
  const coordinatorRef = useRef(props.onOpenChange);
  const suppressActionClickRef = useRef(false);
  const swipeControllerRef = useRef<ReturnType<typeof createThreadRowTouchSwipeController> | null>(
    null,
  );
  const [open, setOpen] = useState(false);
  actionRef.current = props.action;
  contextMenuRef.current = props.onContextMenu;
  coordinatorRef.current = props.onOpenChange;

  const close = useCallback(() => swipeControllerRef.current?.close(), []);
  const invokeAction = useCallback(() => {
    const action = actionRef.current;
    if (action === null) return;
    action.onPress();
    swipeControllerRef.current?.close();
  }, []);
  const swipeController = useMemo(
    () =>
      createThreadRowTouchSwipeController({
        getRowWidth: () => contentRef.current?.getBoundingClientRect().width ?? 0,
        onCommit: invokeAction,
        onOffsetChange: (offset, options) => {
          const content = contentRef.current;
          if (!content) return;
          content.style.transitionDuration = options.animate ? "" : "0ms";
          content.style.transform = `translate3d(${offset}px, 0, 0)`;
        },
        onOpenChange: (nextOpen) => {
          setOpen(nextOpen);
          coordinatorRef.current(props.coordinatorKey, nextOpen, close);
        },
      }),
    [close, invokeAction, props.coordinatorKey],
  );
  swipeControllerRef.current = swipeController;

  const longPressController = useMemo(
    () =>
      createLongPressContextMenuController({
        onLongPress: (position) => {
          swipeController.close();
          contextMenuRef.current(position);
        },
      }),
    [swipeController],
  );

  useEffect(
    () => () => {
      longPressController.dispose();
      coordinatorRef.current(props.coordinatorKey, false, close);
    },
    [close, longPressController, props.coordinatorKey],
  );

  useEffect(() => {
    if (!open) return;
    const dismissOutside = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node | null)) close();
    };
    const dismissForScroll = () => close();
    document.addEventListener("pointerdown", dismissOutside, true);
    window.addEventListener("scroll", dismissForScroll, true);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      window.removeEventListener("scroll", dismissForScroll, true);
    };
  }, [close, open]);

  useEffect(() => {
    if (props.action === null) close();
  }, [close, props.action]);

  const handlePointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      if (isInteractiveTarget(event.target)) {
        if (swipeController.isOpen()) swipeController.close();
        return;
      }
      const pointer = {
        pointerId: event.pointerId,
        pointerType: event.pointerType,
        isPrimary: event.isPrimary,
        button: event.button,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      if (actionRef.current !== null) swipeController.start(pointer);
      longPressController.start(pointer);
    },
    [longPressController, swipeController],
  );
  const handlePointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const pointer = {
        pointerId: event.pointerId,
        clientX: event.clientX,
        clientY: event.clientY,
      };
      longPressController.move(pointer);
      const result = swipeController.move(pointer);
      if (result !== "horizontal") return;
      longPressController.cancel();
      event.preventDefault();
      event.stopPropagation();
      if (!event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.setPointerCapture(event.pointerId);
      }
    },
    [longPressController, swipeController],
  );
  const handlePointerEnd = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      longPressController.end(event.pointerId);
      swipeController.end(event.pointerId);
      if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
      }
    },
    [longPressController, swipeController],
  );
  const handlePointerCancel = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      longPressController.end(event.pointerId);
      swipeController.cancel(event.pointerId);
    },
    [longPressController, swipeController],
  );

  return (
    <div
      ref={rootRef}
      className={cn(
        "relative overflow-hidden rounded-md bg-sidebar [touch-action:pan-y]",
        props.className,
      )}
    >
      {props.action ? (
        <button
          type="button"
          aria-hidden={!open}
          aria-label={`${props.action.label} thread`}
          tabIndex={open ? 0 : -1}
          className={cn(
            "absolute inset-y-0 right-0 flex cursor-pointer flex-col items-center justify-center gap-0.5 bg-[#007aff] text-[10px] font-medium text-white outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-white",
            open ? "z-[2] pointer-events-auto" : "z-0 pointer-events-none",
          )}
          style={{ width: THREAD_ROW_SWIPE_ACTION_WIDTH_PX }}
          onPointerDown={(event) => {
            if (isThreadRowDirectActionPointer(event)) event.stopPropagation();
          }}
          onPointerUp={(event) => {
            if (!isThreadRowDirectActionPointer(event)) return;
            event.preventDefault();
            event.stopPropagation();
            suppressActionClickRef.current = true;
            invokeAction();
          }}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
            if (suppressActionClickRef.current && event.detail !== 0) {
              suppressActionClickRef.current = false;
              return;
            }
            suppressActionClickRef.current = false;
            invokeAction();
          }}
        >
          {props.action.kind === "settle" ? (
            <CheckIcon aria-hidden className="size-4" />
          ) : props.action.kind === "unsettle" ? (
            <Undo2Icon aria-hidden className="size-4" />
          ) : (
            <AlarmClockOffIcon aria-hidden className="size-4" />
          )}
          <span>{props.action.label}</span>
        </button>
      ) : null}
      <div
        ref={contentRef}
        className="relative z-[1] bg-sidebar transition-transform duration-150 ease-out motion-reduce:duration-0"
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerEnd}
        onPointerCancel={handlePointerCancel}
        onClickCapture={(event) => {
          const suppressSwipe = swipeController.consumeClick();
          const suppressLongPress = longPressController.consumeClick();
          if (!suppressSwipe && !suppressLongPress) return;
          event.preventDefault();
          event.stopPropagation();
        }}
        onContextMenu={(event) => {
          event.preventDefault();
          event.stopPropagation();
          if (longPressController.consumeContextMenu()) return;
          props.onContextMenu({ x: event.clientX, y: event.clientY });
        }}
      >
        {props.children}
      </div>
    </div>
  );
}
