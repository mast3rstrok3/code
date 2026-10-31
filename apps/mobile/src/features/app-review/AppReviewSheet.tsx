import { LegendList } from "@legendapp/list/react-native";
import type { MenuAction } from "@react-native-menu/menu";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  APP_REVIEW_CYCLE_STEP_STATUS_LABELS,
  appReviewRunStatusLabel,
} from "@t3tools/client-runtime/app-review";
import {
  CommandId,
  type AppReviewWorkflowRun,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { useState, type ReactNode } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { Menu } from "../../components/ui/Menu";
import { cn } from "../../lib/cn";
import { uuidv4 } from "../../lib/uuid";
import { AppStackSheetFrame, type AppStackHeaderAction } from "../app-stacks/AppStackSheetFrame";
import { buildAppReviewSheetRows, type AppReviewSheetRow } from "./appReviewSheetModel";
import { appReviewRunStyle, appReviewStepStyle } from "./appReviewStatusStyle";
import { useAppReview, type AppReviewData } from "./useAppReview";

type AppReviewSheetTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

/** Every App Review around a thread: runs, their cycles and steps, and the way to launch or stop one. */
export function AppReviewSheet({ route }: StaticScreenProps<AppReviewSheetTarget>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const target = route.params;
  const review = useAppReview(target.environmentId, target.threadId);
  const { commands } = review;
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const rows = buildAppReviewSheetRows({
    runs: review.runs,
    allRuns: review.allRuns,
    headlineRunId: review.headlineRun?.id ?? null,
    records: review.records,
    tickets: review.tickets,
    expanded,
    sessionStatusFor: review.sessionStatusFor,
  });
  const disabled = !commands.canDispatch || commands.busy;

  const toggle = (row: { readonly id: string; readonly expanded: boolean }) => {
    void Haptics.selectionAsync();
    setExpanded((current) => ({ ...current, [row.id]: !row.expanded }));
  };
  const openThread = (threadId: ThreadId) => {
    void Haptics.selectionAsync();
    // The sheet is a leaf: the thread belongs in the workspace stack.
    navigation.dispatch(
      StackActions.replace("Thread", { environmentId: target.environmentId, threadId }),
    );
  };
  const openDocument = (params: { runId: string; cycleNumber: number } | { reviewId: string }) =>
    navigation.dispatch(
      StackActions.push("ThreadAppReviewDocument", {
        environmentId: target.environmentId,
        threadId: target.threadId,
        ...params,
      }),
    );
  const openLaunch = () =>
    navigation.dispatch(
      StackActions.push("ThreadAppReviewLaunch", {
        environmentId: target.environmentId,
        threadId: target.threadId,
      }),
    );
  const confirmStop = (run: AppReviewWorkflowRun) =>
    Dialog.confirm({
      title: "Stop App Review?",
      message:
        "The agent working on it stops and the run ends. Finished cycles keep their results.",
      confirmText: "Stop",
      destructive: true,
      onConfirm: () =>
        void commands.send({
          type: "thread.app-review-workflow.cancel",
          commandId: CommandId.make(uuidv4()),
          threadId: run.controllerThreadId,
          runId: run.id,
          createdAt: new Date().toISOString(),
        }),
    });
  const confirmRerun = (row: Extract<AppReviewSheetRow, { kind: "step" }>) =>
    Dialog.confirm({
      title: `Start ${row.step.title} again?`,
      message: `Cycle ${String(row.cycle.cycleNumber)} keeps the steps before it and discards the ones after.`,
      confirmText: "Start again",
      onConfirm: () =>
        void commands.send({
          type: "thread.app-review-workflow.rerun",
          commandId: CommandId.make(uuidv4()),
          threadId: row.run.controllerThreadId,
          runId: row.run.id,
          phase: row.step.phase,
          createdAt: new Date().toISOString(),
        }),
    });

  const activeRun = review.activeRun;
  const headerActions: AppStackHeaderAction[] = [
    activeRun === null
      ? {
          id: "launch",
          accessibilityLabel: "Launch App Review",
          icon: "play",
          disabled,
          onPress: openLaunch,
        }
      : {
          id: "stop",
          accessibilityLabel: "Stop App Review",
          icon: "stop.fill",
          destructive: true,
          disabled,
          onPress: () => confirmStop(activeRun),
        },
  ];

  const header = (
    <View className="gap-3 pb-3 pt-2">
      {review.error !== null && review.runs.length === 0 ? (
        <ErrorBanner message={review.error} />
      ) : null}
      {commands.error !== null ? <ErrorBanner message={commands.error} /> : null}
      {!commands.canDispatch ? (
        <Text className="text-xs text-foreground-muted">
          This connection can read App Reviews but not launch or stop them.
        </Text>
      ) : null}
      {rows.length === 0 ? (
        <EmptyState
          variant="plain"
          title={review.loading ? "Loading App Reviews…" : "No App Review yet"}
          detail="Run automated acceptance tests and repair the failures they find."
          action={
            review.loading ? undefined : (
              <Button
                tone="primary"
                icon="play"
                label="Launch App Review"
                disabled={disabled}
                onPress={openLaunch}
              />
            )
          }
        />
      ) : null}
    </View>
  );

  return (
    <AppStackSheetFrame
      screenId="thread-app-review-sheet-native"
      title={review.runs.length > 1 ? `App Reviews · ${String(review.runs.length)}` : "App Review"}
      subtitle={review.headlineRun ? appReviewRunStatusLabel(review.headlineRun) : null}
      actions={headerActions}
    >
      <LegendList
        className="flex-1"
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        contentContainerStyle={{
          paddingHorizontal: 20,
          paddingBottom: Math.max(insets.bottom, 16) + 8,
        }}
        data={rows}
        estimatedItemSize={56}
        keyExtractor={(row) => row.id}
        ListHeaderComponent={header}
        recycleItems={false}
        renderItem={({ item }) => (
          <AppReviewSheetRowView
            row={item}
            review={review}
            disabled={disabled}
            onToggle={toggle}
            onOpenThread={openThread}
            onOpenDocument={openDocument}
            onRerun={confirmRerun}
          />
        )}
      />
    </AppStackSheetFrame>
  );
}

function StatusDot(props: { readonly className: string }) {
  return <View className={cn("size-2 shrink-0 rounded-full", props.className)} />;
}

function Disclosure(props: {
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
        <SymbolView
          name={props.expanded ? "chevron.down" : "chevron.right"}
          size={12}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
        {props.children}
      </Pressable>
      {props.trailing}
    </View>
  );
}

function replayLabel(count: number): string {
  return `${String(count)} ${count === 1 ? "replay" : "replays"}`;
}

function AppReviewSheetRowView(props: {
  readonly row: AppReviewSheetRow;
  readonly review: AppReviewData;
  readonly disabled: boolean;
  readonly onToggle: (row: { readonly id: string; readonly expanded: boolean }) => void;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onOpenDocument: (
    params: { runId: string; cycleNumber: number } | { reviewId: string },
  ) => void;
  readonly onRerun: (row: Extract<AppReviewSheetRow, { kind: "step" }>) => void;
}) {
  const { row } = props;
  switch (row.kind) {
    case "run": {
      const style = appReviewRunStyle(row.run.status);
      return (
        <View className="mt-2 border-t border-border pt-2">
          <Disclosure
            expanded={row.expanded}
            label={`${row.label}, ${row.statusLabel}`}
            onPress={() => props.onToggle(row)}
          >
            <StatusDot className={style.dotClassName} />
            <View className="min-w-0 flex-1 gap-0.5">
              <Text numberOfLines={2} className="font-t3-bold text-base text-foreground">
                {row.label}
              </Text>
              <Text numberOfLines={2} className={cn("text-xs", style.textClassName)}>
                {row.statusLabel}
                {row.replayCount > 0 ? ` · ${replayLabel(row.replayCount)}` : ""}
              </Text>
            </View>
          </Disclosure>
        </View>
      );
    }
    case "run-detail":
      return (
        <View className="mb-2 gap-2 rounded-2xl bg-grouped-card px-4 py-3">
          <Text className="text-xs text-foreground-muted">
            {row.run.cyclesUsed} of {row.run.cycleBudget} cycles used
            {row.run.reviewOnly ? " · Review only" : ""}
          </Text>
          <Text className="font-t3-medium text-xs text-foreground">Original brief</Text>
          <Text selectable className="text-sm text-foreground-muted">
            {row.run.briefMarkdown}
          </Text>
          {row.run.failure ? (
            <View className="gap-1 rounded-xl border border-danger/30 bg-danger/5 px-3 py-2">
              <Text className="font-t3-medium text-xs text-danger-foreground">
                {row.run.status === "exhausted" ? "Last cycle" : "Blocked"} ·{" "}
                {row.run.failure.reason}
              </Text>
              <Text selectable className="text-xs text-foreground-muted">
                {row.run.failure.detailMarkdown}
              </Text>
            </View>
          ) : null}
        </View>
      );
    case "cycle": {
      const label = `Cycle ${String(row.cycle.cycleNumber)} of ${String(row.run.cycleBudget)}`;
      return (
        <View className="pl-2">
          <Disclosure
            expanded={row.expanded}
            label={`${label}, ${row.cycle.status}`}
            onPress={() => props.onToggle(row)}
            trailing={
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Open the ${label} review document`}
                hitSlop={8}
                onPress={() =>
                  props.onOpenDocument({ runId: row.run.id, cycleNumber: row.cycle.cycleNumber })
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
            }
          >
            <Text className="font-t3-medium text-sm text-foreground">{label}</Text>
            <Text numberOfLines={1} className="min-w-0 flex-1 text-xs text-foreground-muted">
              {row.cycle.status}
              {row.replayCount > 0 ? ` · ${replayLabel(row.replayCount)}` : ""}
            </Text>
          </Disclosure>
          {row.expanded && row.cycle.failure ? (
            <Text selectable className="pb-1 pl-5 text-xs text-danger-foreground">
              Cycle spent · {row.cycle.failure.reason}: {row.cycle.failure.detailMarkdown}
            </Text>
          ) : null}
        </View>
      );
    }
    case "step":
      return (
        <StepRow
          row={row}
          canDispatch={props.review.commands.canDispatch}
          disabled={props.disabled}
          onOpenThread={props.onOpenThread}
          onRerun={props.onRerun}
        />
      );
    case "heading":
      return (
        <Text className="pb-1 pl-2 pt-4 text-2xs font-t3-bold uppercase tracking-[1px] text-foreground-muted">
          {row.text}
        </Text>
      );
    case "record":
      return (
        <Pressable
          accessibilityRole="button"
          accessibilityHint="Opens this review's document"
          onPress={() => props.onOpenDocument({ reviewId: row.record.id })}
          className="min-h-12 flex-row items-center gap-2 pl-2 active:opacity-70"
        >
          <SymbolView name="doc.text" size={14} tintColorClassName="accent-icon-muted" />
          <Text numberOfLines={1} className="min-w-0 flex-1 text-sm text-foreground">
            {row.record.document.summary || "Browser App Review"}
          </Text>
          <Text className="text-xs text-foreground-muted">{row.record.status}</Text>
        </Pressable>
      );
  }
}

function StepRow(props: {
  readonly row: Extract<AppReviewSheetRow, { kind: "step" }>;
  readonly canDispatch: boolean;
  readonly disabled: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onRerun: (row: Extract<AppReviewSheetRow, { kind: "step" }>) => void;
}) {
  const { step, rerun } = props.row;
  const style = appReviewStepStyle(step.status);
  const threadId = step.threadId;
  const actions: MenuAction[] =
    rerun === null
      ? []
      : [
          {
            id: "rerun",
            title: `Start ${step.title} again`,
            image: "arrow.clockwise",
            ...(rerun.disabledReason === null
              ? {}
              : { subtitle: rerun.disabledReason, attributes: { disabled: true } }),
          },
        ];
  const body = (
    <>
      <Text className="w-5 text-xs tabular-nums text-foreground-muted">{step.number}</Text>
      <StatusDot className={style.dotClassName} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={2} className="text-sm text-foreground">
          {step.title}
        </Text>
        <Text numberOfLines={2} className="text-xs text-foreground-muted">
          {threadId === null ? step.description : `${step.description} Opens ${step.actionLabel}.`}
        </Text>
      </View>
      <Text className={cn("text-xs", style.textClassName)}>
        {APP_REVIEW_CYCLE_STEP_STATUS_LABELS[step.status]}
      </Text>
    </>
  );
  return (
    <View className="flex-row items-center pl-6">
      {threadId === null ? (
        <View className="min-h-12 min-w-0 flex-1 flex-row items-center gap-2 py-2">{body}</View>
      ) : (
        <Pressable
          accessibilityRole="link"
          accessibilityHint={`Opens the ${step.actionLabel}`}
          onPress={() => props.onOpenThread(threadId)}
          className="min-h-12 min-w-0 flex-1 flex-row items-center gap-2 py-2 active:opacity-70"
        >
          {body}
        </Pressable>
      )}
      {props.canDispatch && actions.length > 0 ? (
        <Menu
          title={step.title}
          actions={actions}
          onPressAction={({ nativeEvent }) => {
            void Haptics.selectionAsync();
            if (nativeEvent.event === "rerun") props.onRerun(props.row);
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Actions for ${step.title}`}
            disabled={props.disabled}
            hitSlop={8}
            className="size-9 items-center justify-center rounded-full active:bg-subtle"
            style={{ opacity: props.disabled ? 0.45 : 1 }}
          >
            <SymbolView
              name="ellipsis.circle"
              size={18}
              tintColorClassName="accent-icon-muted"
              type="monochrome"
            />
          </Pressable>
        </Menu>
      ) : null}
    </View>
  );
}
