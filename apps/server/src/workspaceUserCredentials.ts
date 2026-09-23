import type { WorkspaceUser } from "@t3tools/contracts";
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

/** The owner token whose owner matches the repository's, else the user's default token. */
export function selectWorkspaceUserGithubToken(
  user: WorkspaceUser,
  repositoryOwner: string | null | undefined,
): { readonly token: string; readonly owner?: string } {
  const owner = repositoryOwner?.trim().toLowerCase();
  const ownerToken = owner
    ? user.github.ownerTokens?.find(
        (token) => token.owner.toLowerCase() === owner && token.personalAccessToken.trim(),
      )
    : undefined;
  return ownerToken
    ? { token: ownerToken.personalAccessToken.trim(), owner: ownerToken.owner }
    : { token: user.github.personalAccessToken.trim() };
}

export const resolveWorkspaceUserCredentials = Effect.fn("resolveWorkspaceUserCredentials")(
  function* (
    user: WorkspaceUser | undefined,
    repositoryOwner?: string | null,
    request: typeof fetch = fetch,
  ) {
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
    const { token, owner } = selectWorkspaceUserGithubToken(user, repositoryOwner);
    if (!token) {
      return yield* new WorkspaceUserCredentialsError({
        message: repositoryOwner
          ? `Add a GitHub token for ${user.displayName} that covers ${repositoryOwner} in Settings > Users before running this thread.`
          : `Add a GitHub token for ${user.displayName} in Settings > Users before running this thread.`,
      });
    }
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
