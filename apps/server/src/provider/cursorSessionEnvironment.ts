// @effect-diagnostics nodeBuiltinImport:off -- The in-process SDK needs a launch hook before its CommonJS shell tools load.
import * as NodeAsyncHooks from "node:async_hooks";
import * as NodeModule from "node:module";
import type * as NodeChildProcess from "node:child_process";
import { withWorkspaceUserEnvironment } from "../workspaceUserCredentials.ts";

const environments = new NodeAsyncHooks.AsyncLocalStorage<NodeJS.ProcessEnv>();
const childProcess = NodeModule.createRequire(import.meta.url)(
  "node:child_process",
) as typeof import("node:child_process");
const originalSpawn = childProcess.spawn;

// Cursor has no local-agent environment option. Only SDK calls in this async
// context override shell credentials; other providers and terminals use spawn unchanged.
childProcess.spawn = ((
  command: string,
  argsOrOptions?: ReadonlyArray<string> | NodeChildProcess.SpawnOptions,
  options?: NodeChildProcess.SpawnOptions,
) => {
  const owner = environments.getStore();
  if (Array.isArray(argsOrOptions)) {
    return originalSpawn(
      command,
      argsOrOptions,
      owner === undefined
        ? (options ?? {})
        : {
            ...options,
            env: withWorkspaceUserEnvironment(options?.env ?? process.env, owner),
          },
    );
  }
  const spawnOptions = argsOrOptions as NodeChildProcess.SpawnOptions | undefined;
  return originalSpawn(
    command,
    [],
    owner === undefined
      ? (spawnOptions ?? {})
      : {
          ...spawnOptions,
          env: withWorkspaceUserEnvironment(spawnOptions?.env ?? process.env, owner),
        },
  );
}) as typeof childProcess.spawn;
NodeModule.syncBuiltinESMExports();

export function withCursorSessionEnvironment<A>(
  environment: NodeJS.ProcessEnv | undefined,
  operation: () => A,
): A {
  return environment === undefined ? operation() : environments.run(environment, operation);
}
