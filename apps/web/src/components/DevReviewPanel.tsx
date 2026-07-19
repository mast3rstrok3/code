import { useMemo, useState } from "react";
import { PlayCircle } from "lucide-react";
import type { ScopedThreadRef, WorkflowArtifactsSnapshot } from "@t3tools/contracts";

import { useThreadDevReviews, useThreadPlanningWorkflow } from "~/state/entities";
import { Badge } from "./ui/badge";
import type {
  BrowserDevReviewLaunchRequest,
  BrowserDevReviewSourceContext,
} from "./ChatView.logic";
import { Button } from "./ui/button";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DevReviewDocument } from "./DevReviewDocument";
import { DevReviewLaunchDialog } from "./DevReviewLaunchDialog";
import { selectActiveDevReviewRecord } from "./DevReviewPanel.logic";

export function DevReviewPanel(props: {
  mode: DiffPanelMode;
  threadRef: ScopedThreadRef;
  launchInFlight: boolean;
  autoContext: BrowserDevReviewSourceContext | null;
  onLaunch: (request: BrowserDevReviewLaunchRequest) => void;
  onOpenPlanArtifact?: (ticketId: string | null) => void;
  workflowArtifacts?: WorkflowArtifactsSnapshot | null;
}) {
  const [launchDialogOpen, setLaunchDialogOpen] = useState(false);
  const localRecords = useThreadDevReviews(props.threadRef);
  const localPlanningWorkflow = useThreadPlanningWorkflow(props.threadRef);
  const records = props.workflowArtifacts?.devReviews ?? localRecords;
  const planningWorkflow =
    props.workflowArtifacts == null
      ? localPlanningWorkflow
      : {
          spec: props.workflowArtifacts.spec,
          tickets: props.workflowArtifacts.tickets,
        };
  const activeRecord = useMemo(() => {
    return selectActiveDevReviewRecord(records, props.threadRef.threadId);
  }, [props.threadRef.threadId, records]);

  return (
    <DiffPanelShell
      mode={props.mode}
      header={
        <>
          <div className="min-w-0">
            <h2 className="truncate text-sm font-semibold">Dev Review</h2>
            <p className="truncate text-xs text-muted-foreground">
              {activeRecord ? activeRecord.status : "No review launched"}
            </p>
          </div>
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={props.launchInFlight}
            onClick={() => setLaunchDialogOpen(true)}
          >
            <PlayCircle className="size-4" />
            Launch Browser Dev Review
          </Button>
        </>
      }
    >
      {activeRecord ? (
        <>
          <div className="border-b border-border px-4 py-3">
            {planningWorkflow?.spec ? (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={() => props.onOpenPlanArtifact?.(null)}
              >
                Spec · {planningWorkflow.spec.title}
              </Button>
            ) : null}
            {(activeRecord.planningTicketIds?.length ?? 0) > 0 ? (
              <div className="mt-2 flex flex-wrap gap-1.5" aria-label="Linked planning tickets">
                {(activeRecord.planningTicketIds ?? []).map((ticketId) => (
                  <button
                    key={ticketId}
                    type="button"
                    onClick={() => props.onOpenPlanArtifact?.(ticketId)}
                  >
                    <Badge variant="outline" size="sm">
                      {planningWorkflow?.tickets.find((ticket) => ticket.id === ticketId)?.key ??
                        ticketId}
                    </Badge>
                  </button>
                ))}
              </div>
            ) : null}
          </div>
          <DevReviewDocument record={activeRecord} environmentId={props.threadRef.environmentId} />
        </>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
          <div className="max-w-sm">
            <h3 className="text-sm font-medium">No Dev Review record</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Launch Browser Dev Review to create a durable review thread with recording and
              screenshot evidence.
            </p>
          </div>
        </div>
      )}
      <DevReviewLaunchDialog
        open={launchDialogOpen}
        onOpenChange={setLaunchDialogOpen}
        launchInFlight={props.launchInFlight}
        autoContext={props.autoContext}
        onLaunch={(request) => {
          props.onLaunch(request);
          setLaunchDialogOpen(false);
        }}
      />
    </DiffPanelShell>
  );
}
