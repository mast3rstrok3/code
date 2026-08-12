/**
 * Pure URL helpers shared between the preview server, desktop main process,
 * and web renderer. Centralising these guarantees the four call sites agree
 * on what counts as "loopback" and how to normalise a free-form URL string.
 */

import * as Schema from "effect/Schema";

const TAB_ID_PREFIX = "tab_";
let nextPreviewTabSequence = 0;

/**
 * Generate a fresh preview tab id. Lives in shared (not contracts) because
 * the contracts package is schema-only — runtime helpers belong here.
 */
export function newPreviewTabId(): string {
  nextPreviewTabSequence += 1;
  return `${TAB_ID_PREFIX}${nextPreviewTabSequence.toString(36)}`;
}

const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1"]);

/** Internal — used by `lsof` parsing where the host string is wire-formatted. */
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

/** True when a raw URL string looks like a loopback dev URL we can preview. */
export function isPreviewableUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return isLoopbackHost(parsed.hostname);
  } catch {
    return false;
  }
}

export class PreviewUrlNormalizationError extends Schema.TaggedErrorClass<PreviewUrlNormalizationError>()(
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

/**
 * Normalise a free-form URL string into a fully-qualified `http(s)://` URL.
 *
 * - Bare loopback hosts (`localhost`, `localhost:5173`) become `http://...`.
 * - Bare public hosts (`example.com`) become `https://...`.
 * - Already-qualified URLs are validated and returned as `URL.href`.
 *
 * Throws `PreviewUrlNormalizationError` for empty, unparseable, or
 * unsupported-protocol inputs.
 */
export function normalizePreviewUrl(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (trimmed.length === 0) {
    throw new PreviewUrlNormalizationError({ inputLength: rawUrl.length, reason: "empty" });
  }
  const useHttp = LOOPBACK_PREFIX_PATTERN.test(trimmed);
  const candidate = trimmed.includes("://")
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
