import { LegendList } from "@legendapp/list/react-native";
import type { StaticScreenProps } from "@react-navigation/native";
import {
  buildAssociatedStackPodLogsResult,
  buildStackPodLogViews,
  displayStackName,
  formatAllStackPodLogsForClipboard,
  stackPodLogOwnerLabel,
} from "@t3tools/client-runtime/app-stack-logs";
import { EnvironmentId, type AppStackPodLogEntry } from "@t3tools/contracts";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppState, Platform, Pressable, type TextInputInstance, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../components/ui/Dialog";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Notice } from "../../components/ui/Notice";
import { SearchField } from "../../components/ui/SearchField";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { tryCopyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import { appStackEnvironment } from "../../state/appStacks";
import { useEnvironmentQuery } from "../../state/query";
import { AppStackSheetFrame } from "./AppStackSheetFrame";
import {
  APP_STACK_LOG_TAIL_OPTIONS,
  type AppStackLogListItem,
  appStackLogListItems,
} from "./appStackPresentation";

const AUTO_REFRESH_INTERVAL_MS = 5_000;
const TAIL_OPTIONS = APP_STACK_LOG_TAIL_OPTIONS.map((value) => ({
  value,
  label: value >= 1000 ? `${value / 1000}k` : String(value),
  accessibilityLabel: `${value} lines`,
}));

type TailLines = (typeof APP_STACK_LOG_TAIL_OPTIONS)[number];

export function AppStackLogsScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: string;
  readonly threadId: string;
  readonly stackId: string;
}>) {
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const stackId = route.params.stackId;
  const [tailLines, setTailLines] = useState<TailLines>(300);
  const [search, setSearch] = useState("");
  const [hideEmpty, setHideEmpty] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set());
  const searchRef = useRef<TextInputInstance>(null);

  const stackQuery = useEnvironmentQuery(
    appStackEnvironment.get({ environmentId, input: { stackId } }),
  );
  const logsQuery = useEnvironmentQuery(
    appStackEnvironment.getStackPodLogs({ environmentId, input: { stackId, tailLines } }),
  );
  const stack = stackQuery.data;
  const refreshStack = stackQuery.refresh;
  const refreshLogs = logsQuery.refresh;
  const refresh = useCallback(() => {
    refreshStack();
    refreshLogs();
  }, [refreshLogs, refreshStack]);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refreshLogs();
    });
    return () => subscription.remove();
  }, [refreshLogs]);
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      if (AppState.currentState === "active") refreshLogs();
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [autoRefresh, refreshLogs]);

  const result = useMemo(
    () =>
      stack && logsQuery.data
        ? buildAssociatedStackPodLogsResult({
            stack,
            result: logsQuery.data,
            limit: { mode: "tail", tailLines },
          })
        : null,
    [logsQuery.data, stack, tailLines],
  );
  const view = useMemo(
    () => buildStackPodLogViews(result?.stacks ?? [], { search, hideEmpty })[0] ?? null,
    [hideEmpty, result, search],
  );
  // A search shows every match, so collapsed services open while it is active.
  const searching = search.trim().length > 0;
  const items = appStackLogListItems(view?.serviceGroups ?? [], searching ? new Set() : collapsed);
  const toggleService = (serviceKey: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(serviceKey)) next.delete(serviceKey);
      else next.add(serviceKey);
      return next;
    });
  const copyAll = () => {
    if (result === null) return;
    void tryCopyTextWithHaptic(formatAllStackPodLogsForClipboard({ result }), {
      target: "app stack logs",
    }).then((copied) => {
      if (!copied) Dialog.alert("Could not copy", "Try again.");
    });
  };

  const error = logsQuery.error ?? stackQuery.error;
  const loading = result === null && error === null;
  const header = (
    <View className="gap-3 px-2 pb-3">
      <SegmentedControl
        options={TAIL_OPTIONS}
        selected={tailLines}
        onSelect={setTailLines}
        size="compact"
      />
      <View className="flex-row">
        <SearchField
          inputRef={searchRef}
          autoFocus={false}
          accessibilityLabel="Filter logs"
          clearAccessibilityLabel="Clear log filter"
          placeholder="Filter pods, containers, lines"
          value={search}
          onChangeText={setSearch}
        />
      </View>
      <View className="overflow-hidden rounded-2xl bg-grouped-card">
        <ListToggleRow
          label="Hide empty containers"
          value={hideEmpty}
          onValueChange={setHideEmpty}
        />
        <ListToggleRow
          label="Auto-refresh"
          description="Every 5 seconds while open"
          value={autoRefresh}
          onValueChange={setAutoRefresh}
        />
      </View>
      {view ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {[
            `${view.podCount} ${view.podCount === 1 ? "pod" : "pods"}`,
            `${view.containerCount} ${view.containerCount === 1 ? "container" : "containers"}`,
            view.errorCount > 0 ? `${view.errorCount} with errors` : null,
            `fetched ${new Date(view.stack.fetchedAt).toLocaleTimeString()}`,
          ]
            .filter(Boolean)
            .join(" · ")}
        </Text>
      ) : null}
      {error !== null ? (
        <Notice tone="danger" icon="exclamationmark.triangle" message={error} />
      ) : null}
    </View>
  );

  return (
    <AppStackSheetFrame
      screenId="thread-app-stack-logs-native"
      title="Logs"
      subtitle={stack ? displayStackName(stack) : null}
      actions={[
        {
          id: "copy",
          accessibilityLabel: "Copy all logs",
          icon: "doc.on.doc",
          disabled: result === null,
          onPress: copyAll,
        },
        {
          id: "refresh",
          accessibilityLabel: "Refresh logs",
          icon: "arrow.clockwise",
          onPress: refresh,
        },
      ]}
    >
      <LegendList
        data={items}
        keyExtractor={(item) => item.key}
        extraData={toggleService}
        getItemType={(item) => item.kind}
        renderItem={({ item }) => <LogListRow item={item} onToggleService={toggleService} />}
        estimatedItemSize={160}
        recycleItems
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        keyboardDismissMode="on-drag"
        keyboardShouldPersistTaps="handled"
        contentContainerStyle={{
          paddingTop: 8,
          paddingBottom: Math.max(insets.bottom, 16) + 16,
          paddingHorizontal: Platform.OS === "android" ? 8 : 16,
        }}
        ListHeaderComponent={header}
        ListEmptyComponent={
          loading ? (
            <View className="items-center py-10">
              <AppActivityIndicator />
            </View>
          ) : error === null ? (
            <Text className="pt-6 text-center text-sm text-foreground-muted">
              {searching ? "No logs match the filter." : "No containers returned logs."}
            </Text>
          ) : null
        }
      />
    </AppStackSheetFrame>
  );
}

function LogListRow(props: {
  readonly item: AppStackLogListItem;
  readonly onToggleService: (serviceKey: string) => void;
}) {
  const { item } = props;
  if (item.kind === "service") {
    const { group } = item;
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: !item.collapsed }}
        accessibilityLabel={`${group.serviceName}, ${group.entryCount} containers`}
        onPress={() => props.onToggleService(group.serviceKey)}
        className="flex-row items-center gap-2 px-2 pt-4 pb-2 active:opacity-70"
      >
        <SymbolView
          name={item.collapsed ? "chevron.right" : "chevron.down"}
          size={12}
          tintColorClassName="accent-foreground-muted"
        />
        <Text textRole="footnote" className="flex-1 font-t3-medium text-foreground-muted">
          {group.serviceName}
        </Text>
        <Text textRole="footnote" className="tabular-nums text-foreground-muted">
          {group.errorCount > 0 ? `${group.errorCount} errors · ` : ""}
          {group.entryCount}
        </Text>
      </Pressable>
    );
  }
  return <ContainerLogBlock entry={item.entry} />;
}

function ContainerLogBlock(props: { readonly entry: AppStackPodLogEntry }) {
  const { entry } = props;
  const owner = stackPodLogOwnerLabel(entry);
  const meta = [
    entry.phase,
    entry.ready ? "ready" : "not ready",
    entry.restartCount === 1 ? "1 restart" : `${entry.restartCount} restarts`,
    entry.state,
    owner,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <View className="mb-2 overflow-hidden rounded-2xl bg-grouped-card">
      <View className="gap-0.5 border-b border-border-subtle px-3 py-2">
        <Text textRole="footnote" className="font-t3-medium text-foreground" numberOfLines={1}>
          {entry.podName} / {entry.containerName}
        </Text>
        <Text className="text-2xs text-foreground-muted" numberOfLines={2}>
          {meta}
        </Text>
        {entry.error ? (
          <Text className="text-2xs text-danger-foreground">{entry.error}</Text>
        ) : null}
      </View>
      <Text selectable className="px-3 py-2 font-mono text-2xs leading-normal text-foreground">
        {entry.logs.trimEnd().length > 0 ? entry.logs.trimEnd() : "No log lines returned."}
      </Text>
    </View>
  );
}
