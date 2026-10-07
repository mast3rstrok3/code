import type {
  GithubOwnerTokenVerification,
  GithubOwnerTokenVerificationInput,
  WorkspaceUser,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import type { SourceControlCredentialContext } from "./sourceControl/SourceControlProvider.ts";

export class WorkspaceUserCredentialsError extends Schema.TaggedError<WorkspaceUserCredentialsError>()(
  "WorkspaceUserCredentialsError",
  { message: Schema.String },
) {}

/** Scoped to one provider launch. Never persist this value in a session or event. */
export const WorkspaceUserEnvironment = Context.Reference<NodeJS.ProcessEnv>(
  "t3/WorkspaceUserEnvironment",
  { defaultValue: () => ({}) },
);

const GithubIdentity = Schema.Struct({
  id: Schema.Int,
  login: Schema.NonEmptyString,
});

const decodeGithubIdentity = Schema.decodeUnknownEffect(GithubIdentity);

const GithubAccount = Schema.Struct({
  login: Schema.NonEmptyString,
  type: Schema.String,
});

const decodeGithubAccount = Schema.decodeUnknownEffect(GithubAccount);

/**
 * Checks an owner token before it is saved, so a mistyped owner or a dead token
 * fails in Settings instead of as a 403 inside a thread. A fine-grained token
 * reaches only its creator's repositories and those of organizations, so one
 * saved for a different personal account is refused. Organization access
 * cannot be read from the API and is left to GitHub at push time.
 */
export const verifyGithubOwnerToken = Effect.fn("verifyGithubOwnerToken")(function* (
  input: GithubOwnerTokenVerificationInput,
  request: typeof fetch = fetch,
) {
  const invalid = (message: string): GithubOwnerTokenVerification => ({ valid: false, message });
  const get = (path: string) =>
    Effect.tryPromise({
      try: async (signal) => {
        const response = await request(`https://api.github.com${path}`, {
          headers: {
            Authorization: `Bearer ${input.personalAccessToken}`,
            Accept: "application/vnd.github+json",
          },
          signal,
          redirect: "error",
        });
        return { status: response.status, body: response.ok ? await response.json() : null };
      },
      catch: () => new WorkspaceUserCredentialsError({ message: "GitHub request failed." }),
    }).pipe(Effect.timeout("15 seconds"));

  const verification = Effect.gen(function* () {
    const tokenUser = yield* get("/user");
    if (tokenUser.status === 401) {
      return invalid("GitHub rejected this token. Check that it is complete and not expired.");
    }
    if (tokenUser.body === null) {
      return invalid(`GitHub could not check this token (HTTP ${tokenUser.status}).`);
    }
    const ownerAccount = yield* get(`/users/${encodeURIComponent(input.owner)}`);
    if (ownerAccount.status === 404) {
      return invalid(`GitHub has no user or organization named ${input.owner}.`);
    }
    if (ownerAccount.body === null) {
      return invalid(`GitHub could not look up ${input.owner} (HTTP ${ownerAccount.status}).`);
    }
    const [tokenAccount, owner] = yield* Effect.all([
      decodeGithubAccount(tokenUser.body),
      decodeGithubAccount(ownerAccount.body),
    ]);
    if (
      input.personalAccessToken.startsWith("github_pat_") &&
      owner.type === "User" &&
      owner.login.toLowerCase() !== tokenAccount.login.toLowerCase()
    ) {
      return invalid(
        `This token belongs to ${tokenAccount.login}, so it cannot reach repositories owned by ${owner.login}.`,
      );
    }
    return { valid: true, owner: owner.login } satisfies GithubOwnerTokenVerification;
  });

  return yield* verification.pipe(
    Effect.orElseSucceed(() => invalid("Could not reach GitHub to check the token. Try again.")),
  );
});

/**
 * Picks the token for a repository: the owner token matching its GitHub owner,
 * then the legacy ownerless token, then any owner token. The same person owns
 * every token, so any of them yields the right commit identity; `covers` says
 * whether it is expected to grant access to that owner's repositories.
 */
function selectWorkspaceUserGithubToken(
  user: WorkspaceUser,
  repositoryOwner: string | null | undefined,
): { readonly token: string; readonly owner?: string; readonly covers: boolean } | undefined {
  const ownerTokens = (user.github.ownerTokens ?? []).filter((token) =>
    token.personalAccessToken.trim(),
  );
  const owner = repositoryOwner?.trim().toLowerCase();
  const match = owner
    ? ownerTokens.find((token) => token.owner.toLowerCase() === owner)
    : undefined;
  if (match) {
    return { token: match.personalAccessToken.trim(), owner: match.owner, covers: true };
  }
  const legacyToken = user.github.personalAccessToken.trim();
  if (legacyToken) {
    return { token: legacyToken, covers: true };
  }
  const [fallback] = ownerTokens;
  return fallback
    ? { token: fallback.personalAccessToken.trim(), owner: fallback.owner, covers: !owner }
    : undefined;
}

export interface ResolveWorkspaceUserCredentialsOptions {
  /** The repository's GitHub owner, when known. */
  readonly repositoryOwner?: string | null;
  /** Fail instead of falling back to a token for another owner, e.g. before a push. */
  readonly requireRepositoryAccess?: boolean;
  readonly request?: typeof fetch;
}

export const resolveWorkspaceUserCredentials = Effect.fn("resolveWorkspaceUserCredentials")(
  function* (
    user: WorkspaceUser | undefined,
    options: ResolveWorkspaceUserCredentialsOptions = {},
  ) {
    const request = options.request ?? fetch;
    if (!user) {
      return yield* new WorkspaceUserCredentialsError({
        message: "The thread owner no longer exists. Restore the owner in Settings > Users.",
      });
    }
    const name = user.displayName.trim();
    if (!name) {
      return yield* new WorkspaceUserCredentialsError({
        message: "Add a name for the thread owner in Settings > Users before running this thread.",
      });
    }
    const selected = selectWorkspaceUserGithubToken(user, options.repositoryOwner);
    if (!selected) {
      return yield* new WorkspaceUserCredentialsError({
        message: `Add a GitHub token for ${user.displayName} in Settings > Users before running this thread.`,
      });
    }
    if (options.requireRepositoryAccess && !selected.covers) {
      return yield* new WorkspaceUserCredentialsError({
        message: `Add a GitHub token for ${user.displayName} that covers ${options.repositoryOwner} in Settings > Users.`,
      });
    }
    const { token, owner } = selected;
    const identity = yield* Effect.tryPromise({
      try: async (signal) => {
        const response = await request("https://api.github.com/user", {
          headers: { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json" },
          signal,
          redirect: "error",
        });
        if (!response.ok) throw new Error("GitHub rejected the identity request.");
        return (await response.json()) as unknown;
      },
      catch: () =>
        new WorkspaceUserCredentialsError({
          message: `Could not verify the GitHub token for ${user.displayName}${owner ? ` (${owner})` : ""}. Check it in Settings > Users.`,
        }),
    }).pipe(
      Effect.timeout("15 seconds"),
      Effect.catchTag("TimeoutError", () =>
        Effect.fail(
          new WorkspaceUserCredentialsError({
            message: "GitHub identity lookup timed out. Retry the action.",
          }),
        ),
      ),
    );
    const account = yield* decodeGithubIdentity(identity).pipe(
      Effect.mapError(
        () =>
          new WorkspaceUserCredentialsError({
            message: "GitHub returned an invalid user identity.",
          }),
      ),
    );
    const githubOwnerTokens = (user.github.ownerTokens ?? []).flatMap((entry) => {
      const ownerToken = entry.personalAccessToken.trim();
      return ownerToken ? [{ owner: entry.owner.trim(), token: ownerToken }] : [];
    });
    return {
      githubPersonalAccessToken: token,
      ...(githubOwnerTokens.length > 0 ? { githubOwnerTokens } : {}),
      gitIdentity: {
        name,
        email: `${account.id}+${account.login}@users.noreply.github.com`,
      },
    } satisfies SourceControlCredentialContext;
  },
);

export function workspaceUserGitEnvironment(
  credentials: SourceControlCredentialContext | undefined,
): NodeJS.ProcessEnv {
  const identity = credentials?.gitIdentity;
  return identity
    ? {
        GIT_AUTHOR_NAME: identity.name,
        GIT_AUTHOR_EMAIL: identity.email,
        GIT_COMMITTER_NAME: identity.name,
        GIT_COMMITTER_EMAIL: identity.email,
      }
    : {};
}

const GITHUB_OWNER_TOKEN_PREFIX = "T3CODE_GITHUB_OWNER_TOKEN_";

/**
 * The variable holding a user's token for one GitHub owner, e.g.
 * `T3CODE_GITHUB_OWNER_TOKEN_NIGHTINGALE_AI_COM`. GitHub owner names are
 * letters, digits and single hyphens and compare case-insensitively, so
 * upper-casing and turning hyphens into underscores cannot collide.
 */
export function githubOwnerTokenVariable(owner: string): string | undefined {
  const key = owner.trim().toUpperCase().replaceAll("-", "_");
  return /^[A-Z0-9_]+$/.test(key) ? `${GITHUB_OWNER_TOKEN_PREFIX}${key}` : undefined;
}

// Shell lines that set `token` from `$owner` with the same mapping as githubOwnerTokenVariable.
const SHELL_OWNER_TOKEN = [
  'key=$(printf %s "$owner" | tr abcdefghijklmnopqrstuvwxyz- ABCDEFGHIJKLMNOPQRSTUVWXYZ_)',
  `case $key in ''|*[!A-Z0-9_]*) token= ;; *) token=$(printenv "${GITHUB_OWNER_TOKEN_PREFIX}$key") ;; esac`,
];

/**
 * Git credential helper for github.com. With `useHttpPath` set, git sends the
 * repository path, so the first path segment names the owner; ssh remotes are
 * rewritten to https first and arrive the same way. Answers with that owner's
 * token, or GH_TOKEN when the user saved none for it. Tokens stay in the
 * environment; the helper only reads them.
 */
const GITHUB_CREDENTIAL_HELPER = [
  "!f() {",
  'test "$1" = get || return 0',
  "owner=",
  "while IFS= read -r line; do",
  "case $line in path=*) owner=${line#path=}; owner=${owner#/}; owner=${owner%%/*} ;; esac",
  "done",
  ...SHELL_OWNER_TOKEN,
  "token=${token:-$GH_TOKEN}",
  'test -n "$token" || return 0',
  "printf 'username=x-access-token\\npassword=%s\\n' \"$token\"",
  "}; f",
].join("\n");

/**
 * `gh` reads only GH_TOKEN, so this shim picks the owner from `-R/--repo`, an
 * `api repos/<owner>/...` path, `gh repo <command> <owner>/<repo>`, GH_REPO, or
 * the checkout's base remote (the one `gh repo set-default` chose, else origin),
 * sets GH_TOKEN to that owner's token when there is one, and runs the real gh.
 */
const GITHUB_CLI_SHIM = [
  "#!/bin/sh",
  "# Written by T3 Code. Uses the thread owner's token for the repository this gh call targets.",
  "set -f",
  "shim_dir=${0%/*}",
  "real_path=",
  "saved_ifs=$IFS",
  "IFS=:",
  "for entry in $PATH; do",
  '  test "$entry" = "$shim_dir" || real_path=${real_path:+$real_path:}$entry',
  "done",
  "IFS=$saved_ifs",
  "set +f",
  "repo=",
  "prev=",
  'for arg in "$@"; do',
  "  case $prev in -R|--repo) repo=$arg ;; esac",
  "  case $arg in --repo=*) repo=${arg#--repo=} ;; -R?*) repo=${arg#-R} ;; esac",
  "  prev=$arg",
  "done",
  'if [ -z "$repo" ] && [ "$1" = api ]; then',
  '  for arg in "$@"; do',
  // `{owner}` is gh's placeholder for the checkout's repository, resolved below.
  "    case $arg in repos/{*|/repos/{*) break ;; repos/*/*|/repos/*/*) repo=${arg#/}; repo=${repo#repos/}; break ;; esac",
  "  done",
  "fi",
  'if [ -z "$repo" ] && [ "$1" = repo ]; then',
  "  case $3 in -*) ;; */*) repo=$3 ;; esac",
  "fi",
  "repo=${repo:-$GH_REPO}",
  'if [ -z "$repo" ]; then',
  "  remote=$(git config --get-regexp '^remote\\..*\\.gh-resolved$' 2>/dev/null)",
  "  remote=${remote%%.gh-resolved*}",
  "  remote=${remote#remote.}",
  '  repo=$(git config --get "remote.${remote:-origin}.url" 2>/dev/null)',
  "fi",
  "repo=${repo#*://}",
  "repo=${repo#*@}",
  "repo=${repo#github.com[:/]}",
  "owner=",
  "case $repo in */*) owner=${repo%%/*} ;; esac",
  ...SHELL_OWNER_TOKEN,
  'if [ -n "$token" ]; then',
  "  GH_TOKEN=$token",
  "  GITHUB_TOKEN=$token",
  "  export GH_TOKEN GITHUB_TOKEN",
  "fi",
  "PATH=$real_path",
  "export PATH",
  'exec gh "$@"',
  "",
].join("\n");

/**
 * Writes the gh shim to `<stateDir>/github/bin` and returns that directory.
 * The script holds no tokens; it reads them from the environment.
 */
export const ensureGithubCliShim = Effect.fn("ensureGithubCliShim")(function* (stateDir: string) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = path.join(stateDir, "github", "bin");
  yield* fs.makeDirectory(directory, { recursive: true });
  const shimPath = path.join(directory, "gh");
  // Rename into place so an agent running the previous copy never reads a partial file.
  const tempPath = `${shimPath}.${process.pid}.tmp`;
  yield* fs.writeFileString(tempPath, GITHUB_CLI_SHIM);
  yield* fs.chmod(tempPath, 0o700);
  yield* fs.rename(tempPath, shimPath);
  return directory;
});

/** Set in a workspace user environment to prepend a directory to the provider's PATH. */
export const WORKSPACE_USER_PATH_PREFIX = "T3CODE_WORKSPACE_USER_PATH_PREFIX";

/** Layers the thread owner's environment over a provider's, prepending the owner's tools to PATH. */
export function withWorkspaceUserEnvironment(
  base: NodeJS.ProcessEnv,
  owner: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const { [WORKSPACE_USER_PATH_PREFIX]: prefix, ...rest } = owner;
  if (!prefix) return { ...base, ...rest };
  return { ...base, ...rest, PATH: base.PATH ? `${prefix}:${base.PATH}` : prefix };
}

export function workspaceUserProviderEnvironment(
  credentials: SourceControlCredentialContext | undefined,
): NodeJS.ProcessEnv {
  const token = credentials?.githubPersonalAccessToken;
  const ownerTokens: NodeJS.ProcessEnv = {};
  for (const { owner, token: ownerToken } of credentials?.githubOwnerTokens ?? []) {
    const variable = githubOwnerTokenVariable(owner);
    if (variable && !(variable in ownerTokens)) ownerTokens[variable] = ownerToken;
  }
  return {
    ...workspaceUserGitEnvironment(credentials),
    ...(token
      ? {
          ...ownerTokens,
          GH_TOKEN: token,
          GITHUB_TOKEN: token,
          GH_HOST: "github.com",
          GH_DEBUG: "",
          GIT_CONFIG_COUNT: "5",
          GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
          GIT_CONFIG_VALUE_0: "",
          GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
          GIT_CONFIG_VALUE_1: GITHUB_CREDENTIAL_HELPER,
          GIT_CONFIG_KEY_2: "credential.https://github.com.useHttpPath",
          GIT_CONFIG_VALUE_2: "true",
          GIT_CONFIG_KEY_3: "url.https://github.com/.insteadOf",
          GIT_CONFIG_VALUE_3: "git@github.com:",
          GIT_CONFIG_KEY_4: "url.https://github.com/.insteadOf",
          GIT_CONFIG_VALUE_4: "ssh://git@github.com/",
        }
      : {}),
  };
}
