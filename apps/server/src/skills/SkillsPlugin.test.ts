import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";
import * as ServerSettings from "../serverSettings.ts";
import { loadSkillsPlugin, skillFilePath } from "./SkillCatalog.ts";
import * as SkillsPlugin from "./SkillsPlugin.ts";

const bundledDirectory = Effect.map(Path.Path, (path) => path.join(import.meta.dirname, "plugin"));

it.layer(
  ServerConfig.layerTest(process.cwd(), { prefix: "t3-skills-plugin-" }).pipe(
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ),
)("SkillsPlugin", (it) => {
  it.effect("catalogs every skill folder of the bundled plugin", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const directory = yield* bundledDirectory;
      const { catalog } = yield* loadSkillsPlugin(directory);

      assert.equal(catalog.pluginName, "t3");
      assert.deepEqual(
        catalog.skills.map((skill) => skill.name),
        (yield* fileSystem.readDirectory(path.join(directory, "skills"))).toSorted(),
      );
      const skill = (name: string) => catalog.skills.find((candidate) => candidate.name === name);
      assert.isTrue(skill("to-spec")?.userInvocationOnly);
      assert.isFalse(skill("tdd")?.userInvocationOnly);
      assert.includeMembers([...(skill("tdd")?.docIds ?? [])], ["tdd/tests.md", "tdd/mocking.md"]);
      assert.deepEqual(skill("workflow")?.docIds, ["workflow/resolving-merge-conflicts.md"]);
      assert.deepInclude(catalog.docs.find((doc) => doc.id === "tdd/tests.md") ?? {}, {
        skill: "tdd",
        path: "tests.md",
        title: "Good and Bad Tests",
      });
      assert.deepInclude(catalog.docs.find((doc) => doc.id === "wizard/template.sh") ?? {}, {
        title: "template.sh",
        description: "A wizard walks a human through a manual procedure, step by step.",
      });
    }),
  );

  it.effect("writes each set of additions to its own plugin copy", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const source = yield* loadSkillsPlugin(yield* bundledDirectory);
      const root = path.join(yield* fileSystem.makeTempDirectoryScoped(), "skills-plugin");
      const readTdd = (directory: string) =>
        fileSystem.readFileString(path.join(directory, ...skillFilePath("tdd").split("/")));

      const plain = yield* SkillsPlugin.materializeSkillsPlugin(root, source, {});
      assert.equal(yield* readTdd(plain), source.files.get(skillFilePath("tdd")));
      assert.isTrue(yield* fileSystem.exists(path.join(plain, ".claude-plugin", "plugin.json")));

      const legacy = yield* SkillsPlugin.materializeSkillsPlugin(root, source, {
        "matt-pocock.tdd": "Use fixtures.",
      });
      assert.notEqual(legacy, plain);
      assert.include(yield* readTdd(legacy), "<user-skill-additions>\nUse fixtures.\n");
      assert.equal(yield* readTdd(plain), source.files.get(skillFilePath("tdd")));

      const renamed = yield* SkillsPlugin.materializeSkillsPlugin(root, source, {
        tdd: "Use fixtures.",
      });
      assert.equal(renamed, legacy);
      assert.deepEqual(
        (yield* fileSystem.readDirectory(root)).toSorted(),
        [path.basename(plain), path.basename(legacy)].toSorted(),
      );
    }),
  );

  it.effect("starts from the saved additions and prunes older copies", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const config = yield* ServerConfig.ServerConfig;
      const stale = path.join(config.stateDir, "skills-plugin", "stale");
      yield* fileSystem.makeDirectory(stale, { recursive: true });

      const directory = yield* Effect.flatMap(
        SkillsPlugin.SkillsPlugin,
        (plugin) => plugin.directory,
      ).pipe(
        Effect.provide(
          SkillsPlugin.layer.pipe(
            Layer.provide(
              ServerSettings.ServerSettingsService.layerTest({
                workflowStepInstructions: { tdd: "Use fixtures." },
              }),
            ),
          ),
        ),
      );

      assert.equal(path.dirname(directory!), path.join(config.stateDir, "skills-plugin"));
      assert.include(
        yield* fileSystem.readFileString(path.join(directory!, "skills", "tdd", "SKILL.md")),
        "Use fixtures.",
      );
      assert.isFalse(yield* fileSystem.exists(stale));
    }),
  );
});
