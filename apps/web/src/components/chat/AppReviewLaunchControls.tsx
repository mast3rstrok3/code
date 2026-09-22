import { APP_REVIEW_WORKFLOW_MAX_CYCLES } from "@t3tools/contracts";
import { MonitorPlayIcon } from "lucide-react";

import { normalizeAppReviewPreviewTarget } from "../ChatView.logic";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";

/**
 * How the trigger names the target: the host the run will drive, or the App
 * Dev Stack it resolves from the worktree when the user named nothing.
 */
export function appReviewTargetLabel(reviewUrl: string): string {
  const normalized = normalizeAppReviewPreviewTarget(reviewUrl);
  if (normalized === null) return "App Stack";
  try {
    return new URL(normalized).host;
  } catch {
    return normalized;
  }
}

/** What the trigger says the next launch will do. */
export function appReviewLaunchSummary(input: {
  readonly cycleBudget: number;
  readonly reviewUrl: string;
  readonly reviewOnly: boolean;
}): string {
  const target = appReviewTargetLabel(input.reviewUrl);
  if (input.reviewOnly) return `Review only · ${target}`;
  return `${input.cycleBudget} ${input.cycleBudget === 1 ? "cycle" : "cycles"} · ${target}`;
}

/**
 * What an App Review launch needs beyond its brief: whether it repairs what it
 * finds, how many cycles it may spend, and what it drives.
 *
 * All three live in one popover rather than inline in the composer footer,
 * which has no room for a URL and collapses entirely on narrow viewports. The
 * fields commit as typed and are read only when the composer sends, so there
 * is no per-keystroke work behind them.
 */
export function AppReviewLaunchControls(props: {
  readonly cycleBudget: number;
  readonly reviewUrl: string;
  readonly reviewOnly: boolean;
  readonly defaultCycleBudget: number;
  readonly onCycleBudgetChange: (budget: number) => void;
  readonly onReviewUrlChange: (reviewUrl: string) => void;
  readonly onReviewOnlyChange: (reviewOnly: boolean) => void;
}) {
  const targetLabel = appReviewTargetLabel(props.reviewUrl);
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            aria-label="App Review cycles and target"
            className="ml-1 h-7 shrink-0 gap-1.5 px-2 text-xs text-muted-foreground"
            size="sm"
            variant="ghost"
          />
        }
      >
        <MonitorPlayIcon aria-hidden="true" className="size-3.5" />
        <span className="truncate">{appReviewLaunchSummary(props)}</span>
      </PopoverTrigger>
      <PopoverPopup
        align="start"
        className="w-[min(20rem,var(--available-width))]"
        side="top"
        sideOffset={8}
        viewportClassName="grid gap-3 p-3"
      >
        <label className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-x-2 gap-y-1">
          <Checkbox
            checked={props.reviewOnly}
            className="mt-0.5"
            onCheckedChange={(checked) => props.onReviewOnlyChange(checked === true)}
          />
          <span className="text-xs font-medium text-foreground">Only review</span>
          <span className="col-start-2 text-[11px] leading-relaxed text-muted-foreground">
            One browser review and the gap analysis that tickets what it finds, then stop. Nothing
            is repaired.
          </span>
        </label>
        {props.reviewOnly ? null : (
          <label className="grid gap-1.5">
            <span className="text-xs font-medium text-foreground">Cycles</span>
            <Input
              aria-label="App Review cycles"
              className="h-8 text-xs"
              max={APP_REVIEW_WORKFLOW_MAX_CYCLES}
              min={1}
              onChange={(event) => props.onCycleBudgetChange(Number(event.currentTarget.value))}
              step={1}
              type="number"
              value={props.cycleBudget}
            />
            <span className="text-[11px] leading-relaxed text-muted-foreground">
              1 to {APP_REVIEW_WORKFLOW_MAX_CYCLES}. Each cycle is one browser review, the repair
              tickets its gap analysis writes, and the fix. A passing review ends the run early.
              Settings uses {props.defaultCycleBudget} by default.
            </span>
          </label>
        )}
        <label className="grid gap-1.5">
          <span className="text-xs font-medium text-foreground">Review URL</span>
          <Input
            aria-label="App Review URL"
            className="h-8 text-xs"
            onChange={(event) => props.onReviewUrlChange(event.currentTarget.value)}
            placeholder="localhost:5173"
            type="text"
            value={props.reviewUrl}
          />
          <span className="text-[11px] leading-relaxed text-muted-foreground">
            {targetLabel === "App Stack"
              ? "Empty reviews this worktree's App Stack."
              : `Reviews ${targetLabel} as given, without resolving an App Stack.`}
          </span>
        </label>
      </PopoverPopup>
    </Popover>
  );
}
