import { CodeIcon, TextIcon } from "lucide-react";
import { T, useGT, Var } from "gt-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { parseCatalogContent } from "./catalogContentParsing";

const RAW_CLASS_NAME =
  "mb-4 overflow-auto rounded-lg border border-border/70 bg-muted/35 p-3 text-2xs leading-relaxed whitespace-pre-wrap";

/**
 * Renders a skill or supporting file. Markdown is rendered for reading;
 * anything else falls back to verbatim text. The raw view always shows the
 * exact text the model receives, envelope tag and all.
 */
export function SkillMarkdown({
  text,
  label,
  maxHeightClassName,
}: {
  text: string;
  label: string;
  maxHeightClassName: string;
}) {
  const gt = useGT();
  const parsed = parseCatalogContent(text);
  const [showRaw, setShowRaw] = useState(false);
  const rendered = parsed.kind === "markdown" && !showRaw;

  return (
    <div className="mb-4 space-y-2">
      {parsed.kind === "markdown" ? (
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="ghost"
            size="xs"
            onClick={() => setShowRaw((value) => !value)}
            aria-pressed={showRaw}
          >
            {showRaw ? <TextIcon /> : <CodeIcon />}
            {showRaw ? gt("Show formatted") : gt("Show raw")}
          </Button>
          {parsed.envelopeTag && !showRaw ? (
            <span className="text-2xs text-muted-foreground">
              <T>
                Wrapped in{" "}
                <code className="font-mono">
                  <Var>{`<${parsed.envelopeTag}>`}</Var>
                </code>{" "}
                when sent to the agent
              </T>
            </span>
          ) : null}
        </div>
      ) : null}
      {rendered ? (
        <div
          className={cn(
            "overflow-auto rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs leading-relaxed text-foreground/85",
            maxHeightClassName,
          )}
          aria-label={label}
        >
          <ChatMarkdown text={parsed.body} cwd={undefined} parseRawHtml={false} />
        </div>
      ) : (
        <pre className={cn(RAW_CLASS_NAME, maxHeightClassName)} aria-label={label}>
          <code>{text}</code>
        </pre>
      )}
    </div>
  );
}
