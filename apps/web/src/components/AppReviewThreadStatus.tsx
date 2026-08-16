import type { AppReviewWorkflowRun } from "@t3tools/contracts";
import { AlertTriangleIcon, CheckCircle2Icon, CircleDotIcon, XCircleIcon } from "lucide-react";

import { appReviewRunFailureSummary, appReviewRunStatusLabel } from "./AppReviewPanel.logic";
import { Button } from "./ui/button";
import { cn } from "~/lib/utils";

const STATUS_COPY = {
  running: {
    title: "App Review is running",
    icon: CircleDotIcon,
    tone: "text-primary",
  },
  passed: {
    title: "App Review passed",
    icon: CheckCircle2Icon,
    tone: "text-emerald-600 dark:text-emerald-400",
  },
  exhausted: {
    title: "App Review exhausted its attempts",
    icon: AlertTriangleIcon,
    tone: "text-amber-600 dark:text-amber-400",
  },
  failed: {
    title: "App Review failed",
    tone: "text-destructive",
    icon: XCircleIcon,
  },
} as const;

export function AppReviewThreadStatus(props: {
  readonly run: AppReviewWorkflowRun;
  readonly onOpenDetails: () => void;
}) {
  const status = STATUS_COPY[props.run.status];
  const StatusIcon = status.icon;
  const failureSummary = appReviewRunFailureSummary(props.run);

  return (
    <div className="flex h-full items-center justify-center px-4 py-8">
      <section
        className="w-full max-w-xl rounded-xl border border-border bg-card p-5 shadow-sm"
        data-testid="app-review-thread-status"
      >
        <div className="flex items-start gap-3">
          <StatusIcon className={cn("mt-0.5 size-5 shrink-0", status.tone)} />
          <div className="min-w-0 flex-1">
            <h2 className="text-sm font-semibold text-foreground">{status.title}</h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {appReviewRunStatusLabel(props.run)}
            </p>
          </div>
        </div>

        {failureSummary ? (
          <div className="mt-4 rounded-md border border-destructive/30 bg-destructive/5 p-3">
            <p className="whitespace-pre-wrap text-sm text-foreground">{failureSummary}</p>
          </div>
        ) : null}

        <div className="mt-4">
          <p className="text-xs font-medium text-foreground">Original brief</p>
          <p className="mt-1 max-h-28 overflow-y-auto whitespace-pre-wrap text-sm text-muted-foreground">
            {props.run.briefMarkdown}
          </p>
        </div>

        <Button
          className="mt-4"
          type="button"
          size="sm"
          variant="outline"
          onClick={props.onOpenDetails}
        >
          Open App Review details
        </Button>
      </section>
    </div>
  );
}
