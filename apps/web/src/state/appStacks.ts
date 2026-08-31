import { createAppStackEnvironmentAtoms } from "@t3tools/client-runtime/state/app-stacks";

import { connectionAtomRuntime } from "../connection/runtime";

export const appStackEnvironment = createAppStackEnvironmentAtoms(connectionAtomRuntime);
