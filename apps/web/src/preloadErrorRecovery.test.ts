import { describe, expect, it, vi } from "vite-plus/test";

import { installPreloadErrorRecovery } from "./preloadErrorRecovery";

function makeStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("installPreloadErrorRecovery", () => {
  it("reloads once when a deployed lazy chunk is stale", () => {
    const target = new EventTarget();
    const reload = vi.fn();
    installPreloadErrorRecovery({ target, storage: makeStorage(), reload });

    const first = new Event("vite:preloadError", { cancelable: true });
    Object.assign(first, { payload: new Error("/assets/AppReviewPanel-old.js") });
    target.dispatchEvent(first);

    expect(first.defaultPrevented).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("allows a repeated failure through instead of looping on reload", () => {
    const target = new EventTarget();
    const storage = makeStorage();
    const reload = vi.fn();
    installPreloadErrorRecovery({ target, storage, reload });

    for (let index = 0; index < 2; index += 1) {
      const event = new Event("vite:preloadError", { cancelable: true });
      Object.assign(event, { payload: new Error("/assets/AppReviewPanel-broken.js") });
      target.dispatchEvent(event);
      expect(event.defaultPrevented).toBe(index === 0);
    }

    expect(reload).toHaveBeenCalledOnce();
  });
});
