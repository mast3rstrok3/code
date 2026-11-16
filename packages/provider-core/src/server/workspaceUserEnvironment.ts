import * as Context from "effect/Context";

/**
 * The thread owner's credentials and tools, provided by the server for one provider launch.
 * Never persist this value in a session or event.
 */
export const WorkspaceUserEnvironment = Context.Reference<NodeJS.ProcessEnv>(
  "t3/WorkspaceUserEnvironment",
  { defaultValue: () => ({}) },
);

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
