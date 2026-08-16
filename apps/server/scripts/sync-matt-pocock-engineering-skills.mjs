import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { parse as parseYaml } from "yaml";

const REPOSITORY = "mattpocock/skills";
const ENGINEERING_ROOT = "skills/engineering";
const OUTPUT_PATH = NodePath.resolve(
  NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)),
  "../src/provider/mattPocockEngineeringSkills.generated.json",
);
const FRONTMATTER_PATTERN = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/;

function titleCase(value) {
  return value
    .replace(/\.[^.]+$/, "")
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

function firstSummary(markdown, fallback) {
  const body = markdown
    .replace(FRONTMATTER_PATTERN, "")
    .replace(/```[\s\S]*?```/g, "")
    .trim();
  const paragraphs = body.split(/\r?\n\s*\r?\n/);
  for (const paragraph of paragraphs) {
    const trimmed = paragraph.trim();
    if (trimmed.startsWith("```") || trimmed.startsWith("#!")) continue;
    const normalized = paragraph
      .replace(/^#+\s+.*$/gm, "")
      .replace(/^[-*]\s+/gm, "")
      .replace(/[`*_]/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (normalized.length >= 20) {
      return normalized.length > 240 ? `${normalized.slice(0, 237).trimEnd()}…` : normalized;
    }
  }
  return fallback;
}

async function githubJson(path) {
  const response = await fetch(`https://api.github.com/repos/${REPOSITORY}/${path}`, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "t3-code-skill-sync" },
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${path}`);
  return response.json();
}

async function rawText(commit, path) {
  const response = await fetch(`https://raw.githubusercontent.com/${REPOSITORY}/${commit}/${path}`);
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}: ${path}`);
  return response.text();
}

const commit = await githubJson("commits/main");
const tree = await githubJson(`git/trees/${commit.sha}?recursive=1`);
const files = tree.tree
  .filter((entry) => entry.type === "blob" && entry.path.startsWith(`${ENGINEERING_ROOT}/`))
  .map((entry) => entry.path)
  .sort();
const skillNames = files
  .filter((path) => path.endsWith("/SKILL.md"))
  .map((path) => path.split("/").at(-2))
  .filter(Boolean)
  .sort((left, right) => left.localeCompare(right));

const skills = [];
for (const name of skillNames) {
  const root = `${ENGINEERING_ROOT}/${name}`;
  const skillPath = `${root}/SKILL.md`;
  const promptText = await rawText(commit.sha, skillPath);
  const frontmatterMatch = FRONTMATTER_PATTERN.exec(promptText);
  const frontmatter = frontmatterMatch ? parseYaml(frontmatterMatch[1]) : {};
  const openAiPath = `${root}/agents/openai.yaml`;
  const openAi = files.includes(openAiPath) ? parseYaml(await rawText(commit.sha, openAiPath)) : {};
  const supportingPaths = files.filter(
    (path) => path.startsWith(`${root}/`) && path !== skillPath && !path.includes("/agents/"),
  );
  const docs = [];
  for (const path of supportingPaths) {
    const content = await rawText(commit.sha, path);
    const relativePath = path.slice(root.length + 1);
    const heading = relativePath.toLowerCase().endsWith(".md")
      ? /^#\s+(.+)$/m.exec(content)?.[1]?.trim()
      : undefined;
    docs.push({
      id: `matt-pocock.${name}.${relativePath
        .toLowerCase()
        .replace(/\.[^.]+$/, "")
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-|-$/g, "")}`,
      title: heading || titleCase(relativePath),
      path: relativePath,
      description: relativePath.toLowerCase().endsWith(".md")
        ? firstSummary(content, `Supporting reference for ${titleCase(name)}.`)
        : `Supporting ${relativePath.split(".").at(-1)?.toUpperCase()} template for ${titleCase(name)}.`,
      content,
    });
  }
  const displayName = openAi?.interface?.display_name || titleCase(name);
  const description =
    openAi?.interface?.short_description ||
    frontmatter?.description ||
    firstSummary(promptText, `${displayName} engineering skill.`);
  skills.push({
    id: `matt-pocock.${name}`,
    name,
    title: displayName,
    description,
    invocation: frontmatter?.["disable-model-invocation"] === true ? "user" : "user-or-model",
    sourcePath: skillPath,
    promptText,
    docs,
  });
}

const output = {
  source: {
    repository: REPOSITORY,
    commit: commit.sha,
    committedAt: commit.commit.committer.date,
    url: `https://github.com/${REPOSITORY}/tree/${commit.sha}/${ENGINEERING_ROOT}`,
  },
  skills,
};

await NodeFSP.writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, "utf8");
console.log(`Wrote ${skills.length} engineering skills from ${commit.sha} to ${OUTPUT_PATH}`);
