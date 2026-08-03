/**
 * Catalog prompt and document bodies are authored as Markdown, but they ship as
 * raw model input: skill prompts arrive wrapped in an envelope tag and some
 * carry a YAML frontmatter block partway down. These helpers turn that raw text
 * into something readable without hiding anything — the raw view still shows the
 * exact text the model receives.
 */

export type CatalogContentKind = "markdown" | "text";

export interface ParsedCatalogContent {
  readonly kind: CatalogContentKind;
  /** Envelope tag stripped from the rendered body, e.g. `collaboration_mode`. */
  readonly envelopeTag: string | null;
  /** Body to render. Identical to the input when there is nothing to unwrap. */
  readonly body: string;
}

const ENVELOPE_PATTERN = /^<([a-z][a-z0-9_-]*)>\n?([\s\S]*?)\n?<\/\1>$/i;
const FRONTMATTER_BLOCK_PATTERN = /(^|\n)---\n((?:[A-Za-z][\w-]*:[^\n]*\n)+)---(?=\n|$)/g;
const FENCE_LINE_PATTERN = /^\s*(?:```|~~~)/;
const STANDALONE_TAG_LINE_PATTERN = /^(\s*)(<\/?[A-Za-z][\w-]*\s*\/?>)(\s*)$/;

const MARKDOWN_SIGNALS = [
  /^#{1,6}\s\S/m, // ATX heading
  /^```/m, // fenced code
  /^\s*[-*+]\s+\S/m, // bullet list
  /^\s*\d+[.)]\s+\S/m, // ordered list
  /^\s*>\s+\S/m, // blockquote
  /^\|.*\|\s*$/m, // table row
  /\[[^\]\n]+\]\([^)\n]+\)/, // link
  /\*\*[^*\n]+\*\*/, // bold
  /`[^`\n]+`/, // inline code
] as const;

/**
 * Markdown when the text carries any structural Markdown signal. Anything else
 * — plain prose, config dumps, unknown formats — reads better verbatim.
 */
export function detectCatalogContentKind(text: string): CatalogContentKind {
  return MARKDOWN_SIGNALS.some((pattern) => pattern.test(text)) ? "markdown" : "text";
}

/**
 * Rewrites YAML frontmatter blocks into fenced `yaml` so they render as one
 * metadata block instead of a horizontal rule followed by a run-on paragraph.
 * Skill prompts put this block below their heading, so it is matched anywhere.
 */
export function normalizeFrontmatterBlocks(text: string): string {
  return text.replace(
    FRONTMATTER_BLOCK_PATTERN,
    (_match, leading: string, yaml: string) => `${leading}\`\`\`yaml\n${yaml}\`\`\``,
  );
}

/**
 * Prompts delimit templates with standalone XML-ish tags (`<spec-template>`).
 * Markdown treats those as raw HTML and drops them, silently losing structure
 * the reader needs — so escape them to render literally. Fenced code is left
 * alone; it already renders verbatim.
 */
export function escapeStandaloneTagLines(text: string): string {
  let insideFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (FENCE_LINE_PATTERN.test(line)) {
        insideFence = !insideFence;
        return line;
      }
      if (insideFence) return line;
      const match = STANDALONE_TAG_LINE_PATTERN.exec(line);
      return match ? `${match[1]}\`${match[2]}\`${match[3]}` : line;
    })
    .join("\n");
}

export function parseCatalogContent(raw: string): ParsedCatalogContent {
  const trimmed = raw.trim();
  const envelope = ENVELOPE_PATTERN.exec(trimmed);
  const unwrapped = envelope?.[2] ?? trimmed;
  const kind = detectCatalogContentKind(unwrapped);
  return {
    kind,
    envelopeTag: envelope?.[1] ?? null,
    body:
      kind === "markdown"
        ? escapeStandaloneTagLines(normalizeFrontmatterBlocks(unwrapped))
        : unwrapped,
  };
}
