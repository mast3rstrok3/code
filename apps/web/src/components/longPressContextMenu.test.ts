import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createLongPressContextMenuController,
  LONG_PRESS_CONTEXT_MENU_DELAY_MS,
} from "./longPressContextMenu";

afterEach(() => {
  vi.useRealTimers();
});

function touch(overrides: Partial<Parameters<LongPressController["start"]>[0]> = {}) {
  return {
    pointerId: 7,
    pointerType: "touch",
    isPrimary: true,
    button: 0,
    clientX: 24,
    clientY: 36,
    ...overrides,
  };
}

type LongPressController = ReturnType<typeof createLongPressContextMenuController>;

describe("createLongPressContextMenuController", () => {
  it("opens at the latest touch position after the hold threshold", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const controller = createLongPressContextMenuController({ onLongPress });

    controller.start(touch());
    controller.move({ pointerId: 7, clientX: 27, clientY: 39 });
    vi.advanceTimersByTime(LONG_PRESS_CONTEXT_MENU_DELAY_MS);

    expect(onLongPress).toHaveBeenCalledWith({ x: 27, y: 39 });
    expect(controller.consumeClick()).toBe(true);
    expect(controller.consumeClick()).toBe(false);
  });

  it("ignores mouse pointers", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const controller = createLongPressContextMenuController({ onLongPress });

    controller.start(touch({ pointerType: "mouse" }));
    vi.runAllTimers();

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels when scrolling moves beyond the tolerance", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const controller = createLongPressContextMenuController({ onLongPress });

    controller.start(touch());
    controller.move({ pointerId: 7, clientX: 24, clientY: 48 });
    vi.runAllTimers();

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("cancels when the pointer is released before the threshold", () => {
    vi.useFakeTimers();
    const onLongPress = vi.fn();
    const controller = createLongPressContextMenuController({ onLongPress });

    controller.start(touch());
    controller.end(7);
    vi.runAllTimers();

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it("suppresses only the synthetic context menu adjacent to a long press", () => {
    vi.useFakeTimers();
    let now = 1_000;
    const controller = createLongPressContextMenuController({
      onLongPress: vi.fn(),
      now: () => now,
    });

    controller.start(touch());
    vi.runAllTimers();

    expect(controller.consumeContextMenu()).toBe(true);
    expect(controller.consumeContextMenu()).toBe(false);

    controller.start(touch());
    vi.runAllTimers();
    now += 1_001;
    expect(controller.consumeContextMenu()).toBe(false);
  });

  it("does not suppress an ordinary context menu", () => {
    const controller = createLongPressContextMenuController({ onLongPress: vi.fn() });

    expect(controller.consumeContextMenu()).toBe(false);
  });
});
