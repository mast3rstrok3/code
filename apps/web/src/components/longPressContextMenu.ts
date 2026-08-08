export const LONG_PRESS_CONTEXT_MENU_DELAY_MS = 500;
export const LONG_PRESS_CONTEXT_MENU_MOVE_TOLERANCE_PX = 10;

export interface LongPressPointerInput {
  readonly pointerId: number;
  readonly pointerType: string;
  readonly isPrimary: boolean;
  readonly button: number;
  readonly clientX: number;
  readonly clientY: number;
}

interface PendingLongPress {
  readonly pointerId: number;
  readonly startX: number;
  readonly startY: number;
  clientX: number;
  clientY: number;
  timer: ReturnType<typeof setTimeout>;
}

export interface LongPressContextMenuController {
  readonly start: (input: LongPressPointerInput) => void;
  readonly move: (input: Pick<LongPressPointerInput, "pointerId" | "clientX" | "clientY">) => void;
  readonly end: (pointerId: number) => void;
  readonly cancel: () => void;
  readonly consumeClick: () => boolean;
  readonly consumeContextMenu: () => boolean;
  readonly dispose: () => void;
}

export function createLongPressContextMenuController(input: {
  readonly onLongPress: (position: { x: number; y: number }) => void;
  readonly delayMs?: number;
  readonly moveTolerancePx?: number;
  readonly now?: () => number;
}): LongPressContextMenuController {
  const delayMs = input.delayMs ?? LONG_PRESS_CONTEXT_MENU_DELAY_MS;
  const moveTolerancePx = input.moveTolerancePx ?? LONG_PRESS_CONTEXT_MENU_MOVE_TOLERANCE_PX;
  const now = input.now ?? Date.now;
  let pending: PendingLongPress | null = null;
  let suppressClickUntil = 0;
  let suppressContextMenuUntil = 0;

  const cancel = () => {
    if (pending !== null) clearTimeout(pending.timer);
    pending = null;
  };

  const start = (pointer: LongPressPointerInput) => {
    cancel();
    if (
      !pointer.isPrimary ||
      pointer.button !== 0 ||
      (pointer.pointerType !== "touch" && pointer.pointerType !== "pen")
    ) {
      return;
    }

    let gesture: PendingLongPress;
    const timer = setTimeout(() => {
      if (pending !== gesture) return;
      pending = null;
      const suppressionDeadline = now() + 1_000;
      suppressClickUntil = suppressionDeadline;
      // Mobile browsers may synthesize a contextmenu event immediately after
      // their own long-press threshold. Ignore only that nearby duplicate;
      // a later mouse right-click must keep working.
      suppressContextMenuUntil = suppressionDeadline;
      input.onLongPress({ x: gesture.clientX, y: gesture.clientY });
    }, delayMs);
    gesture = {
      pointerId: pointer.pointerId,
      startX: pointer.clientX,
      startY: pointer.clientY,
      clientX: pointer.clientX,
      clientY: pointer.clientY,
      timer,
    };
    pending = gesture;
  };

  const move: LongPressContextMenuController["move"] = (pointer) => {
    if (pending === null || pending.pointerId !== pointer.pointerId) return;
    const deltaX = pointer.clientX - pending.startX;
    const deltaY = pointer.clientY - pending.startY;
    if (deltaX * deltaX + deltaY * deltaY > moveTolerancePx * moveTolerancePx) {
      cancel();
      return;
    }
    pending.clientX = pointer.clientX;
    pending.clientY = pointer.clientY;
  };

  const end = (pointerId: number) => {
    if (pending?.pointerId === pointerId) cancel();
  };

  return {
    start,
    move,
    end,
    cancel,
    consumeClick: () => {
      const shouldSuppress = suppressClickUntil !== 0 && now() <= suppressClickUntil;
      suppressClickUntil = 0;
      return shouldSuppress;
    },
    consumeContextMenu: () => {
      cancel();
      if (suppressContextMenuUntil === 0 || now() > suppressContextMenuUntil) {
        suppressContextMenuUntil = 0;
        return false;
      }
      suppressContextMenuUntil = 0;
      return true;
    },
    dispose: cancel,
  };
}
