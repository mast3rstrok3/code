import type { BundledSkill, SkillCatalog, SkillDoc } from "@t3tools/contracts";
import { appendSkillAdditions } from "@t3tools/shared/serverSettings";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { parse as parseYaml } from "yaml";

export class SkillsPluginLoadError extends Schema.TaggedError<SkillsPluginLoadError>()(
  "SkillsPluginLoadError",
  {
    path: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Could not load the bundled skills plugin file ${this.path}.`;
  }
}

/** The bundled plugin as read from disk: its catalog and every file it ships. */
export interface SkillsPluginSource {
  readonly catalog: SkillCatalog;
  /** File contents keyed by `/`-separated path relative to the plugin root. */
  readonly files: ReadonlyMap<string, string>;
}

const PluginManifest = Schema.fromJsonString(
  Schema.Struct({ name: Schema.NonEmptyString, skills: Schema.Array(Schema.String) }),
);

const SkillFrontmatter = Schema.Struct({
  name: Schema.NonEmptyString,
  description: Schema.NonEmptyString,
  "disable-model-invocation": Schema.optional(Schema.Boolean),
});

const decodeManifest = Schema.decodeEffect(PluginManifest);
const decodeFrontmatter = Schema.decodeUnknownEffect(SkillFrontmatter);

const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;
const MANIFEST_PATH = ".claude-plugin/plugin.json";

export const skillFilePath = (skillName: string) => `skills/${skillName}/SKILL.md`;

// Untraced: one call per plugin file, under the load span.
const listFiles = Effect.fnUntraced(function* (
  root: string,
  relative: string,
): Effect.fn.Return<
  ReadonlyArray<string>,
  SkillsPluginLoadError,
  FileSystem.FileSystem | Path.Path
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const fail = (cause: unknown) => new SkillsPluginLoadError({ path: relative || ".", cause });
  const names = yield* fileSystem
    .readDirectory(relative ? path.join(root, relative) : root)
    .pipe(Effect.mapError(fail));
  const files: string[] = [];
  for (const name of names.toSorted()) {
    const child = relative ? `${relative}/${name}` : name;
    const info = yield* fileSystem.stat(path.join(root, child)).pipe(Effect.mapError(fail));
    if (info.type === "Directory") files.push(...(yield* listFiles(root, child)));
    else files.push(child);
  }
  return files;
});

function firstParagraph(markdown: string): string | undefined {
  return markdown
    .replace(/```[\s\S]*?```/g, "")
    .split(/\r?\n\s*\r?\n/)
    .map((block) =>
      block
        .replace(/^#+\s+.*$/gm, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .find((block) => block.length >= 20);
}

function describeDoc(skill: string, path: string, content: string) {
  const heading = /^#[ \t]+(.+)$/m.exec(content)?.[1]?.trim();
  // A script's leading `# ...` comment describes it; a Markdown file's describes its title.
  if (!path.endsWith(".md")) {
    return {
      title: path,
      description: heading ?? `Supporting file for the ${skill} skill.`,
    };
  }
  const paragraph = firstParagraph(content);
  return {
    title: heading ?? path,
    description:
      paragraph === undefined
        ? `Supporting file for the ${skill} skill.`
        : paragraph.length > 240
          ? `${paragraph.slice(0, 237).trimEnd()}…`
          : paragraph,
  };
}

/** Reads a Claude Code plugin whose manifest lists each skill as `./skills/<name>`. */
export const loadSkillsPlugin = Effect.fn("SkillCatalog.load")(function* (pluginDirectory: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files = new Map<string, string>();
  for (const file of yield* listFiles(pluginDirectory, "")) {
    files.set(
      file,
      yield* fileSystem
        .readFileString(path.join(pluginDirectory, file))
        .pipe(Effect.mapError((cause) => new SkillsPluginLoadError({ path: file, cause }))),
    );
  }

  const manifest = yield* decodeManifest(files.get(MANIFEST_PATH) ?? "").pipe(
    Effect.mapError((cause) => new SkillsPluginLoadError({ path: MANIFEST_PATH, cause })),
  );

  const skills: BundledSkill[] = [];
  const docs: SkillDoc[] = [];
  for (const entry of manifest.skills) {
    const name = /^\.\/skills\/([\w-]+)$/.exec(entry)?.[1];
    const content = name === undefined ? undefined : files.get(skillFilePath(name));
    if (name === undefined || content === undefined) {
      return yield* new SkillsPluginLoadError({ path: entry });
    }
    const frontmatter = yield* Effect.try({
      try: () => parseYaml(FRONTMATTER_PATTERN.exec(content)?.[1] ?? "") as unknown,
      catch: (cause) => new SkillsPluginLoadError({ path: skillFilePath(name), cause }),
    }).pipe(
      Effect.flatMap(decodeFrontmatter),
      Effect.mapError((cause) => new SkillsPluginLoadError({ path: skillFilePath(name), cause })),
    );
    // Claude Code names a plugin's folder skill after its folder.
    if (frontmatter.name !== name) {
      return yield* new SkillsPluginLoadError({ path: skillFilePath(name) });
    }

    const folder = `skills/${name}/`;
    const skillDocs = [...files]
      .filter(([file]) => file.startsWith(folder) && file !== skillFilePath(name))
      .flatMap(([file, text]): SkillDoc[] => {
        const docPath = file.slice(folder.length);
        const trimmed = text.trim();
        if (!trimmed) return [];
        return [
          {
            id: `${name}/${docPath}`,
            skill: name,
            path: docPath,
            ...describeDoc(name, docPath, trimmed),
            content: trimmed,
          },
        ];
      });
    docs.push(...skillDocs);
    skills.push({
      name,
      description: frontmatter.description,
      userInvocationOnly: frontmatter["disable-model-invocation"] === true,
      content: content.trim(),
      docIds: skillDocs.map((doc) => doc.id),
    });
  }

  return {
    catalog: {
      pluginName: manifest.name,
      skills: skills.toSorted((left, right) => left.name.localeCompare(right.name)),
      docs,
    },
    files,
  } satisfies SkillsPluginSource;
});

/** The plugin's files with each skill's saved additions appended to its SKILL.md. */
export function renderSkillsPlugin(
  source: SkillsPluginSource,
  additions: Readonly<Record<string, string>>,
): ReadonlyMap<string, string> {
  const rendered = new Map(source.files);
  for (const skill of source.catalog.skills) {
    const file = skillFilePath(skill.name);
    rendered.set(file, appendSkillAdditions(source.files.get(file) ?? "", skill.name, additions));
  }
  return rendered;
}
