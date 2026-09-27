import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { reloadApp } from "./reloadApp";

function browserWithAssets(urls: string[], origin = "https://code.example") {
  const reload = vi.fn();
  vi.stubGlobal("window", { location: { origin, reload } });
  vi.stubGlobal("document", {
    baseURI: `${origin}/`,
    querySelectorAll: () => urls.map((href) => ({ href })),
  });
  return reload;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("reloadApp", () => {
  it("replaces a damaged cached chunk completely before navigating", async () => {
    const asset = "https://code.example/assets/chat-hash.js";
    const reload = browserWithAssets([asset, asset, "https://fonts.example/font.css"]);
    const cached = new Map([[asset, "export const chat = ("]]);
    let finishBody: (bytes: ArrayBuffer) => void = () => {
      throw new Error("Response body is not ready.");
    };
    const body = new Promise<ArrayBuffer>((resolve) => {
      finishBody = resolve;
    });
    const fetchAsset = vi.fn(async (url: string, options: RequestInit) => {
      if (options.cache !== "reload") throw new Error("Would reuse the damaged cached response.");
      return {
        arrayBuffer: async () => {
          const bytes = await body;
          cached.set(url, new TextDecoder().decode(bytes));
          return bytes;
        },
      };
    });
    vi.stubGlobal("fetch", fetchAsset);

    const recovering = reloadApp();
    await Promise.resolve();
    expect(reload).not.toHaveBeenCalled();
    finishBody(new TextEncoder().encode("export const chat = true;").buffer);
    await recovering;

    expect(cached.get(asset)).toBe("export const chat = true;");
    expect(fetchAsset).toHaveBeenCalledOnce();
    expect(reload).toHaveBeenCalledOnce();
  });

  it("still navigates to the new index when an old chunk is unavailable", async () => {
    const reload = browserWithAssets(["https://code.example/assets/removed-hash.js"]);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Failed to fetch")));

    await reloadApp();

    expect(reload).toHaveBeenCalledOnce();
  });

  it("aborts a stalled refresh and reloads without waiting indefinitely", async () => {
    vi.useFakeTimers();
    const reload = browserWithAssets(["https://code.example/assets/chat-hash.js"]);
    const fetchAsset = vi.fn(
      (_url: string, { signal }: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          signal?.addEventListener("abort", () =>
            reject(new DOMException("Aborted", "AbortError")),
          );
        }),
    );
    vi.stubGlobal("fetch", fetchAsset);

    const recovering = reloadApp();
    await vi.advanceTimersByTimeAsync(15_000);
    await recovering;

    expect(fetchAsset.mock.calls[0]?.[1].signal?.aborted).toBe(true);
    expect(reload).toHaveBeenCalledOnce();
  });

  it("reloads a file-backed desktop shell without fetching file URLs", async () => {
    const reload = browserWithAssets(["file:///Applications/T3/assets/chat-hash.js"], "null");
    const fetchAsset = vi.fn();
    vi.stubGlobal("fetch", fetchAsset);
    vi.stubGlobal("document", {
      baseURI: "file:///Applications/T3/index.html",
      querySelectorAll: () => [{ href: "file:///Applications/T3/assets/chat-hash.js" }],
    });

    await reloadApp();

    expect(fetchAsset).not.toHaveBeenCalled();
    expect(reload).toHaveBeenCalledOnce();
  });
});
