import { useMemo, useState } from "react";
import { ChevronDown, ChevronRight, ExternalLink, PlayCircle, Square } from "lucide-react";
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
  appReviewRunTicketLabel,
  selectAppReviewRunsForPanel,
  selectHeadlineAppReviewRun,
} from "./AppReviewPanel.logic";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { AppReviewDocument } from "./AppReviewDocument";
import { AppReviewLaunchDialog } from "./AppReviewLaunchDialog";
import { cn } from "~/lib/utils";

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
        tickets: planningWorkflow?.tickets ?? [],
      }),
    [planningWorkflow?.tickets, props.threadRef.threadId, props.workflowArtifacts, runs],
  );
  const currentRun = selectHeadlineAppReviewRun(relevantRuns);
  const activeRun = relevantRuns.find((run) => run.status === "running") ?? null;
  const [expandedRunIds, setExpandedRunIds] = useState<Record<string, boolean>>({});
  const legacyRecords = records.filter(
    (record) =>
      !runs.some((run) =>
        run.cycles.some((cycle) => cycle.reviewId === record.id || cycle.e2eReviewId === record.id),
      ),
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
                label={
                  appReviewRunTicketLabel(run, planningWorkflow?.tickets ?? []) ??
                  (relevantRuns.length > 1 ? `App Review ${String(index + 1)}` : "App Review")
                }
                open={expandedRunIds[run.id] ?? false}
                onToggle={() =>
                  setExpandedRunIds((current) => ({ ...current, [run.id]: !current[run.id] }))
                }
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

/**
 * One App Review run, folded down to its ticket and status. A workflow can
 * carry a review per ticket plus its own, so every run and every cycle inside
 * it starts closed and the panel opens as a list the user can scan.
 */
function RunDetails(props: {
  readonly run: AppReviewWorkflowRun;
  readonly records: WorkflowArtifactsSnapshot["appReviews"];
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly label: string;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const [expandedCycles, setExpandedCycles] = useState<Record<number, boolean>>({});
  const recordById = new Map(props.records.map((record) => [record.id, record] as const));
  return (
    <section>
      <button
        type="button"
        aria-expanded={props.open}
        onClick={props.onToggle}
        className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left"
      >
        {props.open ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" />
        )}
        <span className="min-w-0 flex-1 truncate text-sm font-medium">{props.label}</span>
        <Badge variant="outline" size="sm">
          {appReviewRunStatusLabel(props.run)}
        </Badge>
      </button>

      {props.open ? (
        <>
          <div className="space-y-3 border-b border-t border-border px-4 py-3">
            <p className="text-xs text-muted-foreground">
              {props.run.cyclesUsed} of {props.run.cycleBudget} cycles used
            </p>
            <div>
              <p className="text-xs font-medium text-foreground">Original brief</p>
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted-foreground">
                {props.run.briefMarkdown}
              </p>
            </div>
            {props.run.failure ? (
              <div className="rounded-md border border-destructive/30 bg-destructive/5 p-3">
                <p className="text-xs font-medium text-destructive">
                  {props.run.status === "exhausted" ? "Last cycle" : "Blocked"} ·{" "}
                  {props.run.failure.reason}
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
              const e2eRecord =
                cycle.e2eReviewId == null ? undefined : recordById.get(cycle.e2eReviewId);
              const cycleOpen = expandedCycles[cycle.cycleNumber] ?? false;
              const [e2eStatus, reviewStatus, planningStatus, implementationStatus] =
                appReviewCycleStepStatuses(cycle);
              return (
                <article key={cycle.cycleNumber} className="overflow-hidden rounded-lg border">
                  <button
                    type="button"
                    aria-expanded={cycleOpen}
                    onClick={() =>
                      setExpandedCycles((current) => ({
                        ...current,
                        [cycle.cycleNumber]: !cycleOpen,
                      }))
                    }
                    className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-2 text-left"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      {cycleOpen ? (
                        <ChevronDown className="size-3.5 shrink-0" />
                      ) : (
                        <ChevronRight className="size-3.5 shrink-0" />
                      )}
                      <span className="truncate text-sm font-medium">
                        Cycle {cycle.cycleNumber} of {props.run.cycleBudget}
                      </span>
                    </span>
                    <Badge variant="outline" size="sm">
                      {cycle.status}
                    </Badge>
                  </button>
                  {cycleOpen ? (
                    <>
                      <ol className="space-y-2 border-b border-t px-3 py-3">
                        <CycleStep
                          number={1}
                          title="End-to-end test"
                          description="Run the configured E2E suite and publish its checks and replay links."
                          status={e2eStatus}
                          actionLabel="E2E thread"
                          {...(cycle.e2eThreadId
                            ? { onOpen: () => props.onOpenThread(cycle.e2eThreadId!) }
                            : {})}
                        />
                        <CycleStep
                          number={2}
                          title="Human-style UI review"
                          description="Use the app UI, test the acceptance brief, and save evidence."
                          status={reviewStatus}
                          actionLabel="Review thread"
                          {...(cycle.appReviewScope === "e2e"
                            ? {}
                            : { onOpen: () => props.onOpenThread(cycle.reviewerThreadId) })}
                        />
                        <CycleStep
                          number={3}
                          title="Gap analysis & repair tickets"
                          description="Analyze both review sections and create durable child tickets in a separate planning thread."
                          status={planningStatus}
                          actionLabel={
                            cycle.repairTickets?.length
                              ? `${cycle.repairTickets.length} repair ticket${cycle.repairTickets.length === 1 ? "" : "s"}`
                              : "Review thread"
                          }
                          onOpen={() =>
                            props.onOpenThread(
                              cycle.plannerThreadId ??
                                (cycle.appReviewScope === "e2e"
                                  ? (cycle.e2eThreadId ?? cycle.reviewerThreadId)
                                  : cycle.reviewerThreadId),
                            )
                          }
                        />
                        <CycleStep
                          number={4}
                          title="Implement the repair tickets"
                          description="Use the Implement skill in a fresh thread and validate every child ticket."
                          status={implementationStatus}
                          actionLabel="Implementation thread"
                          {...(cycle.fixerThreadId
                            ? { onOpen: () => props.onOpenThread(cycle.fixerThreadId!) }
                            : {})}
                        />
                      </ol>
                      {cycle.failure ? (
                        <p className="whitespace-pre-wrap border-b px-3 py-2 text-xs text-destructive">
                          Cycle spent · {cycle.failure.reason}: {cycle.failure.detailMarkdown}
                        </p>
                      ) : null}
                      {cycle.actionableFindingsMarkdown ? (
                        <p className="whitespace-pre-wrap border-b px-3 py-2 text-xs text-muted-foreground">
                          {cycle.actionableFindingsMarkdown}
                        </p>
                      ) : null}
                      {e2eRecord ? (
                        <section className="border-b border-border">
                          <h3 className="px-4 pt-3 text-xs font-semibold uppercase tracking-normal text-muted-foreground">
                            End-to-end test
                          </h3>
                          <AppReviewDocument
                            record={e2eRecord}
                            environmentId={props.environmentId}
                          />
                        </section>
                      ) : null}
                      {record ? (
                        <section>
                          <h3 className="px-4 pt-3 text-xs font-semibold uppercase tracking-normal text-muted-foreground">
                            Browser review
                          </h3>
                          <AppReviewDocument record={record} environmentId={props.environmentId} />
                        </section>
                      ) : cycle.appReviewScope !== "e2e" ? (
                        <p className="px-3 py-4 text-xs text-muted-foreground">
                          Review evidence is still being prepared.
                        </p>
                      ) : null}
                    </>
                  ) : null}
                </article>
              );
            })}
          </div>
        </>
      ) : null}
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
          : props.status === "failed"
            ? "Failed"
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
        <span
          className={cn(
            "text-[11px]",
            props.status === "failed" ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {statusLabel}
        </span>
        {props.onOpen ? (
          <Button type="button" size="xs" variant="ghost" onClick={props.onOpen}>
            {props.actionLabel} <ExternalLink className="size-3" />
          </Button>
        ) : null}
      </div>
    </li>
  );
}
