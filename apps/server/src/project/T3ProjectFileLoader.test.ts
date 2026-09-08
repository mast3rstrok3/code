import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import * as T3ProjectFileLoader from "./T3ProjectFileLoader.ts";

const TestLayer = Layer.empty.pipe(
  Layer.provideMerge(T3ProjectFileLoader.layer),
  Layer.provideMerge(NodeServices.layer),
);

const makeTempDir = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.makeTempDirectoryScoped({
    prefix: "t3code-project-file-",
  });
});

const writeProjectFile = Effect.fn("writeProjectFile")(function* (cwd: string, contents: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  yield* fileSystem.writeFileString(path.join(cwd, "t3.json"), contents).pipe(Effect.orDie);
});

it.layer(TestLayer)("T3ProjectFileLoader", (it) => {
  describe("loadStrict", () => {
    it.effect("distinguishes a missing file from malformed JSON", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        expect(Option.isNone(yield* loader.loadStrict(cwd))).toBe(true);
        yield* writeProjectFile(cwd, "{ not json");
        const error = yield* loader.loadStrict(cwd).pipe(Effect.flip);
        expect(error.operation).toBe("decode");
        expect(error.message).toContain(`${cwd}/t3.json`);
        expect(error.detail.length).toBeGreaterThan(0);
      }),
    );

    it.effect("reports the invalid field and reloads corrected configuration", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, '{ "e2eCommands": [42] }');
        const error = yield* loader.loadStrict(cwd).pipe(Effect.flip);
        expect(error.operation).toBe("decode");
        expect(error.detail).toContain("e2eCommands");
        expect(error.detail).toContain("Expected string");
        yield* writeProjectFile(cwd, '{ "e2eCommands": ["pnpm test:e2e"] }');
        expect(yield* loader.loadStrict(cwd)).toEqual(
          Option.some({ e2eCommands: ["pnpm test:e2e"] }),
        );
      }),
    );

    it.effect("preserves read errors instead of reporting absent commands", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(`${cwd}/t3.json`);
        const error = yield* loader.loadStrict(cwd).pipe(Effect.flip);
        expect(error.operation).toBe("read");
        expect(error.filePath).toBe(`${cwd}/t3.json`);
        expect(error.detail.length).toBeGreaterThan(0);
      }),
    );
  });

  describe("load", () => {
    it.effect("loads and decodes a valid t3.json", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(
          cwd,
          `{
            // JSONC is tolerated
            "iconPath": "assets/logo.svg",
            "validationCommands": ["pnpm check:full"],
            "scripts": [{ "name": "Dev", "command": "pnpm dev" }],
          }`,
        );

        const loaded = yield* loader.load(cwd);

        expect(Option.isSome(loaded)).toBe(true);
        if (Option.isSome(loaded)) {
          expect(loaded.value.iconPath).toBe("assets/logo.svg");
          expect(loaded.value.validationCommands).toEqual(["pnpm check:full"]);
          expect(loaded.value.scripts).toEqual([{ name: "Dev", command: "pnpm dev" }]);
        }
      }),
    );

    it.effect("returns none when t3.json is missing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("returns none for malformed JSON without failing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, "{ not json");

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );

    it.effect("returns none for schema-invalid files without failing", () =>
      Effect.gen(function* () {
        const loader = yield* T3ProjectFileLoader.T3ProjectFileLoader;
        const cwd = yield* makeTempDir;
        yield* writeProjectFile(cwd, '{ "scripts": [{ "name": "Dev" }] }');

        const loaded = yield* loader.load(cwd);

        expect(Option.isNone(loaded)).toBe(true);
      }),
    );
  });
});
