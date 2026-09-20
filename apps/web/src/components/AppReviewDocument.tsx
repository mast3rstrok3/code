import type {
  AssetResource,
  AppReviewRecord,
  AppReviewRecordingEvidence,
  AppReviewTestRecording,
  AppReviewTestResult,
  AppReviewWorkflowCycle,
  AppReviewWorkflowRunId,
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
  const showsBrowserEvidence =
    record.appReviewScope !== "e2e" || recording.status !== "not-started" || screenshots.length > 0;
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
                {check.replayUrl && isDomReplayRecording(check.replayMimeType ?? null) ? (
                  <Suspense
                    fallback={
                      <p className="mt-2 text-sm text-muted-foreground">Loading replay...</p>
                    }
                  >
                    <DomReplaySurface url={check.replayUrl} />
                  </Suspense>
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

export function AppReviewCycleDocument(props: {
  runId: AppReviewWorkflowRunId;
  cycle: AppReviewWorkflowCycle;
  e2eRecord?: AppReviewRecord | undefined;
  browserRecord?: AppReviewRecord | undefined;
  environmentId: EnvironmentId;
}) {
  const summaryRecords = [props.e2eRecord, props.browserRecord].filter(
    (record): record is AppReviewRecord => Boolean(record?.document.summary),
  );
  const testResults = props.cycle.e2eExecution?.results ?? [];
  return (
    <div>
      <section className="border-b border-border px-4 py-3">
        <h3 className="text-sm font-semibold">Overall result</h3>
        <p className="mt-1 text-xs text-muted-foreground">{props.cycle.status}</p>
        {summaryRecords.length > 0 ? (
          summaryRecords.map((record) => (
            <p key={record.id} className="mt-2 whitespace-pre-wrap text-sm leading-relaxed">
              {record.document.summary}
            </p>
          ))
        ) : testResults.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">No summary yet.</p>
        ) : null}
        {props.cycle.actionableFindingsMarkdown ? (
          <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
            {props.cycle.actionableFindingsMarkdown}
          </p>
        ) : null}
      </section>
      <TestRecordingsSection
        runId={props.runId}
        results={testResults}
        environmentId={props.environmentId}
      />
      {props.e2eRecord !== undefined ? (
        <ReviewEvidenceSection
          title="Agent review · end-to-end tests"
          record={props.e2eRecord}
          environmentId={props.environmentId}
        />
      ) : null}
      {props.cycle.appReviewScope !== "e2e" || props.browserRecord !== undefined ? (
        <ReviewEvidenceSection
          title="Agent review · browser"
          record={props.browserRecord}
          environmentId={props.environmentId}
        />
      ) : null}
    </div>
  );
}

/**
 * Every test the cycle's commands recorded, replayable in place. A fleet run
 * yields hundreds, so a row mints its URL and mounts the player only while open.
 */
function TestRecordingsSection(props: {
  runId: AppReviewWorkflowRunId;
  results: ReadonlyArray<AppReviewTestResult>;
  environmentId: EnvironmentId;
}) {
  const [open, setOpen] = useState(false);
  const [openRecordingId, setOpenRecordingId] = useState<string | null>(null);
  const recordingCount = props.results.reduce(
    (count, result) => count + (result.recordings?.length ?? 0),
    0,
  );
  return (
    <section className="border-b border-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left text-sm font-medium"
      >
        <span>Test recordings</span>
        <span className="text-xs text-muted-foreground">
          {props.results.length === 0
            ? "No results"
            : `${recordingCount} ${recordingCount === 1 ? "recording" : "recordings"}`}{" "}
          · {open ? "Collapse" : "Expand"}
        </span>
      </button>
      {open ? (
        props.results.length === 0 ? (
          <p className="px-4 pb-3 text-sm text-muted-foreground">No test command has finished.</p>
        ) : (
          <ul className="space-y-3 px-4 pb-3">
            {props.results.map((result) => (
              <li key={result.command} className="rounded-md border border-border">
                <div className="flex items-start justify-between gap-3 px-3 py-2">
                  <code className="min-w-0 break-words text-xs">{result.executedCommand}</code>
                  <span className={cn("shrink-0 text-xs", statusClassName[result.status])}>
                    {result.status}
                  </span>
                </div>
                {result.recordings?.length ? (
                  <ul className="border-t border-border">
                    {result.recordings.map((recording) => (
                      <TestRecordingRow
                        key={recording.id}
                        runId={props.runId}
                        recording={recording}
                        open={openRecordingId === recording.id}
                        onToggle={() =>
                          setOpenRecordingId(openRecordingId === recording.id ? null : recording.id)
                        }
                        environmentId={props.environmentId}
                      />
                    ))}
                  </ul>
                ) : (
                  <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                    This command recorded no tests.
                  </p>
                )}
              </li>
            ))}
          </ul>
        )
      ) : null}
    </section>
  );
}

function TestRecordingRow(props: {
  runId: AppReviewWorkflowRunId;
  recording: AppReviewTestRecording;
  open: boolean;
  onToggle: () => void;
  environmentId: EnvironmentId;
}) {
  return (
    <li className="border-b border-border last:border-b-0">
      <button
        type="button"
        aria-expanded={props.open}
        onClick={props.onToggle}
        className="flex w-full cursor-pointer items-center justify-between gap-3 px-3 py-1.5 text-left text-xs hover:bg-muted/50"
      >
        <span className="min-w-0 truncate">{props.recording.label}</span>
        <span className="shrink-0 text-muted-foreground">
          {(props.recording.sizeBytes / (1024 * 1024)).toFixed(1)} MB
        </span>
      </button>
      {props.open ? (
        <TestRecordingReplay
          runId={props.runId}
          recordingId={props.recording.id}
          environmentId={props.environmentId}
        />
      ) : null}
    </li>
  );
}

function TestRecordingReplay(props: {
  runId: AppReviewWorkflowRunId;
  recordingId: string;
  environmentId: EnvironmentId;
}) {
  const resources = useMemo<AssetResource[]>(
    () => [
      { _tag: "app-review-test-recording", runId: props.runId, recordingId: props.recordingId },
    ],
    [props.runId, props.recordingId],
  );
  const [url] = useAssetUrls(props.environmentId, resources);
  const loading = <div className="px-3 py-4 text-sm text-muted-foreground">Loading replay...</div>;
  return url ? (
    <Suspense fallback={loading}>
      <div className="px-3 pb-3">
        <DomReplaySurface url={url} />
      </div>
    </Suspense>
  ) : (
    loading
  );
}

function ReviewEvidenceSection(props: {
  title: string;
  record?: AppReviewRecord | undefined;
  environmentId: EnvironmentId;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="border-b border-border">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center justify-between px-4 py-3 text-left text-sm font-medium"
      >
        <span>{props.title}</span>
        <span className="text-xs text-muted-foreground">
          {props.record?.status ?? "No results"} · {open ? "Collapse" : "Expand"}
        </span>
      </button>
      {open ? (
        props.record ? (
          <AppReviewDocument record={props.record} environmentId={props.environmentId} />
        ) : (
          <p className="px-4 pb-3 text-sm text-muted-foreground">
            No results or recordings for this section.
          </p>
        )
      ) : null}
    </section>
  );
}
