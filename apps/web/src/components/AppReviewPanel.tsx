import { useMemo, useState } from "react";
import { ExternalLink, PlayCircle, Square } from "lucide-react";
import type {
  AppReviewWorkflowRun,
  ScopedThreadRef,
  ThreadId,
  WorkflowArtifactsSnapshot,
} from "@t3tools/contracts";

import {
  useAppReviewWorkflowRuns,
  useThreadAppReviews,
  useThreadPlanningWorkflow,
} from "~/state/entities";
import type {
  BrowserAppReviewSourceContext,
  AppReviewWorkflowLaunchRequest,
} from "./ChatView.logic";
import {
  appReviewCycleStepStatuses,
  appReviewRunStatusLabel,
  selectAppReviewRunsForPanel,
} from "./AppReviewPanel.logic";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { AppReviewDocument } from "./AppReviewDocument";
import { AppReviewLaunchDialog } from "./AppReviewLaunchDialog";

export function AppReviewPanel(props: {
  mode: DiffPanelMode;
  threadRef: ScopedThreadRef;
  launchInFlight: boolean;
  launchDisabled: boolean;
  sourceSettled: boolean;
  sourceContext: BrowserAppReviewSourceContext | null;
  previewTargets: ReadonlyArray<string>;
  onLaunch: (request: AppReviewWorkflowLaunchRequest) => void;
  onStop: (run: AppReviewWorkflowRun) => void;
  onOpenThread: (threadId: ThreadId) => void;
  onOpenPlanArtifact?: (ticketId: string | null) => void;
  workflowArtifacts?: WorkflowArtifactsSnapshot | null;
}) {
  const [launchDialogOpen, setLaunchDialogOpen] = useState(false);
  const localRecords = useThreadAppReviews(props.threadRef);
  const localRuns = useAppReviewWorkflowRuns(props.threadRef.environmentId);
  const localPlanningWorkflow = useThreadPlanningWorkflow(props.threadRef);
  const records = props.workflowArtifacts?.appReviews ?? localRecords;
  const runs = props.workflowArtifacts?.appReviewWorkflowRuns ?? localRuns;
  const planningWorkflow =
    props.workflowArtifacts == null
      ? localPlanningWorkflow
      : { spec: props.workflowArtifacts.spec, tickets: props.workflowArtifacts.tickets };
  const relevantRuns = useMemo(
    () =>
      selectAppReviewRunsForPanel({
        runs,
        openedThreadId: props.threadRef.threadId,
        workflowScoped: props.workflowArtifacts != null,
      }),
    [props.threadRef.threadId, props.workflowArtifacts, runs],
  );
  const currentRun = relevantRuns[0] ?? null;
  const activeRun = relevantRuns.find((run) => run.status === "running") ?? null;
  const legacyRecords = records.filter(
    (record) => !runs.some((run) => run.cycles.some((cycle) => cycle.reviewId === record.id)),
  );

  return (
    <DiffPanelShell
      mode={props.mode}
      header={
        <>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">
              {relevantRuns.length > 1 ? `App Reviews · ${relevantRuns.length}` : "App Review"}
            </h2>
            <p className="truncate text-xs text-muted-foreground">
              {currentRun ? appReviewRunStatusLabel(currentRun) : "No workflow launched"}
            </p>
          </div>
          {activeRun ? (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={props.launchInFlight}
              onClick={() => props.onStop(activeRun)}
            >
              <Square className="size-3.5" />
              Stop
            </Button>
          ) : (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={props.launchInFlight || props.launchDisabled}
              onClick={() => setLaunchDialogOpen(true)}
            >
              <PlayCircle className="size-4" />
              Launch App Review
            </Button>
          )}
        </>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        {currentRun ? (
          <div className="divide-y divide-border">
            {relevantRuns.map((run, index) => (
              <RunDetails
                key={run.id}
                run={run}
                records={records}
                environmentId={props.threadRef.environmentId}
                onOpenThread={props.onOpenThread}
                label={relevantRuns.length > 1 ? `App Review ${relevantRuns.length - index}` : null}
              />
            ))}
          </div>
        ) : (
          <div className="flex min-h-52 items-center justify-center p-6 text-center">
            <div className="max-w-sm">
              <h3 className="text-sm font-medium">No App Review workflow</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Launch a review loop to collect durable browser evidence and repair failed findings.
              </p>
            </div>
          </div>
        )}

        {planningWorkflow?.spec ? (
          <div className="border-t border-border px-4 py-3">
            <Button
              type="button"
              size="xs"
              variant="ghost"
              onClick={() => props.onOpenPlanArtifact?.(null)}
            >
              Spec · {planningWorkflow.spec.title}
            </Button>
          </div>
        ) : null}

        {legacyRecords.length > 0 ? (
          <section className="border-t border-border">
            <div className="px-4 py-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Legacy one-shot reviews
              </h3>
            </div>
            {legacyRecords.map((record) => (
              <AppReviewDocument
                key={record.id}
                record={record}
                environmentId={props.threadRef.environmentId}
              />
            ))}
          </section>
        ) : null}
      </div>

      <AppReviewLaunchDialog
        open={launchDialogOpen}
        onOpenChange={setLaunchDialogOpen}
        launchInFlight={props.launchInFlight}
        launchDisabled={props.launchDisabled}
        sourceSettled={props.sourceSettled}
        sourceContext={props.sourceContext}
        previewTargets={props.previewTargets}
        onLaunch={(request) => {
          props.onLaunch(request);
          setLaunchDialogOpen(false);
        }}
      />
    </DiffPanelShell>
  );
}

function RunDetails(props: {
  readonly run: AppReviewWorkflowRun;
  readonly records: WorkflowArtifactsSnapshot["appReviews"];
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly label: string | null;
}) {
  const recordById = new Map(props.records.map((record) => [record.id, record] as const));
  return (
    <section>
      <div className="space-y-3 border-b border-border px-4 py-3">
        {props.label ? <h3 className="text-sm font-semibold">{props.label}</h3> : null}
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="outline" size="sm">
            {appReviewRunStatusLabel(props.run)}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {props.run.cyclesUsed} of {props.run.cycleBudget} cycles used
          </span>
        </div>
        <div>
          <p className="text-xs font-medium text-foreground">Original brief</p>
          <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
            {props.run.briefMarkdown}
          </p>
        </div>
        {props.run.failure ? (
          <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
            <p className="text-xs font-medium text-destructive">
              Blocked · {props.run.failure.reason}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
              {props.run.failure.detailMarkdown}
            </p>
          </div>
        ) : null}
      </div>

      <div className="space-y-3 p-4">
        {props.run.cycles.map((cycle) => {
          const record = recordById.get(cycle.reviewId);
          const [reviewStatus, planningStatus, implementationStatus] =
            appReviewCycleStepStatuses(cycle);
          return (
            <article key={cycle.cycleNumber} className="overflow-hidden rounded-lg border">
              <div className="flex items-center justify-between gap-3 border-b px-3 py-2">
                <div>
                  <h3 className="text-sm font-medium">
                    Cycle {cycle.cycleNumber} of {props.run.cycleBudget}
                  </h3>
                </div>
                <Badge variant="outline" size="sm">
                  {cycle.status}
                </Badge>
              </div>
              <ol className="space-y-2 border-b px-3 py-3">
                <CycleStep
                  number={1}
                  title="Human-style UI review"
                  description="Use the app UI, test the acceptance brief, and save evidence."
                  status={reviewStatus}
                  actionLabel="Review thread"
                  onOpen={() => props.onOpenThread(cycle.reviewerThreadId)}
                />
                <CycleStep
                  number={2}
                  title="Gap analysis & fix plan"
                  description="Analyze failures and persist the repair plan in the same review thread."
                  status={planningStatus}
                  actionLabel={cycle.planId ? `Plan ${cycle.planId}` : "Review thread"}
                  onOpen={() => props.onOpenThread(cycle.reviewerThreadId)}
                />
                <CycleStep
                  number={3}
                  title="Implement the plan"
                  description="Use the Implement skill in a new thread and validate the repair."
                  status={implementationStatus}
                  actionLabel="Implementation thread"
                  {...(cycle.fixerThreadId
                    ? { onOpen: () => props.onOpenThread(cycle.fixerThreadId!) }
                    : {})}
                />
              </ol>
              {cycle.actionableFindingsMarkdown ? (
                <p className="whitespace-pre-wrap border-b px-3 py-2 text-xs text-muted-foreground">
                  {cycle.actionableFindingsMarkdown}
                </p>
              ) : null}
              {record ? (
                <AppReviewDocument record={record} environmentId={props.environmentId} />
              ) : (
                <p className="px-3 py-4 text-xs text-muted-foreground">
                  Review evidence is still being prepared.
                </p>
              )}
            </article>
          );
        })}
      </div>
    </section>
  );
}

function CycleStep(props: {
  readonly number: number;
  readonly title: string;
  readonly description: string;
  readonly status: ReturnType<typeof appReviewCycleStepStatuses>[number];
  readonly actionLabel: string;
  readonly onOpen?: () => void;
}) {
  const statusLabel =
    props.status === "not-needed"
      ? "Not needed"
      : props.status === "complete"
        ? "Complete"
        : props.status === "current"
          ? "In progress"
          : "Pending";
  return (
    <li className="flex items-start justify-between gap-3">
      <div className="min-w-0">
        <p className="text-xs font-medium text-foreground">
          {props.number}. {props.title}
        </p>
        <p className="mt-0.5 text-xs text-muted-foreground">{props.description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <span className="text-[11px] text-muted-foreground">{statusLabel}</span>
        {props.onOpen ? (
          <Button type="button" size="xs" variant="ghost" onClick={props.onOpen}>
            {props.actionLabel} <ExternalLink className="size-3" />
          </Button>
        ) : null}
      </div>
    </li>
  );
}
