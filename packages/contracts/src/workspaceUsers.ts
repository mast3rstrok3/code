import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString, TrimmedString } from "./baseSchemas.ts";

export const WorkspaceUserId = TrimmedNonEmptyString.pipe(Schema.brand("WorkspaceUserId"));
export type WorkspaceUserId = typeof WorkspaceUserId.Type;

export const DEFAULT_WORKSPACE_USER_ID = WorkspaceUserId.make("nils");

export const WorkspaceUserGithubSettings = Schema.Struct({
  personalAccessToken: TrimmedString.pipe(Schema.withDecodingDefault(Effect.succeed(""))),
  personalAccessTokenRedacted: Schema.optionalKey(Schema.Boolean),
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
