import type { EnvironmentId, WorkflowCatalog } from "@t3tools/contracts";

import { usePrimaryEnvironment } from "./state/environments";
import { useEnvironmentQuery } from "./state/query";
import { serverEnvironment } from "./state/server";

export type WorkflowCatalogState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly catalog: WorkflowCatalog }
  | { readonly status: "error"; readonly message: string };

export function useWorkflowCatalog(
  requestedEnvironmentId?: EnvironmentId | null,
): WorkflowCatalogState {
  const primaryEnvironmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const environmentId = requestedEnvironmentId ?? primaryEnvironmentId;
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.workflowCatalog({ environmentId, input: {} }),
  );
  if (environmentId === null) {
    return { status: "error", message: "No primary server environment is connected." };
  }
  if (query.error !== null) return { status: "error", message: query.error };
  if (query.data !== null) return { status: "loaded", catalog: query.data };
  return { status: "loading" };
}
