import { DEFAULT_WORKSPACE_USER, WorkspaceUserId, type WorkspaceUser } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import {
  resolveWorkspaceUserCredentials,
  workspaceUserGitEnvironment,
  workspaceUserProviderEnvironment,
} from "./workspaceUserCredentials.ts";

const user: WorkspaceUser = {
  id: WorkspaceUserId.make("ada"),
  displayName: "Ada",
  github: { personalAccessToken: "test-token" },
};

describe("workspace user credentials", () => {
  it.effect("uses the configured name and the token owner's private noreply address", () =>
    Effect.gen(function* () {
      const request = vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          id: 42,
          login: "ada",
          name: "Ada Lovelace",
          email: "private@example.com",
        }),
      );
      const credentials = yield* resolveWorkspaceUserCredentials(user, { request });
      expect(credentials).toEqual({
        githubPersonalAccessToken: "test-token",
        gitIdentity: { name: "Ada", email: "42+ada@users.noreply.github.com" },
      });
      expect(request).toHaveBeenCalledWith(
        "https://api.github.com/user",
        expect.objectContaining({
          headers: expect.objectContaining({ Authorization: "Bearer test-token" }),
          redirect: "error",
        }),
      );
      expect(workspaceUserGitEnvironment(credentials)).toEqual({
        GIT_AUTHOR_NAME: "Ada",
        GIT_COMMITTER_NAME: "Ada",
        GIT_AUTHOR_EMAIL: "42+ada@users.noreply.github.com",
        GIT_COMMITTER_EMAIL: "42+ada@users.noreply.github.com",
      });
    }),
  );

  it.effect("keeps two users' credentials separate", () =>
    Effect.gen(function* () {
      const request = vi.fn<typeof fetch>().mockImplementation(async (_url, options) => {
        const ada = new Headers(options?.headers).get("Authorization") === "Bearer test-token";
        return Response.json({ id: ada ? 42 : 43, login: ada ? "ada" : "grace", name: null });
      });
      const [ada, grace] = yield* Effect.all(
        [
          resolveWorkspaceUserCredentials(user, { request }),
          resolveWorkspaceUserCredentials(
            {
              ...user,
              id: WorkspaceUserId.make("grace"),
              github: { personalAccessToken: "grace-token" },
            },
            { request },
          ),
        ],
        { concurrency: "unbounded" },
      );
      expect(workspaceUserProviderEnvironment(ada)).toMatchObject({
        GH_TOKEN: "test-token",
        GIT_AUTHOR_EMAIL: "42+ada@users.noreply.github.com",
      });
      expect(workspaceUserProviderEnvironment(grace)).toMatchObject({
        GH_TOKEN: "grace-token",
        GIT_AUTHOR_EMAIL: "43+grace@users.noreply.github.com",
      });
    }),
  );

  it.effect("picks the matching owner token, then the ownerless token, then any token", () =>
    Effect.gen(function* () {
      const request = vi
        .fn<typeof fetch>()
        .mockImplementation(async () => Response.json({ id: 42, login: "ada" }));
      const tokenFor = (github: WorkspaceUser["github"], repositoryOwner: string | null) =>
        resolveWorkspaceUserCredentials({ ...user, github }, { repositoryOwner, request }).pipe(
          Effect.map((credentials) => credentials.githubPersonalAccessToken),
        );
      const ownerTokens = [
        { owner: "empty-org", personalAccessToken: "" },
        { owner: "ada", personalAccessToken: "ada-token" },
        { owner: "Acme", personalAccessToken: "acme-token" },
      ];
      expect(yield* tokenFor({ personalAccessToken: "", ownerTokens }, "acme")).toBe("acme-token");
      expect(yield* tokenFor({ personalAccessToken: "", ownerTokens }, "other")).toBe("ada-token");
      expect(yield* tokenFor({ personalAccessToken: "", ownerTokens }, "empty-org")).toBe(
        "ada-token",
      );
      expect(yield* tokenFor({ personalAccessToken: "legacy", ownerTokens }, "other")).toBe(
        "legacy",
      );
    }),
  );

  it.effect("requires a covering token only when asked to, and names the owner", () =>
    Effect.gen(function* () {
      const request = vi.fn<typeof fetch>().mockResolvedValue(new Response("", { status: 500 }));
      const acmeOnly: WorkspaceUser = {
        ...user,
        github: {
          personalAccessToken: "",
          ownerTokens: [{ owner: "acme", personalAccessToken: "acme-token" }],
        },
      };
      const uncovered = yield* resolveWorkspaceUserCredentials(acmeOnly, {
        repositoryOwner: "other",
        requireRepositoryAccess: true,
        request,
      }).pipe(Effect.flip);
      expect(uncovered.message).toContain("Add a GitHub token for Ada that covers other");
      expect(request).not.toHaveBeenCalled();
      const rejected = yield* resolveWorkspaceUserCredentials(acmeOnly, {
        repositoryOwner: "other",
        request,
      }).pipe(Effect.flip);
      expect(rejected.message).toContain("Could not verify the GitHub token for Ada (acme)");
    }),
  );

  it.effect("rejects the default user without a token before contacting GitHub", () =>
    Effect.gen(function* () {
      const request = vi.fn<typeof fetch>();
      const error = yield* resolveWorkspaceUserCredentials(DEFAULT_WORKSPACE_USER, {
        request,
      }).pipe(Effect.flip);
      expect(error.message).toContain("Add a GitHub token for Nils in Settings > Users");
      expect(request).not.toHaveBeenCalled();
    }),
  );

  it.effect(
    "requires a name for both the default user and other users before contacting GitHub",
    () =>
      Effect.gen(function* () {
        const request = vi.fn<typeof fetch>();
        for (const owner of [DEFAULT_WORKSPACE_USER, user]) {
          const error = yield* resolveWorkspaceUserCredentials(
            { ...owner, displayName: "  ", github: { personalAccessToken: "test-token" } },
            { request },
          ).pipe(Effect.flip);
          expect(error.message).toContain("Add a name for the thread owner in Settings > Users");
        }
        expect(request).not.toHaveBeenCalled();
      }),
  );

  it.effect("rejects missing or invalid user credentials without using the host account", () =>
    Effect.gen(function* () {
      const request = vi
        .fn<typeof fetch>()
        .mockResolvedValue(new Response("sensitive response", { status: 401 }));
      const invalid = yield* resolveWorkspaceUserCredentials(user, { request }).pipe(Effect.flip);
      expect(invalid.message).toContain("Could not verify the GitHub token for Ada");
      const missingToken = yield* resolveWorkspaceUserCredentials(
        { ...user, github: { personalAccessToken: "" } },
        { request },
      ).pipe(Effect.flip);
      expect(missingToken.message).toContain("Add a GitHub token for Ada");
      const missingOwner = yield* resolveWorkspaceUserCredentials(undefined, { request }).pipe(
        Effect.flip,
      );
      expect(missingOwner.message).toContain("thread owner no longer exists");
    }),
  );
});
