import { isDomReplayRecording } from "@t3tools/client-runtime/app-review";
import {
  APP_REVIEW_RECORDING_EVIDENCE_ID,
  type AppReviewRecord,
  type AppReviewScreenshotEvidence,
  type AppReviewTestResult,
  type AppReviewWorkflowCycle,
  type AssetResource,
  type EnvironmentId,
} from "@t3tools/contracts";
import { Image } from "expo-image";
import { useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import type { FilePreviewItem, FilePreviewSource } from "../../components/FilePreviewModal";
import { FilePreviewModal } from "../../components/FilePreviewModal";
import { MediaVideoPlayer } from "../../components/MediaVideoPlayer";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { cn } from "../../lib/cn";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { useAssetUrlState, useRefreshAssetUrl } from "../../state/assets";
import { appReviewRecordStyle } from "./appReviewStatusStyle";

const SEVERITY_CLASS = {
  blocker: "text-danger-foreground",
  major: "text-warning-foreground",
  minor: "text-foreground",
  note: "text-foreground-muted",
} as const;

function openExternal(url: string) {
  void tryOpenExternalUrl(url, "app-review").then((opened) => {
    if (!opened) Dialog.alert("Unable to open", "The link could not be opened.");
  });
}

function Section(props: {
  readonly title: string;
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
}) {
  return (
    <View className="gap-2">
      <View className="flex-row items-center justify-between gap-3 px-1">
        <Text className="text-2xs font-t3-bold uppercase tracking-[1px] text-foreground-muted">
          {props.title}
        </Text>
        {props.trailing}
      </View>
      <View className="gap-2 rounded-2xl bg-grouped-card px-4 py-3">{props.children}</View>
    </View>
  );
}

function Muted(props: { readonly children: ReactNode }) {
  return <Text className="text-sm text-foreground-muted">{props.children}</Text>;
}

/**
 * One cycle: its result, the E2E commands it ran with their recordings, and the
 * reviews agents wrote for it.
 */
export function AppReviewCycleDocument(props: {
  readonly cycle: AppReviewWorkflowCycle;
  readonly e2eRecord: AppReviewRecord | undefined;
  readonly browserRecord: AppReviewRecord | undefined;
  readonly environmentId: EnvironmentId;
}) {
  const testResults = props.cycle.e2eExecution?.results ?? [];
  const summaries = [props.e2eRecord, props.browserRecord].flatMap((record) =>
    record?.document.summary ? [record] : [],
  );
  return (
    <>
      <Section title="Overall result">
        <Text className="font-t3-medium text-sm text-foreground">{props.cycle.status}</Text>
        {summaries.map((record) => (
          <Text key={record.id} selectable className="text-sm text-foreground">
            {record.document.summary}
          </Text>
        ))}
        {summaries.length === 0 && testResults.length === 0 ? <Muted>No summary yet.</Muted> : null}
        {props.cycle.actionableFindingsMarkdown ? (
          <Text selectable className="text-sm text-foreground-muted">
            {props.cycle.actionableFindingsMarkdown}
          </Text>
        ) : null}
        {props.cycle.failure ? (
          <Text selectable className="text-sm text-danger-foreground">
            Cycle spent · {props.cycle.failure.reason}: {props.cycle.failure.detailMarkdown}
          </Text>
        ) : null}
      </Section>
      {props.cycle.e2eExecution ? <TestResultsSection results={testResults} /> : null}
      {props.e2eRecord !== undefined ? (
        <ReviewSection
          title="Agent review · end-to-end tests"
          record={props.e2eRecord}
          environmentId={props.environmentId}
        />
      ) : null}
      {props.cycle.appReviewScope !== "e2e" || props.browserRecord !== undefined ? (
        <ReviewSection
          title="Agent review · browser"
          record={props.browserRecord}
          environmentId={props.environmentId}
        />
      ) : null}
    </>
  );
}

/**
 * The commands a cycle ran. Their per-test recordings are rrweb DOM captures,
 * which only the web replayer plays, so mobile lists them without a player.
 */
function TestResultsSection(props: { readonly results: readonly AppReviewTestResult[] }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Section title="End-to-end tests">
      {props.results.length === 0 ? <Muted>No test command has finished.</Muted> : null}
      {props.results.map((result, index) => {
        const recordings = result.recordings ?? [];
        const expanded = open === result.command;
        return (
          <View
            key={result.command}
            className={cn("gap-1.5", index > 0 && "border-t border-border-subtle pt-2")}
          >
            <View className="flex-row items-start gap-3">
              <Text selectable className="min-w-0 flex-1 font-mono text-xs text-foreground">
                {result.executedCommand}
              </Text>
              <Text
                className={cn(
                  "text-xs",
                  result.status === "failed" ? "text-danger-foreground" : "text-foreground-muted",
                )}
              >
                {result.status}
              </Text>
            </View>
            {recordings.length === 0 ? (
              <Text className="text-xs text-foreground-muted">This command recorded no tests.</Text>
            ) : (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                onPress={() => setOpen(expanded ? null : result.command)}
                className="flex-row items-center gap-1.5 py-1 active:opacity-70"
              >
                <SymbolView
                  name={expanded ? "chevron.down" : "chevron.right"}
                  size={11}
                  tintColorClassName="accent-icon-muted"
                  type="monochrome"
                />
                <Text className="text-xs text-foreground-muted">
                  {recordings.length} recorded {recordings.length === 1 ? "test" : "tests"} · replay
                  in the web app
                </Text>
              </Pressable>
            )}
            {expanded
              ? recordings.map((recording) => (
                  <View key={recording.id} className="flex-row gap-3 pl-4">
                    <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-foreground">
                      {recording.label}
                    </Text>
                    <Text className="text-xs tabular-nums text-foreground-muted">
                      {(recording.sizeBytes / (1024 * 1024)).toFixed(1)} MB
                    </Text>
                  </View>
                ))
              : null}
          </View>
        );
      })}
    </Section>
  );
}

/** An agent's review, folded until asked for so its media is signed only when looked at. */
function ReviewSection(props: {
  readonly title: string;
  readonly record: AppReviewRecord | undefined;
  readonly environmentId: EnvironmentId;
}) {
  const [open, setOpen] = useState(false);
  const style = props.record ? appReviewRecordStyle(props.record.status) : null;
  return (
    <View className="gap-3">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen(!open)}
        className="min-h-12 flex-row items-center gap-2 rounded-2xl bg-grouped-card px-4 py-3 active:opacity-70"
      >
        <SymbolView
          name={open ? "chevron.down" : "chevron.right"}
          size={12}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
        <Text className="min-w-0 flex-1 font-t3-medium text-sm text-foreground">{props.title}</Text>
        <Text className={cn("text-xs", style?.textClassName ?? "text-foreground-muted")}>
          {props.record?.status ?? "No results"}
        </Text>
      </Pressable>
      {open ? (
        props.record ? (
          <AppReviewRecordDocument record={props.record} environmentId={props.environmentId} />
        ) : (
          <Muted>No results or recordings for this section.</Muted>
        )
      ) : null}
    </View>
  );
}

/** One review's verdict, evidence, checks, findings, and follow-ups. */
export function AppReviewRecordDocument(props: {
  readonly record: AppReviewRecord;
  readonly environmentId: EnvironmentId;
}) {
  const { record } = props;
  const { document } = record;
  const recording = record.evidence.recording;
  const screenshots = record.evidence.screenshots;
  const showsBrowserEvidence =
    record.appReviewScope !== "e2e" || recording.status !== "not-started" || screenshots.length > 0;
  const style = appReviewRecordStyle(record.status);
  return (
    <>
      <Section title="Verdict">
        <View className="flex-row items-center gap-2">
          <View className={cn("size-2 rounded-full", style.dotClassName)} />
          <Text className="font-t3-medium text-sm capitalize text-foreground">{record.status}</Text>
          <Text className="text-sm text-foreground-muted">Verdict: {document.verdict}</Text>
        </View>
        {document.summary ? (
          <Text selectable className="text-sm text-foreground">
            {document.summary}
          </Text>
        ) : (
          <Muted>Review document is pending.</Muted>
        )}
      </Section>

      {showsBrowserEvidence ? (
        <>
          <RecordingSection record={record} environmentId={props.environmentId} />
          <ScreenshotsSection
            reviewId={record.id}
            screenshots={screenshots}
            environmentId={props.environmentId}
          />
        </>
      ) : null}

      <Section title="Checks">
        {document.checks.length === 0 ? <Muted>No checks recorded.</Muted> : null}
        {document.checks.map((check, index) => (
          <View
            key={check.id}
            className={cn("gap-1", index > 0 && "border-t border-border-subtle pt-2")}
          >
            <View className="flex-row items-start gap-3">
              <Text className="min-w-0 flex-1 font-t3-medium text-sm text-foreground">
                {check.label}
              </Text>
              <Text
                className={cn(
                  "text-xs",
                  check.status === "failed" || check.status === "blocked"
                    ? "text-danger-foreground"
                    : "text-foreground-muted",
                )}
              >
                {check.carriedFromCycle === undefined
                  ? check.status
                  : `${check.status} · carried from cycle ${String(check.carriedFromCycle)}`}
              </Text>
            </View>
            {check.notes ? (
              <Text selectable className="text-sm text-foreground-muted">
                {check.notes}
              </Text>
            ) : null}
            {check.replayUrl ? (
              <Pressable
                accessibilityRole="link"
                accessibilityHint="Opens the test runner's replay in the browser"
                onPress={() => openExternal(check.replayUrl!)}
                className="flex-row items-center gap-1 self-start py-1 active:opacity-70"
              >
                <Text className="text-xs font-t3-medium text-primary-text">Open web replay</Text>
                <SymbolView name="arrow.up.right" size={11} tintColorClassName="accent-primary" />
              </Pressable>
            ) : null}
          </View>
        ))}
      </Section>

      <Section title="Findings">
        {document.findings.length === 0 ? <Muted>No findings recorded.</Muted> : null}
        {document.findings.map((finding, index) => (
          <View
            key={finding.id}
            className={cn("gap-1", index > 0 && "border-t border-border-subtle pt-2")}
          >
            <View className="flex-row items-start gap-3">
              <Text className="min-w-0 flex-1 font-t3-bold text-sm text-foreground">
                {finding.title}
              </Text>
              <Text className={cn("text-xs", SEVERITY_CLASS[finding.severity])}>
                {finding.severity}
              </Text>
            </View>
            {finding.details ? (
              <Text selectable className="text-sm text-foreground">
                {finding.details}
              </Text>
            ) : null}
            {finding.reproduction ? (
              <Text selectable className="text-sm text-foreground-muted">
                {finding.reproduction}
              </Text>
            ) : null}
            {finding.evidenceIds.length > 0 ? (
              <Text className="text-xs text-foreground-muted">
                Evidence: {finding.evidenceIds.join(", ")}
              </Text>
            ) : null}
          </View>
        ))}
      </Section>

      <Section title="Questions">
        {document.questions.length === 0 ? <Muted>None.</Muted> : null}
        {document.questions.map((question) => (
          <Text key={question} selectable className="text-sm text-foreground">
            {question}
          </Text>
        ))}
      </Section>

      <Section title="Next steps">
        {document.nextSteps.length === 0 ? <Muted>None.</Muted> : null}
        {document.nextSteps.map((step) => (
          <Text key={step} selectable className="text-sm text-foreground">
            {step}
          </Text>
        ))}
      </Section>
    </>
  );
}

function RecordingSection(props: {
  readonly record: AppReviewRecord;
  readonly environmentId: EnvironmentId;
}) {
  const recording = props.record.evidence.recording;
  const playable = recording.status === "saved" && !isDomReplayRecording(recording.mimeType);
  const resource: AssetResource | null = playable
    ? {
        _tag: "app-review-evidence",
        reviewId: props.record.id,
        evidenceId: APP_REVIEW_RECORDING_EVIDENCE_ID,
      }
    : null;
  const asset = useAssetUrlState(props.environmentId, resource);
  // Signed URLs last an hour, so playback and opening re-sign rather than
  // trusting a URL minted when the screen opened.
  const refresh = useRefreshAssetUrl(props.environmentId, resource);
  const detail = [
    recording.status,
    recording.sizeBytes === null ? null : `${(recording.sizeBytes / (1024 * 1024)).toFixed(1)} MB`,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Section
      title="Recording"
      trailing={<Text className="text-xs text-foreground-muted">{detail}</Text>}
    >
      {playable ? (
        <>
          <MediaVideoPlayer
            uri={asset._tag === "Success" ? asset.url : null}
            unavailable={asset._tag === "Failure"}
            resolvePlaybackUri={refresh}
            name={recording.path?.split("/").pop() ?? "recording.webm"}
            thumbnailKey={`app-review-recording:${props.record.id}`}
          />
          <View className="flex-row">
            <Button
              label="Open in browser"
              tone="text"
              icon="arrow.up.right"
              disabled={asset._tag !== "Success"}
              onPress={() =>
                void refresh().then((url) => {
                  if (url !== null) openExternal(url);
                })
              }
            />
          </View>
        </>
      ) : recording.status === "saved" ? (
        <Muted>This recording is a DOM replay. Open it from the web app.</Muted>
      ) : (
        <Muted>
          {recording.status === "recording"
            ? "Recording in progress…"
            : recording.status === "failed"
              ? "Recording failed."
              : "No recording captured yet."}
        </Muted>
      )}
      {recording.error ? (
        <Text className="text-sm text-danger-foreground">{recording.error}</Text>
      ) : null}
    </Section>
  );
}

function screenshotItem(
  reviewId: AppReviewRecord["id"],
  screenshot: AppReviewScreenshotEvidence,
  environmentId: EnvironmentId,
): FilePreviewItem {
  return {
    kind: "image",
    name: screenshot.caption || screenshot.id,
    mimeType: screenshot.mimeType,
    environmentId,
    resource: { _tag: "app-review-evidence", reviewId, evidenceId: screenshot.id },
  };
}

function ScreenshotsSection(props: {
  readonly reviewId: AppReviewRecord["id"];
  readonly screenshots: readonly AppReviewScreenshotEvidence[];
  readonly environmentId: EnvironmentId;
}) {
  const [preview, setPreview] = useState<FilePreviewSource | null>(null);
  const gallery = props.screenshots.map((screenshot) =>
    screenshotItem(props.reviewId, screenshot, props.environmentId),
  );
  return (
    <Section title="Screenshots">
      {props.screenshots.length === 0 ? <Muted>No screenshots captured.</Muted> : null}
      <View className="flex-row flex-wrap gap-3">
        {props.screenshots.map((screenshot, index) => (
          <ScreenshotTile
            key={screenshot.id}
            item={gallery[index]!}
            screenshot={screenshot}
            onPress={() => setPreview({ ...gallery[index]!, gallery })}
          />
        ))}
      </View>
      <FilePreviewModal source={preview} onRequestClose={() => setPreview(null)} />
    </Section>
  );
}

function ScreenshotTile(props: {
  readonly item: FilePreviewItem;
  readonly screenshot: AppReviewScreenshotEvidence;
  readonly onPress: () => void;
}) {
  const asset = useAssetUrlState(
    "environmentId" in props.item ? props.item.environmentId : null,
    "resource" in props.item ? props.item.resource : null,
  );
  const label = props.screenshot.caption
    ? `${props.screenshot.id} · ${props.screenshot.caption}`
    : props.screenshot.id;
  return (
    <Pressable
      accessibilityRole="imagebutton"
      accessibilityLabel={`Expand screenshot ${label}`}
      onPress={props.onPress}
      className="gap-1 active:opacity-70"
      style={{ width: "47%" }}
    >
      <View className="aspect-video w-full items-center justify-center overflow-hidden rounded-xl border border-border-subtle bg-black">
        {asset._tag === "Success" ? (
          <Image
            source={{ uri: asset.url }}
            style={{ width: "100%", height: "100%" }}
            contentFit="contain"
            cachePolicy="memory-disk"
            recyclingKey={label}
          />
        ) : (
          <Text className="text-xs text-white/70">
            {asset._tag === "Failure" ? "Unavailable" : "Loading…"}
          </Text>
        )}
      </View>
      <Text numberOfLines={1} className="text-xs text-foreground-muted">
        {label}
      </Text>
    </Pressable>
  );
}
