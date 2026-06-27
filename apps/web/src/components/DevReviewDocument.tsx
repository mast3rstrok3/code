import { Replayer } from "@rrweb/replay";
import "@rrweb/replay/dist/style.css";
import type { DevReviewRecord } from "@t3tools/contracts";
import { AlertTriangle, CheckCircle2, Circle, CircleDot, Info, XCircle } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

import { cn } from "~/lib/utils";

type ReplayState =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready"; events: readonly unknown[] }
  | { kind: "empty" };

const statusClassName = {
  pending: "text-muted-foreground",
  running: "text-info",
  passed: "text-success",
  failed: "text-destructive",
  blocked: "text-warning",
} as const;

const severityClassName = {
  blocker: "border-destructive/50 bg-destructive/10 text-destructive",
  major: "border-warning/50 bg-warning/10 text-warning",
  minor: "border-info/50 bg-info/10 text-info",
  note: "border-border bg-muted/50 text-muted-foreground",
} as const;

function statusIcon(status: DevReviewRecord["status"]) {
  switch (status) {
    case "passed":
      return <CheckCircle2 className="size-4 text-success" />;
    case "failed":
      return <XCircle className="size-4 text-destructive" />;
    case "blocked":
      return <AlertTriangle className="size-4 text-warning" />;
    case "running":
      return <CircleDot className="size-4 text-info" />;
    case "pending":
      return <Circle className="size-4 text-muted-foreground" />;
  }
}

function ReplayPlayer(props: { replay: ReplayState }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [renderError, setRenderError] = useState<string | null>(null);
  const events =
    props.replay.kind === "ready" && props.replay.events.length > 0 ? props.replay.events : null;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !events) return;
    container.replaceChildren();
    setRenderError(null);
    let replayer: Replayer | null = null;
    try {
      replayer = new Replayer(events as never[], {
        root: container,
        showWarning: false,
        showDebug: false,
        mouseTail: false,
      });
      replayer.play();
    } catch (error) {
      setRenderError(error instanceof Error ? error.message : "Unable to render replay.");
    }
    return () => {
      replayer?.destroy();
      container.replaceChildren();
    };
  }, [events]);

  if (props.replay.kind === "loading") {
    return <div className="px-3 py-4 text-sm text-muted-foreground">Loading replay...</div>;
  }
  if (props.replay.kind === "error") {
    return <div className="px-3 py-4 text-sm text-destructive">{props.replay.message}</div>;
  }
  if (props.replay.kind === "empty") {
    return <div className="px-3 py-4 text-sm text-muted-foreground">No replay events saved.</div>;
  }

  return (
    <div className="min-h-0">
      {renderError ? <div className="px-3 py-2 text-sm text-destructive">{renderError}</div> : null}
      <div ref={containerRef} className="h-[360px] min-h-0 overflow-hidden bg-black" />
    </div>
  );
}

export function DevReviewDocument(props: { record: DevReviewRecord; replay: ReplayState }) {
  const { record } = props;
  const checks = record.document.checks;
  const findings = record.document.findings;
  const questions = record.document.questions;
  const nextSteps = record.document.nextSteps;
  const statusLabel = record.status[0]?.toUpperCase() + record.status.slice(1);
  const replayLabel = useMemo(() => {
    const pieces = [record.replay.status, `${record.replay.eventCount} events`];
    if (record.replay.durationMs !== null) pieces.push(`${record.replay.durationMs} ms`);
    return pieces.join(" · ");
  }, [record.replay.durationMs, record.replay.eventCount, record.replay.status]);

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
                  <span className="shrink-0 text-xs text-muted-foreground">{check.status}</span>
                </div>
                {check.notes ? (
                  <p className="mt-1 text-sm leading-relaxed text-muted-foreground">
                    {check.notes}
                  </p>
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

      <section className="grid gap-4 border-b border-border px-4 py-3 md:grid-cols-2">
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

      <section className="min-h-0 px-4 py-3">
        <div className="mb-2 flex items-center justify-between gap-3">
          <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-normal text-muted-foreground">
            <Info className="size-3.5" />
            RRweb Replay
          </h3>
          <span className="text-xs text-muted-foreground">{replayLabel}</span>
        </div>
        <div className="overflow-hidden rounded-md border border-border">
          <ReplayPlayer replay={props.replay} />
        </div>
        {record.replay.error ? (
          <p className="mt-2 text-sm text-destructive">{record.replay.error}</p>
        ) : null}
      </section>
    </div>
  );
}
