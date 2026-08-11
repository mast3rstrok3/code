import { useEffect, useMemo, useState } from "react";
import {
  DEV_REVIEW_WORKFLOW_DEFAULT_CYCLES,
  DEV_REVIEW_WORKFLOW_MAX_CYCLES,
} from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";

import type {
  BrowserDevReviewSourceContext,
  DevReviewWorkflowLaunchRequest,
} from "./ChatView.logic";
import { isValidDevReviewWorkflowLaunch } from "./DevReviewPanel.logic";
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
import { Input } from "./ui/input";
import { Textarea } from "./ui/textarea";

interface DevReviewLaunchDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly launchInFlight: boolean;
  readonly launchDisabled: boolean;
  readonly sourceSettled: boolean;
  readonly sourceContext: BrowserDevReviewSourceContext | null;
  readonly previewTargets: ReadonlyArray<string>;
  readonly initialCycleBudget?: number;
  readonly onLaunch: (request: DevReviewWorkflowLaunchRequest) => void;
}

export function DevReviewLaunchDialog(props: DevReviewLaunchDialogProps) {
  const [brief, setBrief] = useState("");
  const [cycleBudget, setCycleBudget] = useState(
    props.initialCycleBudget ?? DEV_REVIEW_WORKFLOW_DEFAULT_CYCLES,
  );
  const normalizedBrief = brief.trim();
  const validLaunch = isValidDevReviewWorkflowLaunch({
    brief: normalizedBrief,
    cycleBudget,
    sourceSettled: props.sourceSettled,
    previewTargets: props.previewTargets,
    worktreeOwned: props.launchDisabled,
  });
  const sourcePreview = useMemo(
    () => formatSourcePreview(props.sourceContext),
    [props.sourceContext],
  );

  useEffect(() => {
    if (!props.open) return;
    setCycleBudget(props.initialCycleBudget ?? DEV_REVIEW_WORKFLOW_DEFAULT_CYCLES);
  }, [props.initialCycleBudget, props.open]);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!props.launchInFlight) props.onOpenChange(open);
      }}
    >
      <DialogPopup className="max-w-xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Launch Dev Review</DialogTitle>
          <DialogDescription>
            Review, plan repairs, and fix in fresh threads until the feature passes or the budget is
            exhausted.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="grid gap-2">
            <span className="text-xs font-medium text-foreground">Review brief</span>
            <Textarea
              value={brief}
              onChange={(event) => setBrief(event.currentTarget.value)}
              placeholder="Verify the login flow, including validation, loading, and failed submissions."
              size="lg"
              autoFocus
            />
          </label>
          <label className="grid gap-2">
            <span className="text-xs font-medium text-foreground">Review attempts</span>
            <Input
              type="number"
              min={1}
              max={DEV_REVIEW_WORKFLOW_MAX_CYCLES}
              value={cycleBudget}
              onChange={(event) => setCycleBudget(Number(event.currentTarget.value))}
            />
            <span className="text-xs text-muted-foreground">Between 1 and 50 attempts.</span>
          </label>
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-xs font-medium text-foreground">Supporting source context</p>
            <pre className="mt-2 max-h-28 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
              {sourcePreview}
            </pre>
          </div>
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-xs font-medium text-foreground">Preview targets</p>
            {props.previewTargets.length > 0 ? (
              <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                {props.previewTargets.map((url) => (
                  <li key={url} className="truncate" title={url}>
                    {url}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-2 text-xs text-destructive">
                Open or configure a preview URL first.
              </p>
            )}
          </div>
          {!props.sourceSettled ? (
            <p className="text-xs text-destructive">Wait for the current source turn to settle.</p>
          ) : null}
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
            disabled={props.launchInFlight || !validLaunch}
            onClick={() => props.onLaunch({ brief: normalizedBrief, cycleBudget })}
          >
            Launch Dev Review
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function formatSourcePreview(context: BrowserDevReviewSourceContext | null): string {
  if (context === null) return "No settled source-turn context is available.";
  return context.messages
    .map((message) => `${message.role}: ${truncate(message.text, 280)}`)
    .join("\n\n");
}
