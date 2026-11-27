import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import type { AppReviewRecord, ScopedThreadRef } from "@t3tools/contracts";
import {
  APP_REVIEW_SKILL_PROMPT,
  APP_REVIEW_STATUS_LABELS,
} from "@t3tools/client-runtime/app-review";

import { useComposerDraftStore } from "~/composerDraftStore";
import { useThreadAppReviews } from "~/state/appReview";
import { AppReviewDocument } from "./AppReviewDocument";
import { DiffPanelShell, type DiffPanelMode } from "./DiffPanelShell";
import { Badge } from "./ui/badge";
import { Button } from "./ui/button";

/** Reviews an agent ran on this thread, newest first and open. */
export function AppReviewPanel(props: { mode: DiffPanelMode; threadRef: ScopedThreadRef }) {
  const reviews = useThreadAppReviews(props.threadRef);
  const newestFirst = (reviews.data ?? []).toReversed();
  const newest = newestFirst[0];
  const [openIds, setOpenIds] = useState<Record<string, boolean>>({});

  const askAgent = () => {
    const store = useComposerDraftStore.getState();
    const draft = store.getComposerDraft(props.threadRef)?.prompt ?? "";
    if (draft.startsWith(APP_REVIEW_SKILL_PROMPT)) return;
    store.setPrompt(props.threadRef, `${APP_REVIEW_SKILL_PROMPT}${draft}`);
  };

  return (
    <DiffPanelShell
      mode={props.mode}
      header={
        <div className="min-w-0">
          <h2 className="truncate text-sm font-semibold">
            {newestFirst.length > 1 ? `App Reviews · ${newestFirst.length}` : "App Review"}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {newest ? APP_REVIEW_STATUS_LABELS[newest.status] : "No review yet"}
          </p>
        </div>
      }
    >
      <div className="min-h-0 flex-1 overflow-y-auto">
        {reviews.error && newest === undefined ? (
          <p className="p-6 text-center text-sm text-destructive">{reviews.error}</p>
        ) : newest === undefined ? (
          <div className="flex min-h-52 items-center justify-center p-6 text-center">
            <div className="max-w-sm">
              <h3 className="text-sm font-medium">No App Review</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                The agent runs the end-to-end tests, tries the app in the browser, and records what
                it sees here.
              </p>
              <div className="mt-4">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={reviews.data === undefined}
                  onClick={askAgent}
                >
                  Ask the agent for an App Review
                </Button>
              </div>
            </div>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {newestFirst.map((record, index) => (
              <ReviewSection
                key={record.id}
                record={record}
                environmentId={props.threadRef.environmentId}
                label={record.document.brief || `App Review ${newestFirst.length - index}`}
                open={openIds[record.id] ?? index === 0}
                onToggle={() =>
                  setOpenIds((current) => ({
                    ...current,
                    [record.id]: !(current[record.id] ?? index === 0),
                  }))
                }
              />
            ))}
          </div>
        )}
      </div>
    </DiffPanelShell>
  );
}

function ReviewSection(props: {
  readonly record: AppReviewRecord;
  readonly environmentId: ScopedThreadRef["environmentId"];
  readonly label: string;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
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
          {APP_REVIEW_STATUS_LABELS[props.record.status]}
        </Badge>
      </button>
      {props.open ? (
        <AppReviewDocument record={props.record} environmentId={props.environmentId} />
      ) : null}
    </section>
  );
}
