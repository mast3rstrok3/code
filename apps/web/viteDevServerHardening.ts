// @effect-diagnostics nodeBuiltinImport:off - Vite dev-server hardening runs in Node during local serving.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import type * as NodeHttp from "node:http";
import type { Connect, Plugin } from "vite";

export const PUBLIC_DEV_CACHE_HEADERS = {
  "Cache-Control": "private, no-store, max-age=0, must-revalidate",
  Pragma: "no-cache",
  Expires: "0",
  "X-Content-Type-Options": "nosniff",
} as const satisfies Record<string, string>;

const VITE_FS_PREFIX = "/@fs";
const VITE_OPTIMIZED_DEPS_PREFIX = "/node_modules/.vite/deps/";
const LOCAL_HOSTNAMES = new Set(["localhost"]);

export function resolveDevProxyTarget(input: {
  readonly explicitProxyTarget?: string;
  readonly wsUrl?: string;
}): string | undefined {
  const explicitProxyTarget = input.explicitProxyTarget?.trim();
  return normalizeProxyTarget(explicitProxyTarget || input.wsUrl);
}

export function shouldHardenPublicDevServerCache(devServerUrl: string): boolean {
  let url: URL;
  try {
    url = new URL(devServerUrl);
  } catch {
    return false;
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return false;
  }

  const hostname = normalizeHostname(url.hostname);
  return !isLocalHostname(hostname);
}

export function resolveViteInternalFilesystemRequest(
  root: string,
  requestUrl: string | undefined,
): string | null {
  if (!requestUrl) {
    return null;
  }

  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(requestUrl, "http://vite.local").pathname);
  } catch {
    return null;
  }

  if (pathname.startsWith(`${VITE_FS_PREFIX}/`)) {
    return NodePath.resolve(pathname.slice(VITE_FS_PREFIX.length));
  }

  if (pathname.startsWith(VITE_OPTIMIZED_DEPS_PREFIX)) {
    return NodePath.resolve(NodePath.resolve(root), `.${pathname}`);
  }

  return null;
}

function normalizeProxyTarget(rawValue: string | undefined): string | undefined {
  if (!rawValue) {
    return undefined;
  }

  try {
    const url = new URL(rawValue);
    if (url.protocol === "ws:") {
      url.protocol = "http:";
    } else if (url.protocol === "wss:") {
      url.protocol = "https:";
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    url.pathname = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return undefined;
  }
}

export function createViteInternalModuleFallbackGuardMiddleware(
  root: string,
): Connect.NextHandleFunction {
  return (request, response, next) => {
    void guardViteInternalModuleFallback(root, request, response, next);
  };
}

export function viteInternalModuleFallbackGuardPlugin(): Plugin {
  return {
    name: "t3code:vite-internal-module-fallback-guard",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use(createViteInternalModuleFallbackGuardMiddleware(server.config.root));
    },
  };
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/\.$/u, "")
    .replace(/^\[(.*)\]$/u, "$1");
}

function isLocalHostname(hostname: string): boolean {
  if (
    LOCAL_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".localhost") ||
    hostname.endsWith(".local")
  ) {
    return true;
  }

  const ipVersion = NodeNet.isIP(hostname);
  if (ipVersion === 4) {
    return hostname === "0.0.0.0" || hostname.startsWith("127.");
  }
  if (ipVersion === 6) {
    return hostname === "::" || hostname === "::1";
  }
  return false;
}

async function guardViteInternalModuleFallback(
  root: string,
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  next: Connect.NextFunction,
): Promise<void> {
  const filesystemPath = resolveViteInternalFilesystemRequest(root, request.url);
  if (filesystemPath === null) {
    next();
    return;
  }

  try {
    const stats = await NodeFS.promises.stat(filesystemPath);
    if (stats.isFile()) {
      next();
      return;
    }
  } catch {
    respondWithMissingInternalModule(response);
    return;
  }

  respondWithMissingInternalModule(response);
}

function respondWithMissingInternalModule(response: NodeHttp.ServerResponse): void {
  response.statusCode = 404;
  for (const [name, value] of Object.entries(PUBLIC_DEV_CACHE_HEADERS)) {
    response.setHeader(name, value);
  }
  response.setHeader("Content-Type", "text/plain; charset=utf-8");
  response.end("Vite internal module not found.\n");
}
