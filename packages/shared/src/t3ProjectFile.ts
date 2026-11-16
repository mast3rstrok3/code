import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { T3ProjectFile, T3_PROJECT_FILE_SCHEMA_URL } from "@t3tools/contracts";

import { fromLenientJson } from "./schemaJson.ts";

const DEFAULT_IMPLEMENTATION_VALIDATION_COMMANDS = ["vp check", "vp run typecheck"] as const;

export function resolveImplementationValidationCommands(input: {
  readonly explicitCommands?: ReadonlyArray<string> | undefined;
  readonly projectFile?: T3ProjectFile | null | undefined;
}): ReadonlyArray<string> {
  if (input.explicitCommands !== undefined && input.explicitCommands.length > 0) {
    return input.explicitCommands;
  }
  if (
    input.projectFile?.validationCommands !== undefined &&
    input.projectFile.validationCommands.length > 0
  ) {
    return input.projectFile.validationCommands;
  }
  return DEFAULT_IMPLEMENTATION_VALIDATION_COMMANDS;
}

/**
 * End-to-end test commands App Review runs before each browser review cycle.
 * Opt-in with no defaults: a project without `e2eCommands` reviews in the
 * browser only.
 */
export function resolveAppReviewE2eCommands(
  projectFile: T3ProjectFile | null | undefined,
): ReadonlyArray<string> {
  return projectFile?.e2eCommands ?? [];
}

export const T3ProjectFileFromJson = fromLenientJson(T3ProjectFile);

const decodeT3ProjectFile = Schema.decodeExit(T3ProjectFileFromJson);

export function parseT3ProjectFile(contents: string): T3ProjectFile | null {
  const decoded = decodeT3ProjectFile(contents);
  return Exit.isSuccess(decoded) ? decoded.value : null;
}

export function buildT3ProjectFileJsonSchema(): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(T3ProjectFile, { onExcessProperty: "error" });
  const jsonSchema: Record<string, unknown> = {
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $id: T3_PROJECT_FILE_SCHEMA_URL,
    ...document.schema,
  };
  if (document.definitions && Object.keys(document.definitions).length > 0) {
    jsonSchema.$defs = document.definitions;
  }
  return jsonSchema;
}
