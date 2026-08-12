import { describe, expect, it, vi } from "vite-plus/test";

import {
  createThreadRowTouchSwipeController,
  isThreadRowDirectActionPointer,
  PINNED_THREAD_DRAG_ACTIVATION_DISTANCE_PX,
  resolveThreadRowTouchActionKind,
  THREAD_ROW_SWIPE_INTENT_THRESHOLD_PX,
  type ThreadRowSwipePointerInput,
} from "./threadRowTouchSwipe";

function touch(overrides: Partial<ThreadRowSwipePointerInput> = {}): ThreadRowSwipePointerInput {
  return {
    pointerId: 7,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    clientX: 200,
    clientY: 40,
    ...overrides,
  };
}

function harness() {
  let offset = 0;
  let now = 1_000;
  const onCommit = vi.fn();
  const onOpenChange = vi.fn();
  const onOffsetChange = vi.fn((nextOffset: number) => {
    offset = nextOffset;
  });
  const controller = createThreadRowTouchSwipeController({
    getRowWidth: () => 300,
    onCommit,
    onOffsetChange,
    onOpenChange,
    now: () => now,
  });
  return {
    controller,
    onCommit,
    onOffsetChange,
    onOpenChange,
    get offset() {
      return offset;
    },
    advance(ms: number) {
      now += ms;
    },
  };
}

describe("createThreadRowTouchSwipeController", () => {
  it("claims horizontal intent before the pinned-row drag sensor", () => {
    expect(PINNED_THREAD_DRAG_ACTIVATION_DISTANCE_PX).toBeGreaterThan(
      THREAD_ROW_SWIPE_INTENT_THRESHOLD_PX,
    );
  });

  for (const [name, overrides] of [
    ["mouse", { pointerType: "mouse" }],
    ["secondary button", { button: 1 }],
    ["non-primary pointer", { isPrimary: false }],
  ] as const) {
    it(`ignores ${name}`, () => {
      const state = harness();
      state.controller.start(touch(overrides));

      expect(state.controller.move({ pointerId: 7, clientX: 100, clientY: 40 })).toBe("ignored");
      expect(state.offset).toBe(0);
    });
  }

  it("lets vertical movement cancel without consuming the click", () => {
    const state = harness();
    state.controller.start(touch());

    expect(state.controller.move({ pointerId: 7, clientX: 198, clientY: 60 })).toBe("vertical");
    state.controller.end(7);

    expect(state.controller.consumeClick()).toBe(false);
    expect(state.onCommit).not.toHaveBeenCalled();
  });

  it("snaps a short horizontal swipe closed and consumes its click", () => {
    const state = harness();
    state.controller.start(touch());
    expect(state.controller.move({ pointerId: 7, clientX: 180, clientY: 40 })).toBe("horizontal");
    state.controller.end(7);

    expect(state.offset).toBe(0);
    expect(state.controller.isOpen()).toBe(false);
    expect(state.controller.consumeClick()).toBe(true);
    expect(state.controller.consumeClick()).toBe(false);
  });

  it("leaves the action open beyond half its width", () => {
    const state = harness();
    state.controller.start(touch());
    state.controller.move({ pointerId: 7, clientX: 160, clientY: 40 });
    state.controller.end(7);

    expect(state.offset).toBe(-58);
    expect(state.controller.isOpen()).toBe(true);
    expect(state.onOpenChange).toHaveBeenCalledWith(true);
  });

  it("commits exactly once beyond the native-parity full-swipe threshold", () => {
    const state = harness();
    state.controller.start(touch());
    state.controller.move({ pointerId: 7, clientX: 20, clientY: 40 });
    state.controller.end(7);
    state.controller.end(7);

    expect(state.onCommit).toHaveBeenCalledTimes(1);
    expect(state.controller.isOpen()).toBe(false);
  });

  it("closes an open row on a tap or rightward swipe", () => {
    const state = harness();
    state.controller.start(touch());
    state.controller.move({ pointerId: 7, clientX: 160, clientY: 40 });
    state.controller.end(7);
    expect(state.controller.isOpen()).toBe(true);

    state.controller.start(touch());
    state.controller.end(7);
    expect(state.controller.isOpen()).toBe(false);
    expect(state.controller.consumeClick()).toBe(true);

    state.controller.start(touch());
    state.controller.move({ pointerId: 7, clientX: 160, clientY: 40 });
    state.controller.end(7);
    state.controller.start(touch());
    state.controller.move({ pointerId: 7, clientX: 245, clientY: 40 });
    state.controller.end(7);
    expect(state.controller.isOpen()).toBe(false);
  });

  it("closes an open row when its coordinator dismisses it", () => {
    const state = harness();
    state.controller.start(touch());
    state.controller.move({ pointerId: 7, clientX: 160, clientY: 40 });
    state.controller.end(7);
    expect(state.controller.isOpen()).toBe(true);

    state.controller.close();

    expect(state.controller.isOpen()).toBe(false);
    expect(state.offset).toBe(0);
  });

  it("expires click suppression", () => {
    const state = harness();
    state.controller.start(touch());
    state.controller.move({ pointerId: 7, clientX: 180, clientY: 40 });
    state.controller.end(7);
    state.advance(1_001);

    expect(state.controller.consumeClick()).toBe(false);
  });
});

describe("isThreadRowDirectActionPointer", () => {
  it("directly activates primary touch and pen releases", () => {
    expect(isThreadRowDirectActionPointer(touch())).toBe(true);
    expect(isThreadRowDirectActionPointer(touch({ pointerType: "pen" }))).toBe(true);
  });

  it("leaves mouse, secondary, and non-primary activation to click handling", () => {
    expect(isThreadRowDirectActionPointer(touch({ pointerType: "mouse" }))).toBe(false);
    expect(isThreadRowDirectActionPointer(touch({ button: 1 }))).toBe(false);
    expect(isThreadRowDirectActionPointer(touch({ isPrimary: false }))).toBe(false);
  });
});

describe("resolveThreadRowTouchActionKind", () => {
  it("resolves active, settled, and snoozed lifecycle actions", () => {
    expect(
      resolveThreadRowTouchActionKind({
        isSettled: false,
        isSnoozed: false,
        settlementSupported: true,
        snoozeSupported: true,
      }),
    ).toBe("settle");
    expect(
      resolveThreadRowTouchActionKind({
        isSettled: true,
        isSnoozed: false,
        settlementSupported: true,
        snoozeSupported: true,
      }),
    ).toBe("unsettle");
    expect(
      resolveThreadRowTouchActionKind({
        isSettled: false,
        isSnoozed: true,
        settlementSupported: true,
        snoozeSupported: true,
      }),
    ).toBe("wake");
  });

  it("hides actions unsupported by the connected server", () => {
    expect(
      resolveThreadRowTouchActionKind({
        isSettled: false,
        isSnoozed: false,
        settlementSupported: false,
        snoozeSupported: false,
      }),
    ).toBeNull();
    expect(
      resolveThreadRowTouchActionKind({
        isSettled: false,
        isSnoozed: true,
        settlementSupported: true,
        snoozeSupported: false,
      }),
    ).toBeNull();
  });
});
