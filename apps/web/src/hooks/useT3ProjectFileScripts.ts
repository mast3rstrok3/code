import {
  EnvironmentId,
  T3_PROJECT_FILE_NAME,
  type T3ProjectFile,
  type T3ProjectFileScript,
} from "@t3tools/contracts";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { useMemo } from "react";

import { useProjectFileQuery } from "~/components/files/projectFilesQueryState";

const decodeT3ProjectFile = Schema.decodeExit(T3ProjectFileFromJson);

const NO_SCRIPTS: ReadonlyArray<T3ProjectFileScript> = [];
const EMPTY_ENVIRONMENT_ID = EnvironmentId.make("t3-project-file-disabled");

export function useT3ProjectFile(
  environmentId: EnvironmentId | null,
  cwd: string | null,
): T3ProjectFile | null {
  const enabled = environmentId !== null && cwd !== null;
  const query = useProjectFileQuery(
    environmentId ?? EMPTY_ENVIRONMENT_ID,
    cwd ?? "",
    T3_PROJECT_FILE_NAME,
    enabled,
  );
  const contents = query.data && !query.data.truncated ? query.data.contents : null;
  return useMemo(() => {
    if (contents === null) return null;
    const decoded = decodeT3ProjectFile(contents);
    return Exit.isFailure(decoded) ? null : decoded.value;
  }, [contents]);
}

/**
 * Scripts declared in the project's checked-in `t3.json`, offered in the
 * scripts menu for import. Missing, truncated, or invalid files resolve to
 * an empty list.
 */
export function useT3ProjectFileScripts(
  environmentId: EnvironmentId,
  cwd: string | null,
): ReadonlyArray<T3ProjectFileScript> {
  return useT3ProjectFile(environmentId, cwd)?.scripts ?? NO_SCRIPTS;
}
