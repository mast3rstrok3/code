import { CodeIcon, TextIcon } from "lucide-react";
import { useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { parseCatalogContent } from "./workflowCatalogContent";

const RAW_CLASS_NAME =
  "mb-4 overflow-auto rounded-lg border border-border/70 bg-muted/35 p-3 text-[11px] leading-relaxed whitespace-pre-wrap";

/**
 * Renders a catalog prompt or document body. Markdown is rendered for reading;
 * anything else falls back to verbatim text. The raw view always shows the
 * exact text the model receives, envelope tag and all.
 */
export function WorkflowCatalogContent({
  text,
  label,
  maxHeightClassName,
}: {
  text: string;
  label: string;
  maxHeightClassName: string;
}) {
  const parsed = useMemo(() => parseCatalogContent(text), [text]);
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
            {showRaw ? "Show formatted" : "Show raw"}
          </Button>
          {parsed.envelopeTag && !showRaw ? (
            <span className="text-[11px] text-muted-foreground">
              Wrapped in <code className="font-mono">{`<${parsed.envelopeTag}>`}</code> when sent to
              the agent
            </span>
          ) : null}
        </div>
      ) : null}
      {rendered ? (
        <div
          className={cn(
            "chat-markdown overflow-auto rounded-lg border border-border/70 bg-muted/20 px-3 py-2 text-xs leading-relaxed text-foreground/85",
            maxHeightClassName,
          )}
          aria-label={label}
        >
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{parsed.body}</ReactMarkdown>
        </div>
      ) : (
        <pre className={cn(RAW_CLASS_NAME, maxHeightClassName)} aria-label={label}>
          <code>{text}</code>
        </pre>
      )}
    </div>
  );
}
