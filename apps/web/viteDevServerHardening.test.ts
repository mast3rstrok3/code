// @effect-diagnostics nodeBuiltinImport:off - Tests exercise Vite dev-server filesystem middleware.
import * as NodeFS from "node:fs";
import type * as NodeHttp from "node:http";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import type { Connect } from "vite";

import {
  createViteInternalModuleFallbackGuardMiddleware,
  PUBLIC_DEV_CACHE_HEADERS,
  resolveDevProxyTarget,
  resolveViteInternalFilesystemRequest,
  shouldHardenPublicDevServerCache,
} from "./viteDevServerHardening";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("shouldHardenPublicDevServerCache", () => {
  it.each([
    "https://code-dev.nightingale-ai.com",
    "http://code-dev.nightingale-ai.com:5733",
    "https://192.168.1.25:5733",
  ])("hardens public/non-loopback dev URL %s", (devServerUrl) => {
    expect(shouldHardenPublicDevServerCache(devServerUrl)).toBe(true);
  });

  it.each([
    "",
    "not-a-url",
    "ws://code-dev.nightingale-ai.com",
    "file:///tmp/index.html",
    "http://localhost:5733",
    "http://app.localhost:5733",
    "http://code-dev.local:5733",
    "http://127.0.0.1:5733",
    "http://[::1]:5733",
  ])("does not harden local or non-http dev URL %s", (devServerUrl) => {
    expect(shouldHardenPublicDevServerCache(devServerUrl)).toBe(false);
  });
});

describe("resolveDevProxyTarget", () => {
  it("prefers an explicit HTTP proxy target over the browser-facing WebSocket URL", () => {
    expect(
      resolveDevProxyTarget({
        explicitProxyTarget: " http://127.0.0.1:7020/backend?ignored=1#ignored ",
        wsUrl: "wss://code-dev.nightingale-ai.com",
      }),
    ).toBe("http://127.0.0.1:7020/");
  });

  it("derives an HTTP proxy target from the WebSocket URL when no override is configured", () => {
    expect(
      resolveDevProxyTarget({
        wsUrl: "wss://code-dev.nightingale-ai.com/ws?ticket=secret",
      }),
    ).toBe("https://code-dev.nightingale-ai.com/");
  });

  it("ignores invalid or unsupported proxy targets", () => {
    expect(resolveDevProxyTarget({ explicitProxyTarget: "file:///tmp/server.sock" })).toBe(
      undefined,
    );
    expect(resolveDevProxyTarget({ explicitProxyTarget: "not a url" })).toBe(undefined);
  });
});

describe("resolveViteInternalFilesystemRequest", () => {
  it("resolves /@fs requests to absolute filesystem paths", () => {
    const root = NodePath.resolve("/tmp/t3code-web");
    const modulePath = NodePath.join(
      root,
      "node_modules/.pnpm/vite-plus-core@0.1.24/node_modules/vite-plus-core/dist/env.mjs",
    );

    expect(resolveViteInternalFilesystemRequest(root, `/@fs${modulePath}?import&v=stale`)).toBe(
      modulePath,
    );
  });

  it("resolves optimized dependency requests under the Vite deps directory", () => {
    const root = NodePath.resolve("/tmp/t3code-web");

    expect(
      resolveViteInternalFilesystemRequest(
        root,
        "/node_modules/.vite/deps/@pierre_diffs_worker_worker__js.js?v=stale",
      ),
    ).toBe(NodePath.join(root, "node_modules/.vite/deps/@pierre_diffs_worker_worker__js.js"));
  });

  it.each([
    "/threads/abc",
    "/src/main.ts",
    "/@vite/client",
    "/node_modules/react/index.js",
    "/node_modules/.vite/client",
  ])("returns null for non-internal app route %s", (requestUrl) => {
    expect(resolveViteInternalFilesystemRequest("/tmp/t3code-web", requestUrl)).toBeNull();
  });
});

describe("createViteInternalModuleFallbackGuardMiddleware", () => {
  it("responds with a non-HTML 404 for missing internal module requests", async () => {
    const root = makeTemporaryDirectory();
    const middleware = createViteInternalModuleFallbackGuardMiddleware(root);
    const response = new TestResponse();
    let nextCalled = false;

    middleware(
      {
        url: "/node_modules/.vite/deps/@pierre_diffs_worker_worker__js.js?v=stale",
      } as unknown as NodeHttp.IncomingMessage,
      response as unknown as NodeHttp.ServerResponse,
      (() => {
        nextCalled = true;
      }) satisfies Connect.NextFunction,
    );

    await response.ended;

    expect(nextCalled).toBe(false);
    expect(response.statusCode).toBe(404);
    expect(response.body).toBe("Vite internal module not found.\n");
    expect(response.body).not.toContain("<html");
    expect(response.getHeader("content-type")).toBe("text/plain; charset=utf-8");
    expect(response.getHeader("cache-control")).toBe(PUBLIC_DEV_CACHE_HEADERS["Cache-Control"]);
    expect(response.getHeader("pragma")).toBe(PUBLIC_DEV_CACHE_HEADERS.Pragma);
    expect(response.getHeader("expires")).toBe(PUBLIC_DEV_CACHE_HEADERS.Expires);
    expect(response.getHeader("x-content-type-options")).toBe(
      PUBLIC_DEV_CACHE_HEADERS["X-Content-Type-Options"],
    );
  });
});

class TestResponse {
  readonly headers = new Map<string, string | number | readonly string[]>();
  readonly ended: Promise<void>;
  statusCode = 200;
  body = "";

  private resolveEnded: () => void = () => {};

  constructor() {
    this.ended = new Promise((resolve) => {
      this.resolveEnded = resolve;
    });
  }

  setHeader(name: string, value: string | number | readonly string[]): this {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  getHeader(name: string) {
    return this.headers.get(name.toLowerCase());
  }

  end(chunk?: string | Uint8Array): this {
    if (typeof chunk === "string") {
      this.body += chunk;
    } else if (chunk) {
      this.body += new TextDecoder().decode(chunk);
    }
    this.resolveEnded();
    return this;
  }
}

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-vite-dev-"));
  temporaryDirectories.push(directory);
  return directory;
}
