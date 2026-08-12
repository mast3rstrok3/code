export const THREAD_ROW_SWIPE_ACTION_WIDTH_PX = 58;
export const THREAD_ROW_SWIPE_INTENT_THRESHOLD_PX = 8;
export const PINNED_THREAD_DRAG_ACTIVATION_DISTANCE_PX = THREAD_ROW_SWIPE_INTENT_THRESHOLD_PX + 2;

const CLICK_SUPPRESSION_MS = 1_000;

export type ThreadRowTouchActionKind = "settle" | "unsettle" | "wake";

export function isThreadRowDirectActionPointer(input: {
  readonly pointerType: string;
  readonly isPrimary: boolean;
  readonly button: number;
}): boolean {
  return (
    input.isPrimary &&
    input.button === 0 &&
    (input.pointerType === "touch" || input.pointerType === "pen")
  );
}

export function resolveThreadRowTouchActionKind(input: {
  readonly isSettled: boolean;
  readonly isSnoozed: boolean;
  readonly settlementSupported: boolean;
  readonly snoozeSupported: boolean;
}): ThreadRowTouchActionKind | null {
  if (input.isSnoozed) return input.snoozeSupported ? "wake" : null;
  if (!input.settlementSupported) return null;
  return input.isSettled ? "unsettle" : "settle";
}

export interface ThreadRowSwipePointerInput {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  readonly button: number;
  readonly clientX: number;
  readonly clientY: number;
}

export type ThreadRowSwipeMoveResult = "ignored" | "pending" | "vertical" | "horizontal";

export interface ThreadRowTouchSwipeController {
  readonly start: (pointer: ThreadRowSwipePointerInput) => void;
  readonly move: (
    pointer: Pick<ThreadRowSwipePointerInput, "pointerId" | "clientX" | "clientY">,
  ) => ThreadRowSwipeMoveResult;
  readonly end: (pointerId: number) => void;
  readonly cancel: (pointerId?: number) => void;
  readonly close: () => void;
  readonly consumeClick: () => boolean;
  readonly isOpen: () => boolean;
}

interface ActiveSwipe {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  readonly startedOpen: boolean;
  intent: "pending" | "horizontal";
  offset: number;
}

/**
 * Pointer-only state machine for the web sidebar's touch swipe action. DOM
 * updates stay in the caller so pointer moves do not force React renders.
 */
export function createThreadRowTouchSwipeController(input: {
  readonly getRowWidth: () => number;
  readonly onCommit: () => void;
  readonly onOffsetChange: (offset: number, options: { readonly animate: boolean }) => void;
  readonly onOpenChange: (open: boolean) => void;
  readonly actionWidthPx?: number;
  readonly intentThresholdPx?: number;
  readonly now?: () => number;
}): ThreadRowTouchSwipeController {
  const actionWidthPx = input.actionWidthPx ?? THREAD_ROW_SWIPE_ACTION_WIDTH_PX;
  const intentThresholdPx = input.intentThresholdPx ?? THREAD_ROW_SWIPE_INTENT_THRESHOLD_PX;
  const now = input.now ?? Date.now;
  let active: ActiveSwipe | null = null;
  let open = false;
  let suppressClickUntil = 0;

  const setOpen = (nextOpen: boolean, animate: boolean) => {
    active = null;
    if (open !== nextOpen) {
      open = nextOpen;
      input.onOpenChange(open);
    }
    input.onOffsetChange(open ? -actionWidthPx : 0, { animate });
  };

  const suppressClick = () => {
    suppressClickUntil = now() + CLICK_SUPPRESSION_MS;
  };

  const start = (pointer: ThreadRowSwipePointerInput) => {
    if (active !== null && active.pointerId !== pointer.pointerId) {
      setOpen(false, true);
    }
    if (
      !pointer.isPrimary ||
      pointer.button !== 0 ||
      (pointer.pointerType !== "touch" && pointer.pointerType !== "pen")
    ) {
      return;
    }
    active = {
      pointerId: pointer.pointerId,
      startX: pointer.clientX,
      startY: pointer.clientY,
      startedOpen: open,
      intent: "pending",
      offset: open ? -actionWidthPx : 0,
    };
  };

  const move: ThreadRowTouchSwipeController["move"] = (pointer) => {
    if (active === null || active.pointerId !== pointer.pointerId) return "ignored";

    const deltaX = pointer.clientX - active.startX;
    const deltaY = pointer.clientY - active.startY;
    if (active.intent === "pending") {
      const absX = Math.abs(deltaX);
      const absY = Math.abs(deltaY);
      if (Math.max(absX, absY) < intentThresholdPx) return "pending";
      if (absY >= absX) {
        setOpen(false, true);
        return "vertical";
      }
      if (!active.startedOpen && deltaX > 0) {
        return "pending";
      }
      active.intent = "horizontal";
    }

    const baseOffset = active.startedOpen ? -actionWidthPx : 0;
    const rowWidth = Math.max(input.getRowWidth(), actionWidthPx);
    active.offset = Math.max(-rowWidth, Math.min(0, baseOffset + deltaX));
    input.onOffsetChange(active.offset, { animate: false });
    return "horizontal";
  };

  const end = (pointerId: number) => {
    if (active === null || active.pointerId !== pointerId) return;
    const gesture = active;
    active = null;

    if (gesture.intent !== "horizontal") {
      if (gesture.startedOpen) {
        suppressClick();
        setOpen(false, true);
      }
      return;
    }

    suppressClick();
    const revealedDistance = -gesture.offset;
    const fullSwipeThreshold = Math.max(actionWidthPx + 44, input.getRowWidth() * 0.58);
    if (revealedDistance >= fullSwipeThreshold) {
      setOpen(false, true);
      input.onCommit();
      return;
    }
    setOpen(revealedDistance >= actionWidthPx / 2, true);
  };

  const cancel = (pointerId?: number) => {
    if (pointerId !== undefined && active?.pointerId !== pointerId) return;
    if (active === null) return;
    setOpen(false, true);
  };

  return {
    start,
    move,
    end,
    cancel,
    close: () => setOpen(false, true),
    consumeClick: () => {
      const shouldSuppress = suppressClickUntil !== 0 && now() <= suppressClickUntil;
      suppressClickUntil = 0;
      return shouldSuppress;
    },
    isOpen: () => open,
  };
}
