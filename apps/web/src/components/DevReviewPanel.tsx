import { useMemo } from "react";
import { PlayCircle } from "lucide-react";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { reviewEnvironment } from "~/state/review";
import { useEnvironmentQuery } from "~/state/query";
import { useThreadDevReviews } from "~/state/entities";
import { Button } from "./ui/button";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DevReviewDocument } from "./DevReviewDocument";

export function DevReviewPanel(props: {
  mode: DiffPanelMode;
  threadRef: ScopedThreadRef;
  launchInFlight: boolean;
  onLaunch: () => void;
}) {
  const records = useThreadDevReviews(props.threadRef);
  const activeRecord = useMemo(() => {
    const sorted = [...records].sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
    );
    return (
      sorted.find((record) => record.reviewThreadId === props.threadRef.threadId) ??
      sorted.at(-1) ??
      null
    );
  }, [props.threadRef.threadId, records]);
  const replayQuery = useEnvironmentQuery(
    activeRecord
      ? reviewEnvironment.getDevReviewReplay({
          environmentId: props.threadRef.environmentId,
          input: { reviewId: activeRecord.id },
        })
      : null,
  );
  const replay =
    activeRecord === null
      ? { kind: "empty" as const }
      : replayQuery.error
        ? { kind: "error" as const, message: replayQuery.error }
        : replayQuery.data
          ? replayQuery.data.events.length > 0
            ? { kind: "ready" as const, events: replayQuery.data.events }
            : { kind: "empty" as const }
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
            Launch Q&A Dev Review
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
              Launch Q&A Dev Review to create a durable review thread and replay-backed record.
            </p>
          </div>
        </div>
      )}
    </DiffPanelShell>
  );
}
