import type {
  GithubOwnerTokenVerification,
  GithubOwnerTokenVerificationInput,
  WorkspaceUser,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
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
export function selectWorkspaceUserGithubToken(
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
    return {
      githubPersonalAccessToken: token,
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

export function workspaceUserProviderEnvironment(
  credentials: SourceControlCredentialContext | undefined,
): NodeJS.ProcessEnv {
  const token = credentials?.githubPersonalAccessToken;
  return {
    ...workspaceUserGitEnvironment(credentials),
    ...(token
      ? {
          GH_TOKEN: token,
          GITHUB_TOKEN: token,
          GH_HOST: "github.com",
          GH_DEBUG: "",
          GIT_CONFIG_COUNT: "4",
          GIT_CONFIG_KEY_0: "credential.https://github.com.helper",
          GIT_CONFIG_VALUE_0: "",
          GIT_CONFIG_KEY_1: "credential.https://github.com.helper",
          GIT_CONFIG_VALUE_1: "!gh auth git-credential",
          GIT_CONFIG_KEY_2: "url.https://github.com/.insteadOf",
          GIT_CONFIG_VALUE_2: "git@github.com:",
          GIT_CONFIG_KEY_3: "url.https://github.com/.insteadOf",
          GIT_CONFIG_VALUE_3: "ssh://git@github.com/",
        }
      : {}),
  };
}
