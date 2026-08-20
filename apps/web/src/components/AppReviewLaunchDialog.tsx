import { useEffect, useMemo, useState } from "react";
import {
  APP_REVIEW_WORKFLOW_DEFAULT_CYCLES,
  APP_REVIEW_WORKFLOW_MAX_CYCLES,
} from "@t3tools/contracts";
import { truncate } from "@t3tools/shared/String";
import { extractPreviewUrls } from "@t3tools/shared/preview";

import {
  type BrowserAppReviewSourceContext,
  type AppReviewWorkflowLaunchRequest,
  normalizeAppReviewPreviewTarget,
} from "./ChatView.logic";
import { isValidAppReviewWorkflowLaunch } from "./AppReviewPanel.logic";
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

interface AppReviewLaunchDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly launchInFlight: boolean;
  readonly launchDisabled: boolean;
  readonly sourceSettled: boolean;
  readonly sourceContext: BrowserAppReviewSourceContext | null;
  readonly previewTargets: ReadonlyArray<string>;
  readonly initialCycleBudget?: number;
  readonly initialReviewUrl?: string;
  readonly onLaunch: (request: AppReviewWorkflowLaunchRequest) => void;
}

export function AppReviewLaunchDialog(props: AppReviewLaunchDialogProps) {
  const [brief, setBrief] = useState("");
  const [reviewUrl, setReviewUrl] = useState("");
  const [cycleBudget, setCycleBudget] = useState(
    props.initialCycleBudget ?? APP_REVIEW_WORKFLOW_DEFAULT_CYCLES,
  );
  const normalizedBrief = brief.trim();
  const pinnedTarget = normalizeAppReviewPreviewTarget(reviewUrl);
  const resolvedPreviewTargets = useMemo(
    () => Array.from(new Set([...extractPreviewUrls(normalizedBrief), ...props.previewTargets])),
    [normalizedBrief, props.previewTargets],
  );
  const validLaunch = isValidAppReviewWorkflowLaunch({
    brief: normalizedBrief,
    cycleBudget,
    sourceSettled: props.sourceSettled,
    worktreeOwned: props.launchDisabled,
  });
  const sourcePreview = useMemo(
    () => formatSourcePreview(props.sourceContext),
    [props.sourceContext],
  );

  useEffect(() => {
    if (!props.open) return;
    setCycleBudget(props.initialCycleBudget ?? APP_REVIEW_WORKFLOW_DEFAULT_CYCLES);
    setReviewUrl(props.initialReviewUrl ?? "");
  }, [props.initialCycleBudget, props.initialReviewUrl, props.open]);

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!props.launchInFlight) props.onOpenChange(open);
      }}
    >
      <DialogPopup className="max-w-xl overflow-hidden">
        <DialogHeader>
          <DialogTitle>Launch App Review</DialogTitle>
          <DialogDescription>
            Each cycle reviews the app, analyzes gaps and plans in that same thread, then implements
            the plan in a new thread.
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
            <span className="text-xs font-medium text-foreground">App Review cycle budget</span>
            <Input
              type="number"
              min={1}
              max={APP_REVIEW_WORKFLOW_MAX_CYCLES}
              value={cycleBudget}
              onChange={(event) => setCycleBudget(Number(event.currentTarget.value))}
            />
            <span className="text-xs text-muted-foreground">Between 1 and 50 complete cycles.</span>
          </label>
          <label className="grid gap-2">
            <span className="text-xs font-medium text-foreground">Review URL</span>
            <Input
              type="text"
              placeholder="localhost:5173"
              value={reviewUrl}
              onChange={(event) => setReviewUrl(event.currentTarget.value)}
            />
            <span className="text-xs text-muted-foreground">
              {pinnedTarget === null
                ? "Leave empty to resolve this worktree's App Dev Stack."
                : `Reviews ${pinnedTarget} as given, without resolving an App Dev Stack.`}
            </span>
          </label>
          {pinnedTarget === null ? (
            <div className="rounded-lg border bg-muted/30 p-3">
              <p className="text-xs font-medium text-foreground">Preview targets</p>
              {resolvedPreviewTargets.length > 0 ? (
                <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                  {resolvedPreviewTargets.map((url) => (
                    <li key={url} className="truncate" title={url}>
                      {url}
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="mt-2 text-xs text-muted-foreground">
                  The matching App Dev Stack will be resolved from this worktree when the workflow
                  starts.
                </p>
              )}
            </div>
          ) : null}
          <div className="rounded-lg border bg-muted/30 p-3">
            <p className="text-xs font-medium text-foreground">Supporting source context</p>
            <pre className="mt-2 max-h-28 whitespace-pre-wrap break-words text-xs leading-5 text-muted-foreground">
              {sourcePreview}
            </pre>
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
            onClick={() => props.onLaunch({ brief: normalizedBrief, cycleBudget, reviewUrl })}
          >
            Launch App Review
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function formatSourcePreview(context: BrowserAppReviewSourceContext | null): string {
  if (context === null) return "No settled source-turn context is available.";
  return context.messages
    .map((message) => `${message.role}: ${truncate(message.text, 280)}`)
    .join("\n\n");
}
