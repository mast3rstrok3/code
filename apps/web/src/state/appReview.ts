import { createAppReviewEnvironmentAtoms } from "@t3tools/client-runtime/state/app-review";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { connectionAtomRuntime } from "../connection/runtime";
import { useEnvironmentQuery } from "./query";

const appReviewEnvironment = createAppReviewEnvironmentAtoms(connectionAtomRuntime);

/** The thread's App Reviews, oldest first, live while the caller is mounted. */
export function useThreadAppReviews(ref: ScopedThreadRef | null) {
  return useEnvironmentQuery(
    ref === null
      ? null
      : appReviewEnvironment.thread({
          environmentId: ref.environmentId,
          input: { threadId: ref.threadId },
        }),
  );
}
