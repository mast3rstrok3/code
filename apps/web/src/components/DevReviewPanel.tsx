import { useEffect, useMemo, useRef } from "react";
import { PlayCircle } from "lucide-react";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { reviewEnvironment } from "~/state/review";
import { useEnvironmentQuery } from "~/state/query";
import { useThreadDevReviews } from "~/state/entities";
import { Button } from "./ui/button";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DevReviewDocument } from "./DevReviewDocument";
import { selectActiveDevReviewRecord, shouldRefreshDevReviewReplay } from "./DevReviewPanel.logic";

export function DevReviewPanel(props: {
  mode: DiffPanelMode;
  threadRef: ScopedThreadRef;
  launchInFlight: boolean;
  onLaunch: () => void;
}) {
  const records = useThreadDevReviews(props.threadRef);
  const activeRecord = useMemo(() => {
    return selectActiveDevReviewRecord(records, props.threadRef.threadId);
  }, [props.threadRef.threadId, records]);
  const replayQuery = useEnvironmentQuery(
    activeRecord
      ? reviewEnvironment.getDevReviewReplay({
          environmentId: props.threadRef.environmentId,
          input: { reviewId: activeRecord.id },
        })
      : null,
  );
  const replayRefreshRevisionRef = useRef<string | null>(null);
  useEffect(() => {
    const decision = shouldRefreshDevReviewReplay({
      record: activeRecord,
      data: replayQuery.data,
      isPending: replayQuery.isPending,
      lastRefreshRevision: replayRefreshRevisionRef.current,
    });
    replayRefreshRevisionRef.current = decision.revision;
    if (decision.refresh) {
      replayQuery.refresh();
    }
  }, [activeRecord, replayQuery.data, replayQuery.isPending, replayQuery.refresh]);
  const replay =
    activeRecord === null
      ? { kind: "empty" as const }
      : replayQuery.error
        ? { kind: "error" as const, message: replayQuery.error }
        : replayQuery.data
          ? replayQuery.data.events.length > 0
            ? { kind: "ready" as const, events: replayQuery.data.events }
            : activeRecord.replay.eventCount > 0
              ? { kind: "loading" as const }
              : { kind: "empty" as const }
          : replayQuery.isPending
            ? { kind: "loading" as const }
            : activeRecord.replay.eventCount > 0
              ? { kind: "loading" as const }
              : { kind: "empty" as const };

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
            onClick={props.onLaunch}
          >
            <PlayCircle className="size-4" />
            Launch Browser Dev Review
          </Button>
        </>
      }
    >
      {activeRecord ? (
        <DevReviewDocument record={activeRecord} replay={replay} />
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center">
          <div className="max-w-sm">
            <h3 className="text-sm font-medium">No Dev Review record</h3>
            <p className="mt-2 text-sm text-muted-foreground">
              Launch Browser Dev Review to create a durable review thread and replay-backed record.
            </p>
          </div>
        </div>
      )}
    </DiffPanelShell>
  );
}
