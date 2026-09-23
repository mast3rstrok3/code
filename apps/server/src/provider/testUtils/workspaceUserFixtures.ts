// @effect-diagnostics globalFetch:off - test stub that wraps the global fetch.
import { DEFAULT_WORKSPACE_USER, type WorkspaceUser } from "@t3tools/contracts";
import { vi } from "@effect/vitest";

/** Provider sessions resolve the thread owner's GitHub identity before starting. */
export const TEST_WORKSPACE_USER: WorkspaceUser = {
  ...DEFAULT_WORKSPACE_USER,
  github: { personalAccessToken: "test-default-token" },
};

/**
 * Answers the owner's GitHub identity lookup and passes every other request to
 * the real fetch. Pair with `vi.unstubAllGlobals()`.
 */
export function stubGithubIdentityFetch(): void {
  const realFetch = globalThis.fetch;
  vi.stubGlobal(
    "fetch",
    vi.fn<typeof fetch>((input, init) =>
      String(input instanceof Request ? input.url : input) === "https://api.github.com/user"
        ? Promise.resolve(Response.json({ id: 1, login: "default-user" }))
        : realFetch(input, init),
    ),
  );
}
