// @effect-diagnostics nodeBuiltinImport:off - runs real git and the generated shell scripts against temporary directories.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { DEFAULT_WORKSPACE_USER, WorkspaceUserId, type WorkspaceUser } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { it } from "@effect/vitest";
import { describe, expect, vi } from "vite-plus/test";
import {
  ensureGithubCliShim,
  resolveWorkspaceUserCredentials,
  verifyGithubOwnerToken,
  WORKSPACE_USER_PATH_PREFIX,
  withWorkspaceUserEnvironment,
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

describe("routing by repository owner", () => {
  const credentials = {
    githubPersonalAccessToken: "primary-token",
    githubOwnerTokens: [
      { owner: "nightingale-ai-com", token: "org-token" },
      { owner: "Mast3rStrok3", token: "personal-token" },
    ],
  };
  const scratch = () => NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-owner-tokens-"));
  // Isolated from the host's git config and gh login, so only the generated config answers.
  const isolatedEnvironment = (home: string): NodeJS.ProcessEnv => ({
    PATH: process.env.PATH,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: NodePath.join(home, "gitconfig"),
    GIT_TERMINAL_PROMPT: "0",
    ...workspaceUserProviderEnvironment(credentials),
  });
  const run = (
    command: string,
    args: ReadonlyArray<string>,
    options: { env: NodeJS.ProcessEnv; cwd?: string; input?: string },
  ) => {
    const result = NodeChildProcess.spawnSync(command, args, { ...options, encoding: "utf8" });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    return result.stdout;
  };
  const git = (env: NodeJS.ProcessEnv, cwd: string, ...args: string[]) =>
    run("git", args, { env, cwd }).trim();

  it("exports each owner's token under a case-insensitive name", () => {
    expect(workspaceUserProviderEnvironment(credentials)).toMatchObject({
      GH_TOKEN: "primary-token",
      T3CODE_GITHUB_OWNER_TOKEN_NIGHTINGALE_AI_COM: "org-token",
      T3CODE_GITHUB_OWNER_TOKEN_MAST3RSTROK3: "personal-token",
    });
  });

  it("answers git with the token for the repository owner, falling back to GH_TOKEN", () => {
    const home = scratch();
    const env = isolatedEnvironment(home);
    const fill = (url: string) =>
      run("git", ["credential", "fill"], { env, cwd: home, input: `url=${url}\n\n` });
    expect(fill("https://github.com/mast3rstrok3/code")).toContain(
      "username=x-access-token\npassword=personal-token\n",
    );
    expect(fill("https://github.com/NIGHTINGALE-AI-COM/rudi.git")).toContain(
      "password=org-token\n",
    );
    expect(fill("https://github.com/someone-else/repo.git")).toContain("password=primary-token\n");
    // An ssh remote is rewritten to https before git asks for a credential.
    const rewritten = git(
      env,
      home,
      "ls-remote",
      "--get-url",
      "git@github.com:Mast3rStrok3/code.git",
    );
    expect(rewritten).toBe("https://github.com/Mast3rStrok3/code.git");
    expect(fill(rewritten)).toContain("password=personal-token\n");
    // A rejected or stored credential is left alone.
    for (const action of ["approve", "reject"]) {
      const input = "url=https://github.com/mast3rstrok3/code\nusername=x\npassword=y\n\n";
      expect(run("git", ["credential", action], { env, cwd: home, input })).toBe("");
    }
  });

  it.effect("points gh at the token for the repository it targets", () =>
    Effect.gen(function* () {
      const root = scratch();
      const shimDirectory = yield* ensureGithubCliShim(NodePath.join(root, "state"));
      expect(NodeFS.statSync(NodePath.join(shimDirectory, "gh")).mode & 0o777).toBe(0o700);
      // Stands in for the real gh, which must be found after the shim leaves PATH.
      const realBin = NodePath.join(root, "bin");
      NodeFS.mkdirSync(realBin);
      NodeFS.writeFileSync(
        NodePath.join(realBin, "gh"),
        '#!/bin/sh\nprintf "%s %s\\n" "$GH_TOKEN" "$GITHUB_TOKEN"\n',
        { mode: 0o700 },
      );
      const env = withWorkspaceUserEnvironment(
        { ...isolatedEnvironment(root), PATH: `${realBin}:${process.env.PATH}` },
        {
          ...workspaceUserProviderEnvironment(credentials),
          [WORKSPACE_USER_PATH_PREFIX]: shimDirectory,
        },
      );
      expect(env.PATH?.startsWith(`${shimDirectory}:${realBin}:`)).toBe(true);
      expect(env).not.toHaveProperty(WORKSPACE_USER_PATH_PREFIX);
      const gh = (cwd: string, ...args: string[]) => run("gh", args, { env, cwd }).trim();
      const both = (token: string) => `${token} ${token}`;

      expect(gh(root, "pr", "create", "-R", "Mast3rStrok3/code")).toBe(both("personal-token"));
      expect(gh(root, "pr", "list", "-Rnightingale-ai-com/rudi")).toBe(both("org-token"));
      expect(gh(root, "pr", "view", "--repo=https://github.com/mast3rstrok3/code")).toBe(
        both("personal-token"),
      );
      expect(gh(root, "api", "repos/nightingale-ai-com/rudi", "--jq", ".full_name")).toBe(
        both("org-token"),
      );
      expect(gh(root, "api", "-X", "GET", "/repos/mast3rstrok3/code/pulls")).toBe(
        both("personal-token"),
      );
      expect(gh(root, "repo", "view", "nightingale-ai-com/rudi")).toBe(both("org-token"));
      expect(gh(root, "api", "user")).toBe(both("primary-token"));
      expect(
        run("gh", ["pr", "list"], {
          env: { ...env, GH_REPO: "nightingale-ai-com/rudi" },
          cwd: root,
        }),
      ).toBe(`${both("org-token")}\n`);
      expect(gh(root, "pr", "list", "-R", "someone-else/repo")).toBe(both("primary-token"));

      const checkout = NodePath.join(root, "checkout");
      NodeFS.mkdirSync(checkout);
      git(env, checkout, "init", "-q");
      git(env, checkout, "remote", "add", "origin", "git@github.com:Mast3rStrok3/code.git");
      expect(gh(checkout, "pr", "list")).toBe(both("personal-token"));
      expect(gh(checkout, "api", "repos/{owner}/{repo}/pulls")).toBe(both("personal-token"));
      // gh targets the remote chosen with `gh repo set-default` over origin.
      git(env, checkout, "remote", "add", "upstream", "https://github.com/nightingale-ai-com/rudi");
      git(env, checkout, "config", "remote.upstream.gh-resolved", "base");
      expect(gh(checkout, "pr", "list")).toBe(both("org-token"));
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("verifyGithubOwnerToken", () => {
  const accounts: Record<string, { login: string; type: string }> = {
    "/user": { login: "ada", type: "User" },
    "/users/ada": { login: "ada", type: "User" },
    "/users/grace": { login: "grace", type: "User" },
    "/users/nightingale-ai": { login: "Nightingale-AI", type: "Organization" },
  };
  const github = vi.fn<typeof fetch>().mockImplementation(async (url) => {
    const account = accounts[new URL(String(url)).pathname];
    return account ? Response.json(account) : new Response(null, { status: 404 });
  });

  it.effect("accepts an organization and returns GitHub's spelling of it", () =>
    Effect.gen(function* () {
      const result = yield* verifyGithubOwnerToken(
        { owner: "nightingale-ai", personalAccessToken: "github_pat_ada" },
        github,
      );
      expect(result).toEqual({ valid: true, owner: "Nightingale-AI" });
    }),
  );

  it.effect("refuses an owner GitHub does not know", () =>
    Effect.gen(function* () {
      const result = yield* verifyGithubOwnerToken(
        { owner: "nightingale-a1", personalAccessToken: "github_pat_ada" },
        github,
      );
      expect(result).toEqual({
        valid: false,
        message: "GitHub has no user or organization named nightingale-a1.",
      });
    }),
  );

  it.effect("refuses a fine-grained token saved for someone else's account", () =>
    Effect.gen(function* () {
      const fineGrained = yield* verifyGithubOwnerToken(
        { owner: "grace", personalAccessToken: "github_pat_ada" },
        github,
      );
      expect(fineGrained.valid).toBe(false);
      // A classic token can reach repositories its owner collaborates on.
      const classic = yield* verifyGithubOwnerToken(
        { owner: "grace", personalAccessToken: "ghp_ada" },
        github,
      );
      expect(classic).toEqual({ valid: true, owner: "grace" });
    }),
  );

  it.effect("refuses a token GitHub rejects, and reports an unreachable GitHub", () =>
    Effect.gen(function* () {
      const rejected = yield* verifyGithubOwnerToken(
        { owner: "ada", personalAccessToken: "github_pat_old" },
        vi.fn<typeof fetch>().mockResolvedValue(new Response(null, { status: 401 })),
      );
      expect(rejected).toEqual({
        valid: false,
        message: "GitHub rejected this token. Check that it is complete and not expired.",
      });
      const offline = yield* verifyGithubOwnerToken(
        { owner: "ada", personalAccessToken: "github_pat_ada" },
        vi.fn<typeof fetch>().mockRejectedValue(new TypeError("fetch failed")),
      );
      expect(offline).toEqual({
        valid: false,
        message: "Could not reach GitHub to check the token. Try again.",
      });
    }),
  );
});
