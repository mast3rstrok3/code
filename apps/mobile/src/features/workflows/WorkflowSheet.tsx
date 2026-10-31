import { LegendList } from "@legendapp/list/react-native";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { elapsedBetween } from "@t3tools/client-runtime/workflow-panel";
import type { WorkflowStepStatus } from "@t3tools/client-runtime/workflow-model";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { WORKFLOW_PRESET_DEFINITION_BY_ID } from "@t3tools/shared/workflowPresets";
import * as Haptics from "expo-haptics";
import { useState, type ReactNode } from "react";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { cn } from "../../lib/cn";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useOpenPullRequest } from "../../native/useOpenPullRequest";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { useVisibleSecondClock } from "../threads/use-visible-second-clock";
import { WorkflowQuestionsCard } from "./WorkflowQuestions";
import { WorkflowSheetFrame } from "./WorkflowSheetFrame";
import { WorkflowScopeMenu, type WorkflowScopeHandlers } from "./WorkflowScopeMenu";
import {
  buildWorkflowSheetRows,
  buildWorkflowTicketStatuses,
  summarizeWorkflowTickets,
  type WorkflowScopeControls,
  type WorkflowSheetRow,
} from "./workflowSheetModel";
import { workflowStepStyle, workflowThreadStyle } from "./workflowStatusStyle";
import {
  useWorkflowCommands,
  useWorkflowRun,
  type WorkflowCommands,
  type WorkflowRun,
} from "./useWorkflowRun";

type WorkflowSheetTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

export function WorkflowSheet({ route }: StaticScreenProps<WorkflowSheetTarget>) {
  const navigation = useNavigation();
  const target = route.params;
  const run = useWorkflowRun(target.environmentId, target.threadId);
  const commands = useWorkflowCommands(target.environmentId, run.rootId);
  const [document, setDocument] = useState<{ title: string; markdown: string } | null>(null);
  const title = document?.title ?? "Workflow";

  const content =
    document !== null ? (
      <WorkflowDocument markdown={document.markdown} onBack={() => setDocument(null)} />
    ) : (
      <WorkflowSheetContent
        target={target}
        run={run}
        commands={commands}
        onOpenDocument={setDocument}
        onOpenThread={(threadId) => {
          void Haptics.selectionAsync();
          // The sheet is a leaf: the thread belongs in the workspace stack.
          navigation.dispatch(
            StackActions.replace("Thread", { environmentId: target.environmentId, threadId }),
          );
        }}
        onOpenStepSettings={(stepWorkflowPromptId) =>
          navigation.navigate("ThreadWorkflowSettings", {
            environmentId: target.environmentId,
            threadId: run.rootId,
            ...(stepWorkflowPromptId === null ? {} : { stepWorkflowPromptId }),
          })
        }
      />
    );

  return (
    <WorkflowSheetFrame
      screenId="thread-workflow-sheet-native"
      title={title}
      onBack={() => (document === null ? navigation.goBack() : setDocument(null))}
    >
      {content}
    </WorkflowSheetFrame>
  );
}

function WorkflowSheetContent(props: {
  readonly target: WorkflowSheetTarget;
  readonly run: WorkflowRun;
  readonly commands: WorkflowCommands;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenDocument: (document: { title: string; markdown: string }) => void;
  readonly onOpenStepSettings: (stepWorkflowPromptId: string | null) => void;
}) {
  const insets = useSafeAreaInsets();
  const { run, commands } = props;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showAllEntries, setShowAllEntries] = useState<ReadonlySet<string>>(new Set());
  const workflow = run.workflow;
  const sheetInput =
    workflow === null
      ? null
      : {
          workflow,
          implementationRuns: run.implementationRuns,
          appReviewWorkflowRuns: run.appReviewWorkflowRuns,
          tickets: run.tickets,
          spec: run.spec,
          defaultStepCycles: run.settings.workflowStepCycles,
          expanded,
          showAllEntries,
        };
  const rows = sheetInput === null ? [] : buildWorkflowSheetRows(sheetInput);
  const ticketStatuses = sheetInput === null ? [] : buildWorkflowTicketStatuses(sheetInput);
  const disabled = !commands.canDispatch || commands.busy;

  const toggle = (row: { readonly id: string; readonly expanded: boolean }) => {
    void Haptics.selectionAsync();
    setExpanded((current) => ({ ...current, [row.id]: !row.expanded }));
  };
  const sendEach = (commandsToSend: ReadonlyArray<Parameters<WorkflowCommands["send"]>[0]>) => {
    for (const command of commandsToSend) void commands.send(command);
  };
  const handlers: WorkflowScopeHandlers = {
    onStop: (controls) =>
      sendEach(
        controls.runningThreadIds.map((threadId) => ({
          type: "thread.session.stop",
          ...commands.base(),
          threadId,
        })),
      ),
    onResume: (controls) =>
      sendEach(
        controls.pausedScopeThreadIds.map((threadId) => ({
          type: "thread.workflow.resume",
          ...commands.base(),
          threadId,
        })),
      ),
    onRestart: (controls) => {
      const restart = controls.restart;
      if (restart === null) return;
      switch (restart.kind) {
        case "planning-stage":
          void commands.send({
            type: "thread.planning-stage.start",
            ...commands.base(),
            stage: restart.stage,
          });
          return;
        case "resume":
          void commands.send({ type: "thread.workflow.resume", ...commands.base() });
          return;
        case "retry":
          void commands.send({
            type: "thread.implementation-run.retry",
            ...commands.base(),
            runId: restart.runId,
          });
          return;
        case "rerun":
          sendEach(
            restart.targets.map((target) => ({
              type: "thread.implementation-run.rerun",
              ...commands.base(),
              runId: restart.runId,
              target,
            })),
          );
      }
    },
    onClear: (controls: WorkflowScopeControls) => {
      const clear = controls.clear;
      if (clear === null) return;
      sendEach(
        clear.targets.map((target) => ({
          type: "thread.implementation-run.reset",
          ...commands.base(),
          runId: clear.runId,
          target,
        })),
      );
    },
    onSetSkipped: (controls, skipped) => {
      const skip = controls.skip;
      if (skip === null) return;
      void commands.send({
        type: "thread.implementation-run.skip",
        ...commands.base(),
        runId: skip.runId,
        target: skip.target,
        skipped,
      });
    },
  };

  const header = (
    <View className="gap-4 pb-4 pt-2">
      {run.error !== null && workflow === null ? <ErrorBanner message={run.error} /> : null}
      {commands.error !== null ? <ErrorBanner message={commands.error} /> : null}
      {workflow !== null ? (
        <WorkflowRootHeader
          run={run}
          commands={commands}
          onOpenRoot={() => props.onOpenThread(workflow.root.id)}
          onOpenSettings={() => props.onOpenStepSettings(null)}
        />
      ) : null}
      {run.pendingQuestions.map((request) => (
        <WorkflowQuestionsCard
          key={request.requestId}
          request={request}
          disabled={disabled}
          onSubmit={(requestId, answers) =>
            commands.send({
              type: "thread.user-input.respond",
              ...commands.base(),
              threadId: props.target.threadId,
              requestId,
              answers,
            })
          }
        />
      ))}
      {ticketStatuses.length > 0 ? <TicketProgress statuses={ticketStatuses} /> : null}
    </View>
  );

  if (workflow === null) {
    return (
      <ScrollView
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        contentContainerClassName="px-5"
      >
        {header}
        <Text className="pt-6 text-center text-sm text-foreground-muted">
          {run.loading ? "Loading the workflow…" : "This thread is not part of a workflow."}
        </Text>
      </ScrollView>
    );
  }

  return (
    <LegendList
      className="flex-1"
      // The iOS header floats over the list, so UIKit insets the content.
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerStyle={{
        paddingHorizontal: 20,
        paddingBottom: Math.max(insets.bottom, 16) + 8,
      }}
      data={rows}
      estimatedItemSize={56}
      keyExtractor={(row) => row.id}
      keyboardShouldPersistTaps="handled"
      ListHeaderComponent={header}
      recycleItems={false}
      renderItem={({ item }) => (
        <WorkflowSheetRowView
          row={item}
          disabled={disabled}
          canDispatch={commands.canDispatch}
          handlers={handlers}
          onToggle={toggle}
          onShowAll={(stepId) => setShowAllEntries((current) => new Set([...current, stepId]))}
          onOpenThread={props.onOpenThread}
          onOpenDocument={props.onOpenDocument}
          onOpenStepSettings={props.onOpenStepSettings}
        />
      )}
    />
  );
}

function WorkflowRootHeader(props: {
  readonly run: WorkflowRun;
  readonly commands: WorkflowCommands;
  readonly onOpenRoot: () => void;
  readonly onOpenSettings: () => void;
}) {
  const root = props.run.workflow!.root;
  const paused = root.workflowPausedAt != null;
  const preset = root.workflowPreset ?? null;
  const disabled = !props.commands.canDispatch || props.commands.busy;
  return (
    <View className="gap-3">
      <Pressable
        accessibilityRole="link"
        accessibilityHint="Opens the workflow's main thread"
        onPress={props.onOpenRoot}
        className="flex-row items-center gap-3 rounded-2xl bg-grouped-card px-4 py-3 active:opacity-70"
      >
        <SymbolView
          name="point.3.connected.trianglepath.dotted"
          size={18}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
        <View className="min-w-0 flex-1 gap-0.5">
          <Text numberOfLines={1} className="font-t3-medium text-base text-foreground">
            {root.title}
          </Text>
          <Text numberOfLines={1} className="text-xs text-foreground-muted">
            {preset === null
              ? "Main thread"
              : `${WORKFLOW_PRESET_DEFINITION_BY_ID[preset].label} · Main thread`}
            {paused ? " · Paused" : ""}
          </Text>
        </View>
        <SymbolView
          name="chevron.right"
          size={14}
          tintColorClassName="accent-chevron"
          type="monochrome"
        />
      </Pressable>
      {props.commands.canDispatch ? (
        <View className="flex-row gap-2">
          <View className="flex-1">
            <Button
              label={paused ? "Resume" : "Pause"}
              accessibilityHint={
                paused
                  ? "Resumes the workflow from the step it stopped at, keeping its worktrees"
                  : "Pauses the workflow and stops all active agent sessions"
              }
              icon={paused ? "play" : "stop.fill"}
              fullWidth
              disabled={disabled}
              onPress={() =>
                void props.commands.send({
                  type: paused ? "thread.workflow.resume" : "thread.workflow.pause",
                  ...props.commands.base(),
                })
              }
            />
          </View>
          <View className="flex-1">
            <Button
              label="Models and cycles"
              icon="slider.horizontal.3"
              fullWidth
              onPress={props.onOpenSettings}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function TicketProgress(props: { readonly statuses: readonly WorkflowStepStatus[] }) {
  const counts = summarizeWorkflowTickets(props.statuses);
  const parts = [
    ["succeeded", "succeeded"],
    ["running", "running"],
    ["awaiting", "need you"],
    ["failed", "failed"],
    ["paused", "paused"],
    ["ready", "ready"],
    ["waiting", "waiting"],
    ["skipped", "skipped"],
  ] as const;
  return (
    <View className="gap-1 rounded-2xl bg-grouped-card px-4 py-3">
      <Text className="font-t3-medium text-sm text-foreground">
        Tickets · {counts.get("succeeded") ?? 0} of {props.statuses.length} succeeded
      </Text>
      <Text className="text-xs text-foreground-muted">
        {parts
          .flatMap(([key, label]) => {
            const count = counts.get(key) ?? 0;
            return count === 0 || key === "succeeded" ? [] : [`${count} ${label}`];
          })
          .join(" · ") || "All tickets accounted for"}
      </Text>
    </View>
  );
}

function StatusDot(props: { readonly className: string }) {
  return <View className={cn("size-2 shrink-0 rounded-full", props.className)} />;
}

/** Ticks once a second, only while the range is open and the sheet is visible. */
function Elapsed(props: { readonly startedAt: string; readonly endedAt: string | null }) {
  const now = useVisibleSecondClock(props.endedAt === null);
  const text = elapsedBetween(props.startedAt, props.endedAt, now);
  return text === "" ? null : (
    <Text className="shrink-0 text-xs tabular-nums text-foreground-muted">{text}</Text>
  );
}

function Chevron(props: { readonly expanded: boolean }) {
  return (
    <SymbolView
      name={props.expanded ? "chevron.down" : "chevron.right"}
      size={12}
      tintColorClassName="accent-icon-muted"
      type="monochrome"
    />
  );
}

function DisclosureRow(props: {
  readonly expanded: boolean;
  readonly label: string;
  readonly onPress: () => void;
  readonly children: ReactNode;
  readonly trailing?: ReactNode;
  readonly className?: string;
}) {
  return (
    <View className={cn("flex-row items-center", props.className)}>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={props.label}
        accessibilityState={{ expanded: props.expanded }}
        onPress={props.onPress}
        className="min-h-12 min-w-0 flex-1 flex-row items-center gap-2 py-2 active:opacity-70"
      >
        <Chevron expanded={props.expanded} />
        {props.children}
      </Pressable>
      {props.trailing}
    </View>
  );
}

function WorkflowSheetRowView(props: {
  readonly row: WorkflowSheetRow;
  readonly disabled: boolean;
  readonly canDispatch: boolean;
  readonly handlers: WorkflowScopeHandlers;
  readonly onToggle: (row: { readonly id: string; readonly expanded: boolean }) => void;
  readonly onShowAll: (stepId: string) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenDocument: (document: { title: string; markdown: string }) => void;
  readonly onOpenStepSettings: (stepWorkflowPromptId: string | null) => void;
}) {
  const { row } = props;
  switch (row.kind) {
    case "group": {
      const style = workflowStepStyle(row.status);
      return (
        <View className="mt-2 gap-1 border-t border-border pt-2">
          <DisclosureRow
            expanded={row.expanded}
            label={`${row.title}, ${row.label}`}
            onPress={() => props.onToggle(row)}
          >
            <StatusDot className={style.dotClassName} />
            <View className="min-w-0 flex-1 gap-0.5">
              <Text numberOfLines={1} className="font-t3-bold text-base text-foreground">
                {row.title}
              </Text>
              {row.subtitle !== null ? (
                <Text numberOfLines={2} className="text-xs text-foreground-muted">
                  {row.subtitle}
                </Text>
              ) : null}
            </View>
            <View className="items-end gap-0.5">
              <Text className={cn("text-xs font-t3-medium", style.textClassName)}>{row.label}</Text>
              <Elapsed startedAt={row.startedAt} endedAt={row.endedAt} />
            </View>
          </DisclosureRow>
          {row.halt !== null ? (
            <View className="gap-1 rounded-2xl border border-danger/30 bg-danger/5 px-4 py-3">
              <Text className="font-t3-bold text-sm text-foreground">Needs human attention</Text>
              <Text className="text-xs capitalize text-foreground-muted">{row.halt.scope}</Text>
              <Text className="text-sm text-foreground">{row.halt.detail}</Text>
              <Text className="text-xs text-foreground-muted">
                Automatic retries stopped. Start the affected step again to create a new execution.
              </Text>
            </View>
          ) : null}
        </View>
      );
    }
    case "phase": {
      const style = workflowStepStyle(row.status);
      return (
        <DisclosureRow
          expanded={row.expanded}
          label={`${row.phase} phase, ${row.done} of ${row.total} done`}
          onPress={() => props.onToggle(row)}
          className="pl-2"
        >
          <StatusDot className={style.dotClassName} />
          <Text className="font-t3-bold text-sm text-foreground">{row.phase}</Text>
          <Text numberOfLines={1} className={cn("min-w-0 flex-1 text-xs", style.textClassName)}>
            {row.liveStepLabel ?? ""}
          </Text>
          <Text className="text-xs tabular-nums text-foreground-muted">
            {row.done}/{row.total} done
          </Text>
        </DisclosureRow>
      );
    }
    case "step": {
      const style = workflowStepStyle(row.status);
      return (
        <View className="pl-4">
          <DisclosureRow
            expanded={row.expanded}
            label={`Step ${row.number}, ${row.label}, ${style.label}`}
            onPress={() => props.onToggle(row)}
            trailing={
              props.canDispatch ? (
                <WorkflowScopeMenu
                  controls={row.controls}
                  handlers={props.handlers}
                  disabled={props.disabled}
                  onOpenSettings={
                    row.tuning.workflowPromptId === null
                      ? undefined
                      : () => props.onOpenStepSettings(row.tuning.workflowPromptId)
                  }
                />
              ) : null
            }
          >
            <Text className="w-5 text-xs tabular-nums text-foreground-muted">{row.number}</Text>
            <StatusDot className={style.dotClassName} />
            <View className="min-w-0 flex-1 gap-0.5">
              <Text
                numberOfLines={2}
                className={cn(
                  "text-sm",
                  row.status === "skipped"
                    ? "text-foreground-muted line-through"
                    : "text-foreground",
                )}
              >
                {row.label}
              </Text>
              {row.expanded && row.badge !== null ? (
                <Text className="text-xs text-foreground-muted">{row.badge}</Text>
              ) : null}
            </View>
            <View className="items-end gap-0.5">
              <Text className={cn("text-xs", style.textClassName)}>{style.label}</Text>
              <Elapsed startedAt={row.startedAt} endedAt={row.endedAt} />
            </View>
          </DisclosureRow>
        </View>
      );
    }
    case "thread": {
      const style = workflowThreadStyle(row.status);
      return (
        <Pressable
          accessibilityRole="link"
          accessibilityHint="Opens this thread"
          onPress={() => props.onOpenThread(row.thread.id)}
          className="min-h-12 flex-row items-center gap-2 rounded-xl py-2 pr-2 active:bg-subtle"
          style={{ paddingLeft: 24 + row.indent * 12 }}
        >
          <StatusDot className={style.dotClassName} />
          <View className="min-w-0 flex-1 gap-0.5">
            {row.caption !== null ? (
              <Text className="text-2xs uppercase tracking-[1px] text-foreground-muted">
                {row.caption}
              </Text>
            ) : null}
            <Text numberOfLines={1} className="text-sm text-foreground">
              {row.thread.title}
            </Text>
            <Text numberOfLines={1} className="text-xs text-foreground-muted">
              {row.role} · {row.thread.modelSelection.model}
            </Text>
          </View>
          <Elapsed startedAt={row.startedAt} endedAt={row.endedAt} />
          <SymbolView
            name="chevron.right"
            size={12}
            tintColorClassName="accent-chevron"
            type="monochrome"
          />
        </Pressable>
      );
    }
    case "more":
      return (
        <Pressable
          accessibilityRole="button"
          onPress={() => props.onShowAll(row.stepId)}
          className="min-h-11 justify-center pl-9 active:opacity-70"
        >
          <Text className="text-xs text-primary-text">
            Show {row.hidden} earlier entr{row.hidden === 1 ? "y" : "ies"}
          </Text>
        </Pressable>
      );
    case "wave": {
      const style = workflowStepStyle(row.status);
      return (
        <View className="min-h-11 flex-row items-center gap-2 pl-9">
          <StatusDot className={style.dotClassName} />
          <Text className="min-w-0 flex-1 text-2xs font-t3-bold uppercase tracking-[1px] text-foreground-muted">
            {row.title}
          </Text>
          <Text className={cn("text-xs", style.textClassName)}>{style.label}</Text>
          {props.canDispatch ? (
            <WorkflowScopeMenu
              controls={row.controls}
              handlers={props.handlers}
              disabled={props.disabled}
            />
          ) : null}
        </View>
      );
    }
    case "ticket": {
      const style = workflowStepStyle(row.status);
      return (
        <View className="pl-9">
          <DisclosureRow
            expanded={row.expanded}
            label={`${row.title}, ${style.label}`}
            onPress={() => props.onToggle(row)}
            trailing={
              <View className="flex-row items-center">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`Read ${row.controls.label}`}
                  hitSlop={8}
                  onPress={() =>
                    props.onOpenDocument({ title: row.title, markdown: row.ticket.bodyMarkdown })
                  }
                  className="size-9 items-center justify-center rounded-full active:bg-subtle"
                >
                  <SymbolView
                    name="doc.text"
                    size={16}
                    tintColorClassName="accent-icon-muted"
                    type="monochrome"
                  />
                </Pressable>
                {props.canDispatch ? (
                  <WorkflowScopeMenu
                    controls={row.controls}
                    handlers={props.handlers}
                    disabled={props.disabled}
                  />
                ) : null}
              </View>
            }
          >
            <StatusDot className={style.dotClassName} />
            <Text numberOfLines={2} className="min-w-0 flex-1 text-sm text-foreground">
              {row.title}
            </Text>
            <Text className={cn("text-xs", style.textClassName)}>{style.label}</Text>
          </DisclosureRow>
        </View>
      );
    }
    case "document":
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityHint="Opens this planning document"
          onPress={() => props.onOpenDocument({ title: row.title, markdown: row.markdown })}
          className="min-h-11 flex-row items-center gap-2 pl-4 active:opacity-70"
        >
          <SymbolView name="doc.text" size={14} tintColorClassName="accent-icon-muted" />
          <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-primary-text">
            {row.title}
          </Text>
        </Pressable>
      );
    case "note":
      return <Text className="py-2 pl-9 text-xs text-foreground-muted">{row.text}</Text>;
    case "heading":
      return (
        <Text className="pb-1 pl-2 pt-3 text-2xs font-t3-bold uppercase tracking-[1px] text-foreground-muted">
          {row.text}
        </Text>
      );
  }
}

function WorkflowDocument(props: { readonly markdown: string; readonly onBack: () => void }) {
  const styles = useMarkdownPreviewStyles();
  const openLink = useOpenPullRequest();
  const insets = useSafeAreaInsets();
  return (
    <ScrollView
      contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
      contentContainerClassName="gap-4 px-5"
      contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
    >
      {Platform.OS === "ios" ? (
        <View className="flex-row">
          <Button label="Back to workflow" tone="text" icon="chevron.left" onPress={props.onBack} />
        </View>
      ) : null}
      <SelectableMarkdownText
        markdown={props.markdown}
        textStyle={styles.nativeTextStyle}
        onLinkPress={(href) => void openLink(href)}
      />
    </ScrollView>
  );
}
