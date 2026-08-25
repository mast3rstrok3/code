import { describe, expect, it } from "vite-plus/test";

import { classifyProviderFailure } from "./providerFailureRecovery.ts";

describe("classifyProviderFailure", () => {
  it("preserves OpenCode 429 retry metadata", () => {
    expect(
      classifyProviderFailure({
        error: {
          data: {
            isRetryable: true,
            statusCode: 429,
            headers: { "Retry-After": "120" },
          },
        },
        message: "Rate limit reached",
        failedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      disposition: "retryable",
      reason: "rate-limit",
      statusCode: 429,
      retryAt: "2026-01-01T00:02:00.000Z",
    });
  });

  it("preserves OpenCode 503 retry metadata", () => {
    expect(
      classifyProviderFailure({
        error: {
          data: {
            isRetryable: true,
            statusCode: 503,
            retryAt: "2026-01-01T00:10:00.000Z",
          },
        },
        message: "Upstream service unavailable",
        failedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toEqual({
      disposition: "retryable",
      reason: "overloaded",
      statusCode: 503,
      retryAt: "2026-01-01T00:10:00.000Z",
    });
  });

  it("classifies authentication and configuration failures as terminal", () => {
    expect(
      classifyProviderFailure({
        error: { statusCode: 401, isRetryable: false },
        message: "Unauthorized",
        failedAt: "2026-01-01T00:00:00.000Z",
      }).disposition,
    ).toBe("terminal");
    expect(
      classifyProviderFailure({
        error: { statusCode: 400, isRetryable: false },
        message: "Invalid model configuration",
        failedAt: "2026-01-01T00:00:00.000Z",
      }).reason,
    ).toBe("configuration");
  });
});
