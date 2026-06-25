import { createAppDevStackEnvironmentAtoms } from "@t3tools/client-runtime/state/app-dev-stacks";

import { connectionAtomRuntime } from "../connection/runtime";

export const appDevStackEnvironment = createAppDevStackEnvironmentAtoms(connectionAtomRuntime);
