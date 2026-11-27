import type { SkillCatalog as SkillCatalogContract } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Equal from "effect/Equal";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { loadSkillsPlugin, renderSkillsPlugin, type SkillsPluginSource } from "./SkillCatalog.ts";

export class SkillsPluginWriteError extends Schema.TaggedError<SkillsPluginWriteError>()(
  "SkillsPluginWriteError",
  {
    directory: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Could not write the skills plugin to ${this.directory}.`;
  }
}

/**
 * The Claude Code plugin T3 Code ships. Claude cannot read a bundle inside the desktop app's asar
 * archive, so sessions load a copy in the state directory with the user's additions applied.
 */
export class SkillsPlugin extends Context.Service<
  SkillsPlugin,
  {
    readonly catalog: SkillCatalogContract;
    /** The plugin directory new Claude sessions load; undefined when the bundle failed to load. */
    readonly directory: Effect.Effect<string | undefined>;
  }
>()("t3/skills/SkillsPlugin") {}

/** `dist/skills/plugin` beside the bundled server, else `src/skills/plugin` beside this module. */
const resolveBundledDirectory = Effect.fn("SkillsPlugin.resolveBundledDirectory")(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  for (const candidate of [
    path.join(import.meta.dirname, "skills", "plugin"),
    path.join(import.meta.dirname, "plugin"),
  ]) {
    const exists = yield* fileSystem
      .exists(path.join(candidate, ".claude-plugin", "plugin.json"))
      .pipe(Effect.orElseSucceed(() => false));
    if (exists) return candidate;
  }
  return path.join(import.meta.dirname, "plugin");
});

/**
 * Writes the rendered plugin to `<root>/<content hash>` through a temporary sibling and a rename,
 * so a Claude session never sees a half-written plugin and unchanged content reuses its folder.
 */
export const materializeSkillsPlugin = Effect.fn("SkillsPlugin.materialize")(function* (
  root: string,
  source: SkillsPluginSource,
  additions: Readonly<Record<string, string>>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const digest = yield* Digest.Digest;
  const files = [...renderSkillsPlugin(source, additions)].toSorted(([left], [right]) =>
    left.localeCompare(right),
  );
  const fingerprint = files
    .flatMap(([file, content]) => [file, String(content.length), content])
    .join("\0");
  const hash = yield* digest
    .digest(Digest.sha256, new TextEncoder().encode(fingerprint))
    .pipe(Effect.orDie);
  const directory = path.join(root, Hex.encode(hash).slice(0, 16));
  const write = Effect.gen(function* () {
    if (yield* fileSystem.exists(directory)) return;
    yield* fileSystem.makeDirectory(root, { recursive: true });
    const staging = yield* fileSystem.makeTempDirectory({ directory: root, prefix: ".staging-" });
    for (const [file, content] of files) {
      const target = path.join(staging, ...file.split("/"));
      yield* fileSystem.makeDirectory(path.dirname(target), { recursive: true });
      yield* fileSystem.writeFileString(target, content);
    }
    // A concurrent writer may have renamed identical content into place first.
    yield* fileSystem.rename(staging, directory).pipe(
      Effect.catch((cause) =>
        fileSystem.exists(directory).pipe(
          Effect.flatMap((exists) => (exists ? Effect.void : Effect.fail(cause))),
          Effect.ensuring(fileSystem.remove(staging, { recursive: true }).pipe(Effect.ignore)),
        ),
      ),
    );
  });
  yield* write.pipe(Effect.mapError((cause) => new SkillsPluginWriteError({ directory, cause })));
  return directory;
});

/** Removes every materialized plugin except `keep`, at startup before any session loads one. */
const pruneMaterialized = Effect.fn("SkillsPlugin.prune")(function* (root: string, keep: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const entries = yield* fileSystem
    .readDirectory(root)
    .pipe(Effect.orElseSucceed((): ReadonlyArray<string> => []));
  yield* Effect.forEach(
    entries.filter((entry) => path.join(root, entry) !== keep),
    (entry) => fileSystem.remove(path.join(root, entry), { recursive: true }).pipe(Effect.ignore),
    { discard: true },
  );
});

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const bundled = yield* resolveBundledDirectory();
  const loaded = yield* loadSkillsPlugin(bundled).pipe(
    Effect.tapError((error) => Effect.logError(error.message, { bundled })),
    Effect.option,
  );
  if (Option.isNone(loaded)) {
    return SkillsPlugin.of({
      catalog: { pluginName: "t3", skills: [], docs: [] },
      directory: Effect.undefined,
    });
  }
  const source = loaded.value;
  const root = path.join(config.stateDir, "skills-plugin");
  const materialize = (additions: Readonly<Record<string, string>>) =>
    materializeSkillsPlugin(root, source, additions).pipe(
      Effect.tapError((error) => Effect.logWarning(error.message)),
      Effect.option,
      Effect.map(Option.getOrUndefined),
    );

  const changes = yield* settings.subscribeChanges;
  let additions = yield* settings.getSettings.pipe(
    Effect.map((current) => current.workflowStepInstructions),
    Effect.orElseSucceed((): Readonly<Record<string, string>> => ({})),
  );
  const initial = yield* materialize(additions);
  if (initial !== undefined) yield* pruneMaterialized(root, initial);
  const current = yield* Ref.make(initial);

  yield* changes.pipe(
    Stream.runForEach((next) => {
      if (Equal.equals(next.workflowStepInstructions, additions)) return Effect.void;
      additions = next.workflowStepInstructions;
      // A failed write keeps the previous plugin rather than dropping the skills.
      return materialize(additions).pipe(
        Effect.flatMap((directory) =>
          directory === undefined ? Effect.void : Ref.set(current, directory),
        ),
      );
    }),
    Effect.forkScoped,
  );

  return SkillsPlugin.of({ catalog: source.catalog, directory: Ref.get(current) });
});

export const layer = Layer.effect(SkillsPlugin, make);
