import { Radio as RadioPrimitive } from "@base-ui/react/radio";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { CheckCircle2, FileText, Sparkles } from "lucide-react";
import { truncate } from "@t3tools/shared/String";

import type {
  BrowserDevReviewLaunchMode,
  BrowserDevReviewLaunchRequest,
  BrowserDevReviewSourceContext,
} from "./ChatView.logic";
import { cn } from "~/lib/utils";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { RadioGroup } from "./ui/radio-group";
import { Textarea } from "./ui/textarea";

interface DevReviewLaunchDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly launchInFlight: boolean;
  readonly autoContext: BrowserDevReviewSourceContext | null;
  readonly onLaunch: (request: BrowserDevReviewLaunchRequest) => void;
}

export function DevReviewLaunchDialog(props: DevReviewLaunchDialogProps) {
  const [mode, setMode] = useState<BrowserDevReviewLaunchMode>(
    props.autoContext === null ? "custom" : "auto",
  );
  const [customPrompt, setCustomPrompt] = useState("");
  const autoAvailable = props.autoContext !== null;
  const customPromptText = customPrompt.trim();
  const launchDisabled =
    props.launchInFlight ||
    (mode === "auto" && !autoAvailable) ||
    (mode === "custom" && customPromptText.length === 0);

  const autoPreview = useMemo(() => formatAutoPreview(props.autoContext), [props.autoContext]);

  useEffect(() => {
    if (!autoAvailable && mode === "auto") {
      setMode("custom");
    }
  }, [autoAvailable, mode]);

  useEffect(() => {
    if (!props.open) return;
    setMode(autoAvailable ? "auto" : "custom");
  }, [autoAvailable, props.open]);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (props.launchInFlight) return;
        props.onOpenChange(open);
      }}
    >
      <DialogPopup className="max-w-xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Browser Dev Review</DialogTitle>
          <DialogDescription>
            Create a review thread with durable browser evidence.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <RadioGroup
            value={mode}
            onValueChange={(value) => setMode(value as BrowserDevReviewLaunchMode)}
            className="grid gap-2 sm:grid-cols-2"
            aria-label="Browser Dev Review source"
          >
            <ModeOption
              value="auto"
              checked={mode === "auto"}
              disabled={!autoAvailable}
              icon={<Sparkles className="size-4" aria-hidden />}
              title="Auto"
              detail={autoAvailable ? "Use latest settled turn" : "No settled turn"}
            />
            <ModeOption
              value="custom"
              checked={mode === "custom"}
              icon={<FileText className="size-4" aria-hidden />}
              title="Specifics"
              detail="Write a review prompt"
            />
          </RadioGroup>

          {mode === "auto" ? (
            <div className="rounded-lg border bg-muted/30 p-3">
              <div className="mb-2 flex items-center gap-2 text-xs font-medium text-foreground">
                <CheckCircle2 className="size-3.5" aria-hidden />
                Source turn
              </div>
              <pre className="max-h-40 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
                {autoPreview}
              </pre>
            </div>
          ) : (
            <label className="grid gap-2">
              <span className="text-xs font-medium text-foreground">Review prompt</span>
              <Textarea
                value={customPrompt}
                onChange={(event) => setCustomPrompt(event.currentTarget.value)}
                placeholder="Review the login flow, especially empty states and failed submissions."
                size="lg"
              />
            </label>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={props.launchInFlight}
            onClick={() => props.onOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={launchDisabled}
            onClick={() => {
              props.onLaunch(
                mode === "custom" ? { mode, customPrompt: customPromptText } : { mode },
              );
            }}
          >
            Launch review
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function ModeOption(props: {
  readonly value: BrowserDevReviewLaunchMode;
  readonly checked: boolean;
  readonly disabled?: boolean | undefined;
  readonly icon: ReactNode;
  readonly title: string;
  readonly detail: string;
}) {
  return (
    <RadioPrimitive.Root
      value={props.value}
      disabled={props.disabled}
      className={cn(
        "size-auto cursor-pointer justify-start rounded-lg border p-3 text-left",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1",
        props.checked ? "border-primary bg-background ring-2 ring-primary/30" : "border-border",
        props.disabled && "cursor-not-allowed opacity-60",
      )}
    >
      <span className="flex min-w-0 items-center gap-3">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-md bg-muted text-muted-foreground">
          {props.icon}
        </span>
        <span className="min-w-0">
          <span className="block text-sm font-medium text-foreground">{props.title}</span>
          <span className="block truncate text-xs text-muted-foreground">{props.detail}</span>
        </span>
      </span>
    </RadioPrimitive.Root>
  );
}

function formatAutoPreview(context: BrowserDevReviewSourceContext | null): string {
  if (context === null) return "No settled source turn found.";
  return context.messages
    .map((message) => `${message.role}: ${truncate(message.text, 280)}`)
    .join("\n\n");
}
