import { createAppReviewEnvironmentAtoms } from "@t3tools/client-runtime/state/app-review";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

const appReviewEnvironment = createAppReviewEnvironmentAtoms(connectionAtomRuntime);

/** The thread's App Reviews, oldest first, live while the caller is mounted. */
export function useThreadAppReviews(environmentId: EnvironmentId, threadId: ThreadId) {
  return useEnvironmentQuery(appReviewEnvironment.thread({ environmentId, input: { threadId } }));
}
