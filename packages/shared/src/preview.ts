import type { BrowserSearchEngine } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { isLocalLoopbackHost } from "./hostClassification.ts";

const TAB_ID_PREFIX = "tab_";
let nextPreviewTabSequence = 0;

export function previewPdfAssetUrl(rawUrl: string, httpBaseUrl: string | null): string | null {
  if (httpBaseUrl === null) return null;
  try {
    const url = new URL(rawUrl);
    const baseUrl = new URL(httpBaseUrl);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:") ||
      !url.pathname.startsWith("/api/assets/") ||
      !/\.pdf$/i.test(url.pathname)
    ) {
      return null;
    }
    if (
      url.origin !== baseUrl.origin &&
      !isLocalLoopbackHost(url.hostname) &&
      url.hostname !== "0.0.0.0"
    ) {
      return url.href;
    }
    // The browser may run on the host's loopback address. Fetch signed bytes
    // through this client's environment connection, including remote routes.
    return new URL(`${url.pathname}${url.search}${url.hash}`, baseUrl).href;
  } catch {
    return null;
  }
}

export function newPreviewTabId(): string {
  nextPreviewTabSequence += 1;
  return `${TAB_ID_PREFIX}${nextPreviewTabSequence.toString(36)}`;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

export const LSOF_LOCAL_HOST_TOKENS: ReadonlySet<string> = new Set([
  ...LOOPBACK_HOSTS,
  "*",
  "[::]",
  "[::1]",
]);

const LOOPBACK_PREFIX_PATTERN = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])(?::|\/|$)/i;
const EXPLICIT_HTTP_URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`]+/giu;
const CHROMIUM_NET_ERROR_PATTERN = /\b(?:net::)?(ERR_[A-Z0-9_]+)\b/u;
const DESCRIPTION_MAX_LENGTH = 256;

const CHROMIUM_NET_ERROR_CODES: Readonly<Record<string, number>> = {
  ERR_FAILED: -2,
  ERR_ABORTED: -3,
  ERR_TIMED_OUT: -7,
  ERR_CONNECTION_CLOSED: -100,
  ERR_CONNECTION_RESET: -101,
  ERR_CONNECTION_REFUSED: -102,
  ERR_CONNECTION_ABORTED: -103,
  ERR_CONNECTION_FAILED: -104,
  ERR_NAME_NOT_RESOLVED: -105,
  ERR_INTERNET_DISCONNECTED: -106,
  ERR_SSL_PROTOCOL_ERROR: -107,
  ERR_ADDRESS_INVALID: -108,
  ERR_ADDRESS_UNREACHABLE: -109,
  ERR_TUNNEL_CONNECTION_FAILED: -111,
  ERR_CONNECTION_TIMED_OUT: -118,
  ERR_NETWORK_ACCESS_DENIED: -138,
  ERR_CERT_COMMON_NAME_INVALID: -200,
  ERR_CERT_DATE_INVALID: -201,
  ERR_CERT_AUTHORITY_INVALID: -202,
  ERR_CERT_CONTAINS_ERRORS: -203,
  ERR_CERT_NO_REVOCATION_MECHANISM: -204,
  ERR_CERT_UNABLE_TO_CHECK_REVOCATION: -205,
  ERR_CERT_REVOKED: -206,
  ERR_CERT_INVALID: -207,
};

export function isLoopbackHost(host: string): boolean {
  if (LOOPBACK_HOSTS.has(host)) return true;
  if (host === "[::1]") return true;
  return false;
}

export class PreviewUrlNormalizationError extends Schema.TaggedError<PreviewUrlNormalizationError>()(
  "PreviewUrlNormalizationError",
  {
    inputLength: Schema.Number,
    reason: Schema.Literals(["empty", "parse", "unsupported-protocol"]),
    protocol: Schema.optional(Schema.String),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const protocol = this.protocol === undefined ? "" : `: ${this.protocol}`;
    return `Invalid preview URL (${this.reason}${protocol}; input length ${this.inputLength}).`;
  }
}

export const isPreviewUrlNormalizationError = Schema.is(PreviewUrlNormalizationError);

function previewUrlProtocol(rawUrl: string): string | undefined {
  return /^([A-Za-z][A-Za-z\d+.-]*):/.exec(rawUrl)?.[1]?.toLowerCase().concat(":");
}

const ADDRESS_HOST_PATTERN = /^(?:localhost|\d{1,3}(?:\.\d{1,3}){3}|\[[\da-f:.]+\])$/i;
const BARE_HOST_PORT_PATTERN = /^[^/?#:@]+:\d+(?:[/?#]|$)/;
const URL_SCHEME_WITH_AUTHORITY_PATTERN = /^[a-z][a-z\d+.-]*:\/\//i;
const KNOWN_NON_WEB_SCHEMES: ReadonlySet<string> = new Set([
  "about:",
  "blob:",
  "chrome:",
  "data:",
  "file:",
  "ftp:",
  "javascript:",
  "mailto:",
  "sms:",
  "ssh:",
  "tel:",
  "view-source:",
  "ws:",
  "wss:",
]);

/** Address bar search URL templates; `%s` is replaced with the encoded query. */
const BROWSER_SEARCH_URL_TEMPLATES = {
  duckduckgo: "https://duckduckgo.com/?q=%s",
  google: "https://www.google.com/search?q=%s",
  bing: "https://www.bing.com/search?q=%s",
  brave: "https://search.brave.com/search?q=%s",
  kagi: "https://kagi.com/search?q=%s",
  ecosia: "https://www.ecosia.org/search?q=%s",
} satisfies Record<Exclude<BrowserSearchEngine, "custom">, string>;

function fillSearchUrlTemplate(template: string, query: string): string {
  return template.replaceAll("%s", encodeURIComponent(query));
}

/**
 * Whether a custom search URL is an http(s) URL with `%s` where the query goes.
 * `%s` in the host or credentials is rejected: the query would never reach a
 * search page, and a query with spaces would make the host unreachable.
 */
export function isValidSearchUrlTemplate(template: string): boolean {
  if (!template.includes("%s")) return false;
  try {
    // Two queries land on different authorities only when `%s` sits before the path.
    const authority = (url: URL) => `${url.username}:${url.password}@${url.host}`;
    const url = new URL(fillSearchUrlTemplate(template, "a"));
    const other = new URL(fillSearchUrlTemplate(template, "b"));
    return (
      (url.protocol === "http:" || url.protocol === "https:") && authority(url) === authority(other)
    );
  } catch {
    return false;
  }
}

/**
 * The search URL template for the chosen engine. An unusable custom template
 * falls back to DuckDuckGo so a query typed in the address bar always searches.
 */
export function resolveSearchUrlTemplate(settings: {
  readonly browserSearchEngine: BrowserSearchEngine;
  readonly browserCustomSearchUrl: string;
}): string {
  if (settings.browserSearchEngine !== "custom") {
    return BROWSER_SEARCH_URL_TEMPLATES[settings.browserSearchEngine];
  }
  const custom = settings.browserCustomSearchUrl.trim();
  return isValidSearchUrlTemplate(custom) ? custom : BROWSER_SEARCH_URL_TEMPLATES.duckduckgo;
}

export function resolveAddressBarInput(
  rawInput: string,
  searchUrlTemplate: string = BROWSER_SEARCH_URL_TEMPLATES.duckduckgo,
): string {
  const trimmed = rawInput.trim();
  if (URL_SCHEME_WITH_AUTHORITY_PATTERN.test(trimmed) || trimmed.length === 0)
    return normalizePreviewUrl(trimmed);
  if (!/\s/.test(trimmed)) {
    // `mailto:x` or `data:...` is an explicit scheme; `example.com:8080` or
    // `devbox:8080` is a bare host and port. `normalizePreviewUrl` would read
    // `mailto:alice@example.com` as credentials on a bare host, so reject here.
    const protocol = previewUrlProtocol(trimmed);
    if (
      protocol !== undefined &&
      (KNOWN_NON_WEB_SCHEMES.has(protocol) || !BARE_HOST_PORT_PATTERN.test(trimmed))
    ) {
      if (protocol !== "http:" && protocol !== "https:") {
        throw new PreviewUrlNormalizationError({
          inputLength: rawInput.length,
          reason: "unsupported-protocol",
          protocol,
        });
      }
      return normalizePreviewUrl(trimmed);
    }
    const authority = trimmed.split(/[/?#]/, 1)[0] ?? "";
    const host = authority.replace(/^[^@]*@/, "").replace(/:\d+$/, "");
    const hasPort = host.length < authority.replace(/^[^@]*@/, "").length;
    if (hasPort || ADDRESS_HOST_PATTERN.test(host) || /^[^.]+(?:\.[^.]+)+\.?$/.test(host)) {
      try {
        return normalizePreviewUrl(trimmed);
      } catch {}
    }
  }
  return fillSearchUrlTemplate(searchUrlTemplate, trimmed);
}

export function normalizePreviewUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    throw new PreviewUrlNormalizationError({ inputLength: rawUrl.length, reason: "empty" });
  }
  const useHttp = LOOPBACK_PREFIX_PATTERN.test(trimmed);
  const candidate = URL_SCHEME_WITH_AUTHORITY_PATTERN.test(trimmed)
    ? trimmed
    : `${useHttp ? "http" : "https"}://${trimmed}`;
  let parsed: URL;
  try {
    parsed = new URL(candidate);
  } catch (cause) {
    throw new PreviewUrlNormalizationError({
      inputLength: rawUrl.length,
      reason: "parse",
      protocol: previewUrlProtocol(candidate),
      cause,
    });
  }
  // The server preview browser reports page URLs unredacted; a data: URL would put its
  // content in tool results and logs.
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new PreviewUrlNormalizationError({
      inputLength: rawUrl.length,
      reason: "unsupported-protocol",
      protocol: parsed.protocol,
    });
  }
  return parsed.href;
}

function trimProseUrlSuffix(rawUrl: string): string {
  let candidate = rawUrl.replace(/[.,;:!?]+$/u, "");
  for (const [open, close] of [
    ["(", ")"],
    ["[", "]"],
    ["{", "}"],
  ] as const) {
    while (
      candidate.endsWith(close) &&
      candidate.split(close).length > candidate.split(open).length
    ) {
      candidate = candidate.slice(0, -1);
    }
  }
  return candidate;
}

/** Extract distinct explicit HTTP(S) preview URLs pasted into prose or Markdown. */
export function extractPreviewUrls(text: string): ReadonlyArray<string> {
  const urls = new Set<string>();
  for (const match of text.matchAll(EXPLICIT_HTTP_URL_PATTERN)) {
    try {
      urls.add(normalizePreviewUrl(trimProseUrlSuffix(match[0])));
    } catch {
      // A URL-like token should not make the surrounding review brief invalid.
    }
  }
  return [...urls];
}

export interface ChromiumNetError {
  readonly code: number;
  readonly description: string;
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === "string") return error;
  return String(error);
}

function redactUrlSecrets(value: string): string {
  return value.replace(/\bhttps?:\/\/[^\s"'<>)]*/giu, (match) => {
    try {
      const url = new URL(match);
      url.username = "";
      url.password = "";
      url.search = "";
      url.hash = "";
      return url.href;
    } catch {
      return match;
    }
  });
}

export function extractChromiumNetError(error: unknown): ChromiumNetError | null {
  const description = CHROMIUM_NET_ERROR_PATTERN.exec(errorText(error))?.[1];
  if (!description) return null;
  return {
    code: CHROMIUM_NET_ERROR_CODES[description] ?? -1,
    description,
  };
}

export function sanitizePreviewNavigationFailureDescription(error: unknown): string {
  const raw = errorText(error);
  const firstLine = raw
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  const cleaned = redactUrlSecrets(firstLine ?? "Navigation failed.")
    .replace(/\p{Cc}+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  if (cleaned.length === 0) return "Navigation failed.";
  if (cleaned.length <= DESCRIPTION_MAX_LENGTH) return cleaned;
  return `${cleaned.slice(0, DESCRIPTION_MAX_LENGTH - 3)}...`;
}
