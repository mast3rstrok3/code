import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { displayStackName } from "@t3tools/client-runtime/app-stack-logs";
import {
  appStackBundleApps,
  appStackPlatformMembers,
  appStackProtectionAction,
  isProtectedAppStack,
  isTransitioningAppStackStatus,
  previewUrlForService,
  primaryPreviewForStack,
} from "@t3tools/client-runtime/app-stack-panel";
import { type AppStack, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { appStackVariantForComposePath } from "@t3tools/shared/appStack";
import { useCallback } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { Notice } from "../../components/ui/Notice";
import { cn } from "../../lib/cn";
import { appStackEnvironment } from "../../state/appStacks";
import { useEnvironmentQuery } from "../../state/query";
import { useThreadSelection } from "../../state/use-thread-selection";
import { AppStackSheetFrame } from "./AppStackSheetFrame";
import {
  APP_STACK_TONE_DOT_CLASS,
  appStackLifecycle,
  appStackStatusLabel,
  appStackTone,
} from "./appStackPresentation";
import { type AppStackActions, useAppStackActions } from "./useAppStackActions";
import {
  threadAppStackPath,
  useAppStackBackend,
  useAppStackForWorktree,
  useAppStackRefresh,
} from "./useAppStackQueries";

type AppStackSheetParams = {
  readonly environmentId: string;
  readonly threadId: string;
  /** Set when opened from the stack list; otherwise the sheet shows the thread's stack. */
  readonly stackId?: string;
};

export function AppStackSheet({ route }: StaticScreenProps<AppStackSheetParams>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentId = EnvironmentId.make(route.params.environmentId);
  const threadId = ThreadId.make(route.params.threadId);
  const stackId = route.params.stackId ?? null;
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const worktreePath =
    stackId === null
      ? threadAppStackPath({
          worktreePath: selectedThread?.worktreePath,
          workspaceRoot: selectedThreadProject?.workspaceRoot,
        })
      : null;
  const backend = useAppStackBackend(environmentId);
  const lookup = useAppStackForWorktree({ environmentId, worktreePath, enabled: backend.enabled });
  const byId = useEnvironmentQuery(
    backend.enabled && stackId !== null
      ? appStackEnvironment.get({ environmentId, input: { stackId } })
      : null,
  );
  const stack = stackId === null ? (lookup.data?.stack ?? null) : byId.data;
  // The list carries the bundle siblings and a platform record's members.
  const list = useEnvironmentQuery(
    backend.enabled && stack !== null && (stack.bundleId != null || stack.platform === true)
      ? appStackEnvironment.list({ environmentId, input: {} })
      : null,
  );
  const plan = useEnvironmentQuery(
    backend.enabled && stackId === null && worktreePath !== null && lookup.isSuccess && !stack
      ? appStackEnvironment.bundlePlan({
          environmentId,
          input: { worktreePath, gitBranch: selectedThread?.branch ?? null, variant: "dev" },
        })
      : null,
  );
  const refreshBackend = backend.refresh;
  const refreshLookup = lookup.refresh;
  const refreshById = byId.refresh;
  const refreshList = list.refresh;
  const refresh = useCallback(() => {
    refreshBackend();
    refreshLookup();
    refreshById();
    refreshList();
  }, [refreshBackend, refreshById, refreshList, refreshLookup]);
  useAppStackRefresh(refresh, stack !== null && isTransitioningAppStackStatus(stack.status));
  const actions = useAppStackActions({
    environmentId,
    threadId,
    branch: selectedThread?.branch ?? null,
    serverBrowser:
      selectedEnvironmentRuntime?.serverConfig?.environment.capabilities.serverBrowser === true,
    onChanged: refresh,
  });
  const openLogs = (target: AppStack) =>
    navigation.navigate("ThreadAppStackLogs", {
      environmentId: route.params.environmentId,
      threadId: route.params.threadId,
      stackId: target.id,
    });
  const openList = () =>
    navigation.dispatch(
      StackActions.push("ThreadAppStacks", {
        environmentId: route.params.environmentId,
        threadId: route.params.threadId,
      }),
    );

  const queryError = backend.error ?? (stackId === null ? lookup.error : byId.error);
  const loading =
    (backend.isPending && backend.data === null) ||
    (backend.enabled &&
      (stackId === null ? lookup.isPending && lookup.data === null : byId.isPending && !stack));

  const body = (() => {
    if (loading) {
      return (
        <View className="items-center py-10">
          <AppActivityIndicator />
        </View>
      );
    }
    if (backend.data?.enabled === false) {
      return (
        <EmptyState
          variant="plain"
          title="App Stacks are off"
          detail="This environment has no App Stack controller configured."
        />
      );
    }
    if (queryError !== null && stack === null) {
      return <Notice tone="danger" icon="exclamationmark.triangle" message={queryError} />;
    }
    if (stack === null) {
      return (
        <NewStackState
          worktreePath={worktreePath}
          pending={worktreePath !== null && actions.pending.has(`create:${worktreePath}`)}
          canManage={actions.canManage}
          onStart={() => {
            if (worktreePath !== null) void actions.startNew(worktreePath, plan.data);
          }}
          onOpenList={openList}
        />
      );
    }
    return (
      <StackDetail
        stack={stack}
        listedStacks={list.data?.stacks ?? []}
        isCurrent={stackId === null}
        actions={actions}
        onOpenLogs={openLogs}
        onOpenList={openList}
        onDeleted={() => {
          if (stackId !== null) navigation.goBack();
        }}
      />
    );
  })();

  return (
    <AppStackSheetFrame
      screenId="thread-app-stack-sheet-native"
      title={stack ? displayStackName(stack) : "App Stack"}
      actions={[
        {
          id: "refresh",
          accessibilityLabel: "Refresh App Stack",
          icon: "arrow.clockwise",
          onPress: refresh,
        },
      ]}
    >
      <ScrollView
        nestedScrollEnabled
        className="flex-1"
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        contentContainerStyle={{
          paddingBottom: Math.max(insets.bottom, 16) + 16,
          paddingHorizontal: Platform.OS === "android" ? 8 : 20,
          paddingTop: 8,
          gap: Platform.OS === "android" ? 8 : 14,
        }}
      >
        {actions.error ? (
          <Notice
            tone="danger"
            icon="exclamationmark.triangle"
            message={actions.error}
            onDismiss={actions.dismissError}
          />
        ) : null}
        {actions.notice ? (
          <Notice
            icon="info.circle"
            message={actions.notice.message}
            onDismiss={actions.dismissNotice}
          />
        ) : null}
        {body}
      </ScrollView>
    </AppStackSheetFrame>
  );
}

function NewStackState(props: {
  readonly worktreePath: string | null;
  readonly pending: boolean;
  readonly canManage: boolean;
  readonly onStart: () => void;
  readonly onOpenList: () => void;
}) {
  return (
    <>
      <EmptyState
        variant="plain"
        title="No App Stack"
        detail={
          props.worktreePath === null
            ? "This thread has no worktree to deploy."
            : `Nothing is deployed for ${props.worktreePath}.`
        }
        action={
          props.worktreePath === null ? undefined : (
            <Button
              tone="primary"
              icon="play"
              label="Start App Stack"
              loading={props.pending}
              disabled={!props.canManage}
              accessibilityHint={
                props.canManage ? undefined : "This connection cannot manage App Stacks."
              }
              onPress={props.onStart}
            />
          )
        }
      />
      <ListSection>
        <ListRow
          icon="server.rack"
          label="All App Stacks"
          description="Every stack in this environment"
          onPress={props.onOpenList}
        />
      </ListSection>
    </>
  );
}

function StackDetail(props: {
  readonly stack: AppStack;
  readonly listedStacks: ReadonlyArray<AppStack>;
  readonly isCurrent: boolean;
  readonly actions: AppStackActions;
  readonly onOpenLogs: (stack: AppStack) => void;
  readonly onOpenList: () => void;
  readonly onDeleted: () => void;
}) {
  const { stack, actions } = props;
  const pending = actions.pending.get(stack.id);
  const busy = pending !== undefined || !actions.canManage;
  const lifecycle = appStackLifecycle(stack);
  const preview = primaryPreviewForStack(stack);
  const isPlatform = stack.platform === true;
  const bundleApps = appStackBundleApps(stack, props.listedStacks);
  const variant = stack.variant ?? appStackVariantForComposePath(stack.composePath);
  const summary = [
    [stack.repoName, stack.branchName].filter(Boolean).join(" · ") || null,
    isPlatform ? "Platform" : (stack.namespace ?? "Namespace pending"),
    bundleApps ? `Bundle ${bundleApps.join(" + ")}` : null,
    variant === "prod" ? "Production build" : null,
    stack.workflowId ? "Workflow-owned" : null,
  ]
    .filter(Boolean)
    .join("\n");
  const tone = appStackTone(stack.status);
  const manageHint = actions.canManage ? undefined : "This connection cannot manage App Stacks.";

  return (
    <>
      <ListSection>
        <View className="gap-1.5 px-4 py-3">
          <View className="flex-row items-center gap-2">
            <View className={cn("size-2 rounded-full", APP_STACK_TONE_DOT_CLASS[tone])} />
            <Text textRole="body" className="font-t3-medium text-foreground">
              {appStackStatusLabel(stack.status)}
            </Text>
            {isProtectedAppStack(stack) ? (
              <Text textRole="footnote" className="text-foreground-muted">
                · Protected
              </Text>
            ) : null}
          </View>
          {summary ? (
            <Text selectable textRole="footnote" className="text-foreground-muted">
              {summary}
            </Text>
          ) : null}
        </View>
      </ListSection>

      {stack.lastError ? (
        <Notice tone="danger" icon="exclamationmark.triangle" message={stack.lastError} />
      ) : null}

      {preview ? (
        <ListSection title="Preview">
          <ListRow
            icon="globe"
            label={`Open ${preview.serviceName}`}
            description={preview.url}
            onPress={() => void actions.openUrl(preview.url)}
          />
          <ListRow
            icon="safari"
            label="Open in system browser"
            onPress={() => actions.openExternal(preview.url)}
          />
        </ListSection>
      ) : null}

      {isPlatform ? (
        <PlatformApps
          members={appStackPlatformMembers(stack, props.listedStacks)}
          onOpenUrl={(url) => void actions.openUrl(url)}
        />
      ) : (
        <StackServices stack={stack} onOpenUrl={(url) => void actions.openUrl(url)} />
      )}

      <ListSection title="Manage" footer={manageHint}>
        {lifecycle.start !== null ? (
          <ListActionRow
            icon="play"
            label="Start"
            description={
              lifecycle.start === "restart" ? "Starts the whole bundle again" : undefined
            }
            loading={pending === "start"}
            disabled={busy}
            onPress={() => void actions.start(stack)}
          />
        ) : (
          <ListActionRow
            icon="arrow.clockwise"
            label="Restart"
            loading={pending === "restart"}
            disabled={busy}
            onPress={() => actions.restart(stack)}
          />
        )}
        {lifecycle.canStop ? (
          <ListActionRow
            icon="stop.fill"
            label="Stop"
            loading={pending === "stop"}
            disabled={busy}
            onPress={() => actions.confirmStop(stack)}
          />
        ) : null}
        <ListToggleRow
          icon="exclamationmark.shield"
          label="Protected"
          description="Survives workflow teardown and is shed last under memory pressure"
          value={isProtectedAppStack(stack)}
          disabled={busy}
          onValueChange={(next) => {
            if (next === appStackProtectionAction(stack).nextProtected)
              actions.toggleProtection(stack);
          }}
        />
        {isPlatform ? null : (
          <ListRow
            icon="doc.text"
            label="Logs"
            description="Pod logs by service"
            onPress={() => props.onOpenLogs(stack)}
          />
        )}
        <ListActionRow
          icon="trash"
          tone="danger"
          label="Delete"
          description="Removes the Kubernetes namespace"
          loading={pending === "delete"}
          disabled={busy}
          onPress={() => actions.confirmDelete(stack, props.onDeleted)}
        />
      </ListSection>

      {props.isCurrent ? (
        <ListSection>
          <ListRow
            icon="server.rack"
            label="All App Stacks"
            description="Every stack in this environment"
            onPress={props.onOpenList}
          />
        </ListSection>
      ) : null}

      <ListSection title="Worktree">
        <Text selectable textRole="footnote" className="p-4 text-foreground-muted">
          {stack.worktreePath}
        </Text>
      </ListSection>
    </>
  );
}

function StackServices(props: {
  readonly stack: AppStack;
  readonly onOpenUrl: (url: string) => void;
}) {
  const services = props.stack.services ?? [];
  return (
    <ListSection title="Services">
      {services.length === 0 ? (
        <Text textRole="footnote" className="p-4 text-foreground-muted">
          No services reported.
        </Text>
      ) : (
        services.map((service) => {
          const url = previewUrlForService(service, props.stack);
          const description = [
            service.status,
            service.containerPort ? `:${service.containerPort}` : null,
            service.health ?? null,
          ]
            .filter(Boolean)
            .join(" · ");
          return url === null ? (
            <View key={service.name} className="gap-1 px-4 py-3">
              <Text textRole="body" className="text-foreground">
                {service.name}
              </Text>
              <Text textRole="footnote" className="text-foreground-muted">
                {service.error ? `${description}\n${service.error}` : description}
              </Text>
            </View>
          ) : (
            <ListRow
              key={service.name}
              label={service.name}
              description={description}
              detail={url.replace(/^https?:\/\//u, "")}
              onPress={() => props.onOpenUrl(url)}
            />
          );
        })
      )}
    </ListSection>
  );
}

function PlatformApps(props: {
  readonly members: ReadonlyArray<AppStack>;
  readonly onOpenUrl: (url: string) => void;
}) {
  return (
    <ListSection title="Apps">
      {props.members.length === 0 ? (
        <Text textRole="footnote" className="p-4 text-foreground-muted">
          No apps reported.
        </Text>
      ) : (
        props.members.map((member) => {
          const preview = primaryPreviewForStack(member);
          const label = member.app ?? member.id;
          const description = `${appStackStatusLabel(member.status)} · ${member.namespace ?? "namespace pending"}`;
          return preview === null ? (
            <View key={member.id} className="gap-1 px-4 py-3">
              <Text textRole="body" className="text-foreground">
                {label}
              </Text>
              <Text textRole="footnote" className="text-foreground-muted">
                {description}
              </Text>
            </View>
          ) : (
            <ListRow
              key={member.id}
              label={label}
              description={description}
              onPress={() => props.onOpenUrl(preview.url)}
            />
          );
        })
      )}
    </ListSection>
  );
}
