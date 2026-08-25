import type { ProviderFailureRecovery } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";

function isoFromEpochMs(value: number): string | undefined {
  return Option.map(DateTime.make(value), DateTime.formatIso).pipe(Option.getOrUndefined);
}

function findNativeField(value: unknown, keys: ReadonlySet<string>, depth = 0): unknown {
  if (!Predicate.isObject(value) || depth > 4) return undefined;
  for (const [key, field] of Object.entries(value)) {
    if (keys.has(key.toLowerCase())) return field;
  }
  for (const field of Object.values(value)) {
    const found = findNativeField(field, keys, depth + 1);
    if (found !== undefined) return found;
  }
  return undefined;
}

function readStatusCode(value: unknown): number | undefined {
  const raw = findNativeField(value, new Set(["status", "statuscode", "httpstatus"]));
  const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed >= 100 && parsed <= 599 ? parsed : undefined;
}

function readRetryAt(value: unknown, failedAt: string): string | undefined {
  const direct = findNativeField(value, new Set(["retryat"]));
  if (typeof direct === "string" && !Number.isNaN(Date.parse(direct))) {
    return isoFromEpochMs(Date.parse(direct));
  }
  const retryAfter = findNativeField(value, new Set(["retry-after", "retryafter", "retry_after"]));
  if (
    typeof retryAfter === "string" &&
    !/^\s*\d+(?:\.\d+)?\s*$/.test(retryAfter) &&
    !Number.isNaN(Date.parse(retryAfter))
  ) {
    return isoFromEpochMs(Date.parse(retryAfter));
  }
  const seconds =
    typeof retryAfter === "number"
      ? retryAfter
      : typeof retryAfter === "string" && retryAfter.trim().length > 0
        ? Number(retryAfter)
        : NaN;
  const failedAtMs = Date.parse(failedAt);
  return Number.isFinite(seconds) && seconds >= 0 && !Number.isNaN(failedAtMs)
    ? isoFromEpochMs(failedAtMs + seconds * 1_000)
    : undefined;
}

function nativeRetryable(value: unknown): boolean | undefined {
  const field = findNativeField(value, new Set(["isretryable", "retryable"]));
  return typeof field === "boolean" ? field : undefined;
}

export function classifyProviderFailure(input: {
  readonly error: unknown;
  readonly message: string;
  readonly failedAt: string;
}): ProviderFailureRecovery {
  const statusCode = readStatusCode(input.error);
  const retryAt = readRetryAt(input.error, input.failedAt);
  const retryable = nativeRetryable(input.error);
  const text = input.message.toLowerCase();

  const classified = (() => {
    if (
      statusCode === 401 ||
      statusCode === 403 ||
      /auth|credential|api key|unauthori/.test(text)
    ) {
      return { disposition: "terminal", reason: "authentication" } as const;
    }
    if (
      statusCode === 400 ||
      statusCode === 404 ||
      statusCode === 422 ||
      /configuration|configured|invalid model|unknown model|not enabled|not installed/.test(text)
    ) {
      return { disposition: "terminal", reason: "configuration" } as const;
    }
    if (statusCode === 429 || /rate.?limit|usage limit|quota/.test(text)) {
      return { disposition: "retryable", reason: "rate-limit" } as const;
    }
    if (
      statusCode === 502 ||
      statusCode === 503 ||
      statusCode === 504 ||
      /overload|unavailable/.test(text)
    ) {
      return { disposition: "retryable", reason: "overloaded" } as const;
    }
    if (/timeout|timed out|transport|connection|network|socket|econn/.test(text)) {
      return { disposition: "retryable", reason: "transport" } as const;
    }
    if (retryable === true || (statusCode !== undefined && statusCode >= 500)) {
      return { disposition: "retryable", reason: "provider" } as const;
    }
    if (retryable === false) {
      return { disposition: "terminal", reason: "provider" } as const;
    }
    return { disposition: "unknown", reason: "unknown" } as const;
  })();

  return {
    ...classified,
    ...(retryAt !== undefined ? { retryAt } : {}),
    ...(statusCode !== undefined ? { statusCode } : {}),
  };
}
