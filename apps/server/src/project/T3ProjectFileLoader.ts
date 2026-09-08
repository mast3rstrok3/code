/**
 * T3ProjectFileLoader - Effect service that loads the checked-in `t3.json`
 * project file from a workspace root.
 *
 * `load` logs invalid files and falls back to defaults. `loadStrict` preserves
 * read and decode errors for workflows that require the configuration.
 * Both return `Option.none` when the file is missing.
 *
 * @module T3ProjectFileLoader
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { T3_PROJECT_FILE_NAME, type T3ProjectFile } from "@t3tools/contracts";
import { T3ProjectFileFromJson } from "@t3tools/shared/t3ProjectFile";

const decodeT3ProjectFileJson = Schema.decodeEffect(T3ProjectFileFromJson);

export class T3ProjectFileLoadError extends Schema.TaggedErrorClass<T3ProjectFileLoadError>()(
  "T3ProjectFileLoadError",
  {
    operation: Schema.Literals(["read", "decode"]),
    workspaceRoot: Schema.String,
    filePath: Schema.String,
    cause: Schema.Defect(),
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Failed to ${this.operation} ${T3_PROJECT_FILE_NAME} at ${this.filePath}.\n${this.detail}`;
  }
}

/** Service tag for t3.json project file loading. */
export class T3ProjectFileLoader extends Context.Service<
  T3ProjectFileLoader,
  {
    /**
     * Load and decode `t3.json` at the workspace root.
     *
     * Never fails: missing, unreadable, or invalid files resolve to
     * `Option.none` (invalid files are logged as warnings).
     */
    readonly load: (workspaceRoot: string) => Effect.Effect<Option.Option<T3ProjectFile>>;
    /** Required workflow configuration preserves read and decode errors. */
    readonly loadStrict: (
      workspaceRoot: string,
    ) => Effect.Effect<Option.Option<T3ProjectFile>, T3ProjectFileLoadError>;
  }
>()("t3/project/T3ProjectFileLoader") {}

const logT3ProjectFileLoadError = (error: T3ProjectFileLoadError) =>
  Effect.logWarning(error.message).pipe(
    Effect.annotateLogs({
      operation: error.operation,
      workspaceRoot: error.workspaceRoot,
      filePath: error.filePath,
      errorTag: error._tag,
    }),
  );

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const loadStrict: T3ProjectFileLoader["Service"]["loadStrict"] = Effect.fn(
    "T3ProjectFileLoader.loadStrict",
  )(function* (workspaceRoot) {
    const filePath = path.join(workspaceRoot, T3_PROJECT_FILE_NAME);
    const raw = yield* fileSystem.readFileString(filePath).pipe(
      Effect.map(Option.some),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound"
            ? Effect.succeed(Option.none<string>())
            : Effect.fail(
                new T3ProjectFileLoadError({
                  operation: "read",
                  workspaceRoot,
                  filePath,
                  cause: error,
                  detail: error.message,
                }),
              ),
      }),
    );
    if (Option.isNone(raw)) return Option.none<T3ProjectFile>();
    return yield* decodeT3ProjectFileJson(raw.value).pipe(
      Effect.map(Option.some),
      Effect.mapError(
        (error) =>
          new T3ProjectFileLoadError({
            operation: "decode",
            workspaceRoot,
            filePath,
            cause: error,
            detail: error.message,
          }),
      ),
    );
  });
  const load: T3ProjectFileLoader["Service"]["load"] = (workspaceRoot) =>
    loadStrict(workspaceRoot).pipe(
      Effect.catchTag("T3ProjectFileLoadError", (error) =>
        logT3ProjectFileLoadError(error).pipe(Effect.as(Option.none<T3ProjectFile>())),
      ),
    );

  return T3ProjectFileLoader.of({ load, loadStrict });
});

export const layer = Layer.effect(T3ProjectFileLoader, make);
