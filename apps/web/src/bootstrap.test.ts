import { afterEach, describe, expect, it, vi } from "vite-plus/test";

function createStorageStub(initial: Record<string, string> = {}): Storage {
  const store = new Map(Object.entries(initial));
  return {
    getItem: (key) => store.get(key) ?? null,
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  };
}

async function bootWith(mainFactory: () => object, storage: Storage = createStorageStub()) {
  vi.resetModules();
  const showBootError = vi.fn().mockName("showBootError");
  const reload = vi.fn().mockName("reloadApp");
  vi.doMock("./lib/bootError", () => ({ showBootError }));
  // The real reload refreshes assets through the document first; the guard only needs a reload.
  vi.doMock("./lib/reloadApp", () => ({ reloadApp: reload }));
  vi.doMock("./main", mainFactory);
  vi.stubGlobal("window", Object.assign(new EventTarget(), { sessionStorage: storage }));
  const { boot } = await import("./bootstrap");
  await boot;
  return { reload, showBootError };
}

// Mirrors Vite's build preload helper when main's CSS or JS chunk fails to load.
function failingMainChunk(): never {
  const error = new TypeError("Failed to fetch dynamically imported module: /assets/main.js");
  const event = Object.assign(new Event("vite:preloadError", { cancelable: true }), {
    payload: error,
  });
  window.dispatchEvent(event);
  throw error;
}

describe("bootstrap", () => {
  afterEach(() => {
    vi.doUnmock("./main");
    vi.doUnmock("./lib/bootError");
    vi.doUnmock("./lib/reloadApp");
    vi.unstubAllGlobals();
  });

  it("shows failures from asynchronous app startup", async () => {
    const failure = new Error("Startup chunks failed");
    const { reload, showBootError } = await bootWith(() => ({
      startup: Promise.reject(failure),
    }));

    expect(reload).not.toHaveBeenCalled();
    expect(showBootError).toHaveBeenCalledWith(failure);
  });

  it("shows the boot error when an app import throws before main can run", async () => {
    const { showBootError } = await bootWith(() => {
      throw new Error("@vitejs/plugin-react can't detect preamble. Something is wrong.");
    });

    expect(showBootError).toHaveBeenCalledTimes(1);
  });

  it("reloads once instead of showing the boot error when the main chunk fails to load", async () => {
    const { reload, showBootError } = await bootWith(failingMainChunk);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(showBootError).not.toHaveBeenCalled();
  });

  it("shows the boot error when the main chunk fails again after the reload", async () => {
    const { reload, showBootError } = await bootWith(
      failingMainChunk,
      createStorageStub({ "t3code:chunk-load-reloaded": import.meta.env.APP_VERSION }),
    );

    expect(reload).not.toHaveBeenCalled();
    expect(showBootError).toHaveBeenCalledTimes(1);
  });
});
