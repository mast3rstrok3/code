import type { SkillCatalog } from "@t3tools/contracts";

import { usePrimaryEnvironment } from "./state/environments";
import { useEnvironmentQuery } from "./state/query";
import { serverEnvironment } from "./state/server";

export type SkillCatalogState =
  | { readonly status: "loading" }
  | { readonly status: "loaded"; readonly catalog: SkillCatalog }
  | { readonly status: "error"; readonly message: string };

export function useSkillCatalog(): SkillCatalogState {
  const environmentId = usePrimaryEnvironment()?.environmentId ?? null;
  const query = useEnvironmentQuery(
    environmentId === null ? null : serverEnvironment.skillCatalog({ environmentId, input: {} }),
  );
  if (environmentId === null) {
    return { status: "error", message: "No primary server environment is connected." };
  }
  if (query.error !== null) return { status: "error", message: query.error };
  if (query.data !== null) return { status: "loaded", catalog: query.data };
  return { status: "loading" };
}
