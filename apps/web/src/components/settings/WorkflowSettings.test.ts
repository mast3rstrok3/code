import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav";
import { resolveCatalogFocusId } from "./WorkflowSettings";
import {
  detectCatalogContentKind,
  escapeStandaloneTagLines,
  normalizeFrontmatterBlocks,
  parseCatalogContent,
} from "./workflowCatalogContent";

describe("workflow catalog settings", () => {
  it("publishes separate workflow, skill, and doc navigation entries", () => {
    expect(
      SETTINGS_NAV_ITEMS.filter((item) => ["Workflows", "Skills", "Docs"].includes(item.label)).map(
        (item) => [item.label, item.to],
      ),
    ).toEqual([
      ["Workflows", "/settings/workflows"],
      ["Skills", "/settings/skills"],
      ["Docs", "/settings/docs"],
    ]);
  });

  it("accepts valid catalog deep links and ignores stale IDs", () => {
    expect(resolveCatalogFocusId("tdd", ["grill", "tdd"])).toBe("tdd");
    expect(resolveCatalogFocusId("removed", ["grill", "tdd"])).toBeUndefined();
    expect(resolveCatalogFocusId(undefined, ["grill", "tdd"])).toBeUndefined();
  });
});

describe("catalog content parsing", () => {
  it("detects markdown from structural signals and falls back to text", () => {
    expect(detectCatalogContentKind("# Heading\n\nBody")).toBe("markdown");
    expect(detectCatalogContentKind("- one\n- two")).toBe("markdown");
    expect(detectCatalogContentKind("| a | b |\n| - | - |")).toBe("markdown");
    expect(detectCatalogContentKind("Use `workflow_doc_get` here")).toBe("markdown");
    expect(detectCatalogContentKind("Plain prose with no markup at all.")).toBe("text");
  });

  it("unwraps the prompt envelope tag for the rendered body", () => {
    const parsed = parseCatalogContent(
      "<collaboration_mode># Spec\n\nSynthesize.\n</collaboration_mode>",
    );

    expect(parsed.envelopeTag).toBe("collaboration_mode");
    expect(parsed.kind).toBe("markdown");
    expect(parsed.body).toBe("# Spec\n\nSynthesize.");
  });

  it("keeps unwrapped content intact and reports no envelope", () => {
    const parsed = parseCatalogContent("# ADR Format\n\nADRs live in `docs/adr/`.");

    expect(parsed.envelopeTag).toBeNull();
    expect(parsed.body).toBe("# ADR Format\n\nADRs live in `docs/adr/`.");
  });

  it("fences frontmatter blocks that sit below the heading", () => {
    const normalized = normalizeFrontmatterBlocks(
      "# Planning Workflow: Spec\n\n---\nname: to-spec\ndisable-model-invocation: true\n---\n\nBody.",
    );

    expect(normalized).toBe(
      "# Planning Workflow: Spec\n\n```yaml\nname: to-spec\ndisable-model-invocation: true\n```\n\nBody.",
    );
  });

  it("leaves thematic breaks alone", () => {
    expect(normalizeFrontmatterBlocks("before\n\n---\n\nafter")).toBe("before\n\n---\n\nafter");
  });

  it("escapes standalone template tags so markdown cannot drop them", () => {
    expect(escapeStandaloneTagLines("<spec-template>\n\n## Problem\n\n</spec-template>")).toBe(
      "`<spec-template>`\n\n## Problem\n\n`</spec-template>`",
    );
    // Fenced code already renders verbatim — leave it untouched.
    expect(escapeStandaloneTagLines("```json\n<not-a-tag>\n```")).toBe("```json\n<not-a-tag>\n```");
    // Tags inside prose keep their surrounding text and stay unescaped.
    expect(escapeStandaloneTagLines("As an <actor>, I want")).toBe("As an <actor>, I want");
  });

  it("keeps template tags visible in the parsed body", () => {
    const parsed = parseCatalogContent(
      "<collaboration_mode># Spec\n\n<spec-template>\n\n## Problem Statement\n\n</spec-template>\n</collaboration_mode>",
    );

    expect(parsed.body).toContain("`<spec-template>`");
    expect(parsed.body).toContain("`</spec-template>`");
  });

  it("renders plain text verbatim without frontmatter rewriting", () => {
    const parsed = parseCatalogContent("just some prose\n---\nname: not markdown\n---");

    expect(parsed.kind).toBe("text");
    expect(parsed.body).toContain("---\nname: not markdown");
  });
});
