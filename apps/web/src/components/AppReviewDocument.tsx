import type {
  AssetResource,
  AppReviewRecord,
  AppReviewRecordingEvidence,
  EnvironmentId,
} from "@t3tools/contracts";
import { APP_REVIEW_RECORDING_EVIDENCE_ID } from "@t3tools/contracts";
import { CheckCircle2, Circle, CircleDot, Info, XCircle } from "lucide-react";
import { Suspense, lazy, useMemo, useState } from "react";

import { useAssetUrls } from "~/assets/assetUrls";
import { cn } from "~/lib/utils";
import { MediaPreviewSurface, isDomReplayRecording } from "./media/MediaPreviewSurface";
import { ExpandedImageDialog } from "./chat/ExpandedImageDialog";
import type { ExpandedImagePreview } from "./chat/ExpandedImagePreview";

// rrweb's replayer is large and most reviews are never opened, so it stays out of
// the main chunk until someone actually looks at a DOM recording.
const DomReplaySurface = lazy(() => import("./media/DomReplaySurface"));

const statusClassName = {
  pending: "text-muted-foreground",
  running: "text-info",
  passed: "text-success",
  failed: "text-destructive",
} as const;

const severityClassName = {
  blocker: "border-destructive/50 bg-destructive/10 text-destructive",
  major: "border-warning/50 bg-warning/10 text-warning",
  minor: "border-info/50 bg-info/10 text-info",
  note: "border-border bg-muted/50 text-muted-foreground",
} as const;

function statusIcon(status: AppReviewRecord["status"]) {
  switch (status) {
    case "passed":
      return <CheckCircle2 className="size-4 text-success" />;
    case "failed":
      return <XCircle className="size-4 text-destructive" />;
    case "running":
      return <CircleDot className="size-4 text-info" />;
    case "pending":
      return <Circle className="size-4 text-muted-foreground" />;
  }
}

export function recordingEvidenceLabel(recording: AppReviewRecordingEvidence): string {
  const pieces: string[] = [recording.status];
  if (recording.sizeBytes !== null) {
    pieces.push(`${(recording.sizeBytes / (1024 * 1024)).toFixed(1)} MB`);
  }
  return pieces.join(" · ");
}

function RecordingSection(props: {
  recording: AppReviewRecordingEvidence;
  recordingUrl: string | null;
}) {
  const { recording } = props;

  return (
    <section className="border-b border-border px-4 py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-normal text-muted-foreground">
          <Info className="size-3.5" />
          Recording
        </h3>
        <span className="text-xs text-muted-foreground">{recordingEvidenceLabel(recording)}</span>
      </div>
      {recording.status === "saved" ? (
        props.recordingUrl ? (
          isDomReplayRecording(recording.mimeType) ? (
            <Suspense
              fallback={
                <div className="rounded-md border border-border px-3 py-4 text-sm text-muted-foreground">
                  Loading replay...
                </div>
              }
            >
              <DomReplaySurface url={props.recordingUrl} />
            </Suspense>
          ) : (
            <MediaPreviewSurface
              kind="video"
              name={recording.path ?? "recording.webm"}
              url={props.recordingUrl}
              mediaClassName="max-h-[360px] w-full rounded-md border border-border bg-black"
            />
          )
        ) : (
          <div className="rounded-md border border-border px-3 py-4 text-sm text-muted-foreground">
            Preparing recording...
          </div>
        )
      ) : (
        <p className="text-sm text-muted-foreground">
          {recording.status === "recording"
            ? "Recording in progress..."
            : recording.status === "failed"
              ? "Recording failed."
              : "No recording captured yet."}
        </p>
      )}
      {recording.error ? <p className="mt-2 text-sm text-destructive">{recording.error}</p> : null}
    </section>
  );
}

export function AppReviewDocument(props: {
  record: AppReviewRecord;
  environmentId: EnvironmentId;
}) {
  const { record } = props;
  const checks = record.document.checks;
  const findings = record.document.findings;
  const questions = record.document.questions;
  const nextSteps = record.document.nextSteps;
  const statusLabel = record.status[0]?.toUpperCase() + record.status.slice(1);
  const recording = record.evidence.recording;
  const screenshots = record.evidence.screenshots;
  const showsBrowserEvidence = record.appReviewScope !== "e2e";
  const recordingSaved = showsBrowserEvidence && recording.status === "saved";

  const evidenceResources = useMemo<AssetResource[]>(() => {
    const resources: AssetResource[] = [];
    if (recordingSaved) {
      resources.push({
        _tag: "app-review-evidence",
        reviewId: record.id,
        evidenceId: APP_REVIEW_RECORDING_EVIDENCE_ID,
      });
    }
    if (showsBrowserEvidence) {
      for (const screenshot of screenshots) {
        resources.push({
          _tag: "app-review-evidence",
          reviewId: record.id,
          evidenceId: screenshot.id,
        });
      }
    }
    return resources;
  }, [record.id, recordingSaved, screenshots, showsBrowserEvidence]);
  const evidenceUrls = useAssetUrls(props.environmentId, evidenceResources);
  const recordingUrl = recordingSaved ? (evidenceUrls[0] ?? null) : null;
  const screenshotUrls = recordingSaved ? evidenceUrls.slice(1) : evidenceUrls;

  const [expandedPreview, setExpandedPreview] = useState<ExpandedImagePreview | null>(null);
  const openScreenshot = (screenshotId: string) => {
    const images = screenshots.flatMap((screenshot, index) => {
      const src = screenshotUrls[index];
      return src ? [{ id: screenshot.id, src, name: screenshot.caption || screenshot.id }] : [];
    });
    const index = images.findIndex((image) => image.id === screenshotId);
    if (index < 0) return;
    setExpandedPreview({
      images: images.map((image) => ({ src: image.src, name: image.name })),
      index,
    });
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
      <div className="border-b border-border px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-medium">
          {statusIcon(record.status)}
          <span className={statusClassName[record.status]}>{statusLabel}</span>
          <span className="text-muted-foreground">Verdict: {record.document.verdict}</span>
        </div>
        {record.document.summary ? (
          <p className="mt-2 text-sm leading-relaxed text-foreground">{record.document.summary}</p>
        ) : (
          <p className="mt-2 text-sm text-muted-foreground">Review document is pending.</p>
        )}
      </div>

      {showsBrowserEvidence ? (
        <>
          <RecordingSection recording={recording} recordingUrl={recordingUrl} />

          <section className="border-b border-border px-4 py-3">
            <h3 className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
              Screenshots
            </h3>
            {screenshots.length === 0 ? (
              <p className="mt-2 text-sm text-muted-foreground">No screenshots captured.</p>
            ) : (
              <div className="mt-2 grid grid-cols-2 gap-3 md:grid-cols-3">
                {screenshots.map((screenshot, index) => {
                  const src = screenshotUrls[index] ?? null;
                  return (
                    <figure key={screenshot.id} className="min-w-0">
                      {src ? (
                        <button
                          type="button"
                          className="block w-full cursor-zoom-in"
                          onClick={() => openScreenshot(screenshot.id)}
                          aria-label={`Expand screenshot ${screenshot.id}`}
                        >
                          <img
                            src={src}
                            alt={screenshot.caption || screenshot.id}
                            className="aspect-video w-full rounded-md border border-border bg-black object-contain"
                          />
                        </button>
                      ) : (
                        <div className="flex aspect-video w-full items-center justify-center rounded-md border border-border text-xs text-muted-foreground">
                          Loading...
                        </div>
                      )}
                      <figcaption className="mt-1 truncate text-xs text-muted-foreground">
                        <span className="font-medium">{screenshot.id}</span>
                        {screenshot.caption ? ` · ${screenshot.caption}` : null}
                      </figcaption>
                    </figure>
                  );
                })}
              </div>
            )}
          </section>
        </>
      ) : null}

      <section className="border-b border-border px-4 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
          Checks
        </h3>
        {checks.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No checks recorded.</p>
        ) : (
          <div className="mt-2 divide-y divide-border/70">
            {checks.map((check) => (
              <div key={check.id} className="py-2">
                <div className="flex items-center justify-between gap-3 text-sm">
                  <span className="font-medium">{check.label}</span>
                  <span className="shrink-0 text-xs text-muted-foreground">
                    {check.carriedFromCycle === undefined
                      ? check.status
                      : `${check.status} · carried from cycle ${check.carriedFromCycle}`}
                  </span>
                </div>
                {check.notes ? (
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {check.notes}
                  </p>
                ) : null}
                {check.replayUrl ? (
                  <a
                    href={check.replayUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="mt-1 inline-flex text-xs font-medium text-info hover:underline"
                  >
                    Open web replay
                  </a>
                ) : null}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="border-b border-border px-4 py-3">
        <h3 className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
          Findings
        </h3>
        {findings.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No findings recorded.</p>
        ) : (
          <div className="mt-2 space-y-3">
            {findings.map((finding) => (
              <article key={finding.id} className="rounded-md border border-border p-3">
                <div className="flex items-start justify-between gap-3">
                  <h4 className="text-sm font-semibold">{finding.title}</h4>
                  <span
                    className={cn(
                      "rounded border px-1.5 py-0.5 text-[11px] font-medium",
                      severityClassName[finding.severity],
                    )}
                  >
                    {finding.severity}
                  </span>
                </div>
                {finding.details ? (
                  <p className="mt-2 text-sm leading-relaxed text-foreground">{finding.details}</p>
                ) : null}
                {finding.reproduction ? (
                  <p className="mt-2 text-sm leading-relaxed text-muted-foreground">
                    {finding.reproduction}
                  </p>
                ) : null}
                {finding.evidenceIds.length > 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground">
                    Evidence: {finding.evidenceIds.join(", ")}
                  </p>
                ) : null}
              </article>
            ))}
          </div>
        )}
      </section>

      <section className="grid gap-4 px-4 py-3 md:grid-cols-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
            Questions
          </h3>
          {questions.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">None.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm text-foreground">
              {questions.map((question) => (
                <li key={question}>{question}</li>
              ))}
            </ul>
          )}
        </div>
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-normal text-muted-foreground">
            Next Steps
          </h3>
          {nextSteps.length === 0 ? (
            <p className="mt-2 text-sm text-muted-foreground">None.</p>
          ) : (
            <ul className="mt-2 space-y-1 text-sm text-foreground">
              {nextSteps.map((step) => (
                <li key={step}>{step}</li>
              ))}
            </ul>
          )}
        </div>
      </section>

      {expandedPreview ? (
        <ExpandedImageDialog preview={expandedPreview} onClose={() => setExpandedPreview(null)} />
      ) : null}
    </div>
  );
}
