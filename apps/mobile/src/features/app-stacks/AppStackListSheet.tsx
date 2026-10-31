import { LegendList } from "@legendapp/list/react-native";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  displayStackName,
  normalizeStackWorktreePath,
} from "@t3tools/client-runtime/app-stack-logs";
import {
  isProtectedAppStack,
  orderAppStacksForPanel,
  reconcileAppStackIds,
  shouldPollAppStacks,
} from "@t3tools/client-runtime/app-stack-panel";
import { type AppStack, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useCallback, useMemo, useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { SymbolView } from "../../components/ui/AppSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { Notice } from "../../components/ui/Notice";
import { cn } from "../../lib/cn";
import { appStackEnvironment } from "../../state/appStacks";
import { useEnvironmentQuery } from "../../state/query";
import { useThreadSelection } from "../../state/use-thread-selection";
import { AppStackSheetFrame } from "./AppStackSheetFrame";
import {
  APP_STACK_TONE_DOT_CLASS,
  appStackStatusLabel,
  appStackTone,
} from "./appStackPresentation";
import { useAppStackActions } from "./useAppStackActions";
import { threadAppStackPath, useAppStackBackend, useAppStackRefresh } from "./useAppStackQueries";

export function AppStackListSheet({
  route,
}: StaticScreenProps<{ readonly environmentId: string; readonly threadId: string }>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const currentPath = threadAppStackPath({
    worktreePath: selectedThread?.worktreePath,
    workspaceRoot: selectedThreadProject?.workspaceRoot,
  });
  const backend = useAppStackBackend(environmentId);
  const list = useEnvironmentQuery(
    backend.enabled ? appStackEnvironment.list({ environmentId, input: {} }) : null,
  );
  const listedStacks = list.data?.stacks;
  const stacks = useMemo(
    () =>
      orderAppStacksForPanel({
        currentStack: null,
        listedStacks: listedStacks ?? [],
        currentWorktreePath: currentPath ?? "",
      }),
    [currentPath, listedStacks],
  );
  const refreshList = list.refresh;
  const refresh = useCallback(() => refreshList(), [refreshList]);
  useAppStackRefresh(refresh, shouldPollAppStacks(null, stacks));
  const actions = useAppStackActions({
    environmentId,
    threadId: ThreadId.make(route.params.threadId),
    branch: selectedThread?.branch ?? null,
    serverBrowser:
      selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.serverBrowser === true,
    onChanged: refresh,
  });
  const [selecting, setSelecting] = useState(false);
  const [selectedIds, setSelectedIds] = useState<ReadonlySet<string>>(() => new Set());
  // A stack another client deleted drops out of the selection.
  const selection = useMemo(() => reconcileAppStackIds(selectedIds, stacks), [selectedIds, stacks]);
  const selectedStacks = stacks.filter((stack) => selection.has(stack.id));
  const deleting = selectedStacks.some((stack) => actions.pending.get(stack.id) === "delete");

  const toggleSelected = useCallback((stackId: string) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(stackId)) next.delete(stackId);
      else next.add(stackId);
      return next;
    });
  }, []);
  const openStack = useCallback(
    (stack: AppStack) =>
      navigation.dispatch(
        StackActions.push("ThreadAppStack", {
          environmentId: route.params.environmentId,
          threadId: route.params.threadId,
          stackId: stack.id,
        }),
      ),
    [navigation, route.params.environmentId, route.params.threadId],
  );
  const rowInputs = useMemo(
    () => ({ selecting, selection, pending: actions.pending }),
    [actions.pending, selecting, selection],
  );

  const header = (
    <View className="gap-3 px-2 pb-2">
      {actions.error ? (
        <Notice
          tone="danger"
          icon="exclamationmark.triangle"
          message={actions.error}
          onDismiss={actions.dismissError}
        />
      ) : null}
      {list.error ? (
        <Notice tone="danger" icon="exclamationmark.triangle" message={list.error} />
      ) : null}
      {selecting ? (
        <Button
          tone="danger"
          icon="trash"
          label={
            selectedStacks.length === 0
              ? "Select stacks to delete"
              : `Delete ${selectedStacks.length} ${selectedStacks.length === 1 ? "stack" : "stacks"}`
          }
          loading={deleting}
          disabled={selectedStacks.length === 0 || !actions.canManage}
          onPress={() =>
            actions.confirmBulkDelete(selectedStacks, (failed) => {
              setSelectedIds(failed);
              if (failed.size === 0) setSelecting(false);
            })
          }
        />
      ) : stacks.length > 0 ? (
        <Text textRole="footnote" className="px-2 text-foreground-muted">
          {stacks.length} {stacks.length === 1 ? "stack" : "stacks"}
        </Text>
      ) : null}
    </View>
  );

  return (
    <AppStackSheetFrame
      screenId="thread-app-stacks-sheet-native"
      title="App Stacks"
      actions={[
        selecting
          ? {
              id: "done",
              accessibilityLabel: "Finish selecting",
              icon: "checkmark",
              onPress: () => {
                setSelecting(false);
                setSelectedIds(new Set());
              },
            }
          : {
              id: "select",
              accessibilityLabel: "Select stacks to delete",
              icon: "checkmark.circle",
              disabled: stacks.length === 0 || !actions.canManage,
              onPress: () => setSelecting(true),
            },
      ]}
    >
      <LegendList
        data={stacks}
        keyExtractor={(stack) => stack.id}
        extraData={rowInputs}
        renderItem={({ item }) => (
          <AppStackListRow
            stack={item}
            current={normalizeStackWorktreePath(item.worktreePath) === currentPath}
            selecting={selecting}
            selected={selection.has(item.id)}
            pending={actions.pending.has(item.id)}
            onPress={selecting ? () => toggleSelected(item.id) : () => openStack(item)}
          />
        )}
        estimatedItemSize={72}
        recycleItems
        style={{ flex: 1 }}
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        contentContainerStyle={{
          paddingTop: 8,
          paddingBottom: Math.max(insets.bottom, 16) + 16,
          paddingHorizontal: Platform.OS === "android" ? 8 : 16,
        }}
        ListHeaderComponent={header}
        ListEmptyComponent={
          (backend.isPending && backend.data === null) || (list.isPending && !list.data) ? (
            <View className="items-center py-10">
              <AppActivityIndicator />
            </View>
          ) : (
            <Text className="pt-6 text-center text-sm text-foreground-muted">
              {backend.data?.enabled === false
                ? "App Stacks are off in this environment."
                : "No App Stacks."}
            </Text>
          )
        }
      />
    </AppStackSheetFrame>
  );
}

function AppStackListRow(props: {
  readonly stack: AppStack;
  readonly current: boolean;
  readonly selecting: boolean;
  readonly selected: boolean;
  readonly pending: boolean;
  readonly onPress: () => void;
}) {
  const { stack } = props;
  const name = displayStackName(stack);
  const detail = [
    props.current ? "This thread" : null,
    stack.branchName ?? null,
    stack.platform === true ? "Platform" : (stack.namespace ?? null),
    isProtectedAppStack(stack) ? "Protected" : null,
  ]
    .filter(Boolean)
    .join(" · ");
  return (
    <Pressable
      accessibilityRole={props.selecting ? "checkbox" : "button"}
      accessibilityState={props.selecting ? { checked: props.selected } : { busy: props.pending }}
      accessibilityLabel={`${name}, ${stack.status}${detail ? `, ${detail}` : ""}`}
      onPress={props.onPress}
      className="mb-2 flex-row items-center gap-3 rounded-2xl bg-grouped-card px-4 py-3 active:opacity-70"
    >
      {props.selecting ? (
        <SymbolView
          name={props.selected ? "checkmark.circle.fill" : "circle"}
          size={20}
          tintColorClassName={props.selected ? "accent-primary-text" : "accent-icon-subtle"}
        />
      ) : null}
      <View className="min-w-0 flex-1 gap-1">
        <Text textRole="body" className="text-foreground" numberOfLines={1}>
          {name}
        </Text>
        <View className="flex-row items-center gap-1.5">
          <View
            className={cn(
              "size-1.5 rounded-full",
              APP_STACK_TONE_DOT_CLASS[appStackTone(stack.status)],
            )}
          />
          <Text textRole="footnote" className="shrink text-foreground-muted" numberOfLines={1}>
            {appStackStatusLabel(stack.status)}
            {detail ? ` · ${detail}` : ""}
          </Text>
        </View>
      </View>
      {props.pending ? (
        <AppActivityIndicator size="small" />
      ) : props.selecting ? null : (
        <SymbolView name="chevron.right" size={12} tintColorClassName="accent-icon-subtle" />
      )}
    </Pressable>
  );
}
