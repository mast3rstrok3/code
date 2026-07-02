import { useMemo } from "react";
import { PlayCircle } from "lucide-react";
import type { ScopedThreadRef } from "@t3tools/contracts";

import { useThreadDevReviews } from "~/state/entities";
import { Button } from "./ui/button";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { DevReviewDocument } from "./DevReviewDocument";
import { selectActiveDevReviewRecord } from "./DevReviewPanel.logic";

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
        <DevReviewDocument record={activeRecord} environmentId={props.threadRef.environmentId} />
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
    </DiffPanelShell>
  );
}
