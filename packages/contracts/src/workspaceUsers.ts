import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const WorkspaceUserId = TrimmedNonEmptyString.pipe(Schema.brand("WorkspaceUserId"));
export type WorkspaceUserId = typeof WorkspaceUserId.Type;

export const DEFAULT_WORKSPACE_USER_ID = WorkspaceUserId.make("nils");

const GithubPersonalAccessTokenFields = {
  personalAccessToken: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  personalAccessTokenRedacted: Schema.optionalKey(Schema.Boolean),
};

/**
 * A token used only for repositories whose GitHub owner (user or organization)
 * matches `owner`, case-insensitively. Fine-grained tokens cover one owner each.
 */
export const WorkspaceUserGithubOwnerToken = Schema.Struct({
  owner: TrimmedNonEmptyString,
  ...GithubPersonalAccessTokenFields,
});
export type WorkspaceUserGithubOwnerToken = typeof WorkspaceUserGithubOwnerToken.Type;

/** `personalAccessToken` is the default for repositories no owner token matches. */
export const WorkspaceUserGithubSettings = Schema.Struct({
  ...GithubPersonalAccessTokenFields,
  ownerTokens: Schema.optionalKey(Schema.Array(WorkspaceUserGithubOwnerToken)),
});
export type WorkspaceUserGithubSettings = typeof WorkspaceUserGithubSettings.Type;

export const WorkspaceUser = Schema.Struct({
  id: WorkspaceUserId,
  displayName: TrimmedNonEmptyString,
  github: WorkspaceUserGithubSettings.pipe(
    Schema.withDecodingDefault(Effect.succeed({ personalAccessToken: "" })),
  ),
});
export type WorkspaceUser = typeof WorkspaceUser.Type;

export const DEFAULT_WORKSPACE_USER: WorkspaceUser = {
  id: DEFAULT_WORKSPACE_USER_ID,
  displayName: "Nils",
  github: {
    personalAccessToken: "",
  },
};

export const WorkspaceUserView = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("all"),
  }),
  Schema.Struct({
    kind: Schema.Literal("user"),
    userId: WorkspaceUserId,
  }),
]);
export type WorkspaceUserView = typeof WorkspaceUserView.Type;

export const DEFAULT_WORKSPACE_USER_VIEW: WorkspaceUserView = { kind: "all" };
