import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  appReviewSupportingContext,
  appReviewWorkflowLaunchCommand,
  isValidAppReviewWorkflowLaunch,
  normalizeAppReviewPreviewTarget,
} from "@t3tools/client-runtime/app-review";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  APP_REVIEW_WORKFLOW_DEFAULT_CYCLES,
  APP_REVIEW_WORKFLOW_MAX_CYCLES,
  CommandId,
  ThreadId,
  type EnvironmentId,
} from "@t3tools/contracts";
import { extractPreviewUrls } from "@t3tools/shared/preview";
import { useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ListSection } from "../../components/ui/ListSection";
import { ListToggleRow } from "../../components/ui/ListToggleRow";
import { NumberField } from "../../components/ui/NumberField";
import { uuidv4 } from "../../lib/uuid";
import { useThreadShell } from "../../state/entities";
import { useThreadProjection } from "../../state/use-thread-detail";
import { AppStackSheetFrame } from "../app-stacks/AppStackSheetFrame";
import { useWorkflowCommands } from "../workflows/useWorkflowRun";

type AppReviewLaunchTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

/** The web launch dialog as a form: a brief, whether to repair, how many cycles, and what to drive. */
export function AppReviewLaunchSheet({ route }: StaticScreenProps<AppReviewLaunchTarget>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const target = route.params;
  const shell = useThreadShell(target);
  const projection = useThreadProjection(target);
  const commands = useWorkflowCommands(target.environmentId, target.threadId);
  const [brief, setBrief] = useState("");
  const [reviewUrl, setReviewUrl] = useState("");
  const [reviewOnly, setReviewOnly] = useState(false);
  const [cycleBudget, setCycleBudget] = useState(APP_REVIEW_WORKFLOW_DEFAULT_CYCLES);
  const normalizedBrief = brief.trim();
  const pinnedTarget = normalizeAppReviewPreviewTarget(reviewUrl);
  const sourceSettled = shell !== null && !threadRuntimeIsActive(shell.runtime);
  const valid = isValidAppReviewWorkflowLaunch({
    brief: normalizedBrief,
    cycleBudget,
    sourceSettled,
    worktreeOwned: !commands.canDispatch || shell === null,
  });
  const briefTargets = pinnedTarget === null ? extractPreviewUrls(normalizedBrief) : [];

  const launch = async () => {
    if (shell === null || !valid) return;
    const launched = await commands.send(
      appReviewWorkflowLaunchCommand({
        request: { brief: normalizedBrief, cycleBudget, reviewUrl, reviewOnly },
        commandId: CommandId.make(uuidv4()),
        targetThreadId: target.threadId,
        controllerThreadId: ThreadId.make(uuidv4()),
        supportingContextMarkdown: appReviewSupportingContext(
          projection?.projection.messages ?? [],
        ),
        modelSelection: shell.modelSelection,
        createdAt: new Date().toISOString(),
      }),
    );
    if (launched) navigation.goBack();
  };

  return (
    <AppStackSheetFrame screenId="thread-app-review-launch-native" title="Launch App Review">
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        automaticallyAdjustKeyboardInsets
        contentContainerClassName="gap-5 px-5 pt-2"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 16 }}
      >
        <Text className="text-sm text-foreground-muted">
          Each cycle reviews the app, turns what it finds into repair tickets, then implements them
          in a new thread. Only review stops after the gap analysis.
        </Text>
        {commands.error !== null ? <ErrorBanner message={commands.error} /> : null}
        <View className="gap-2">
          <Text className="px-1 font-t3-medium text-sm text-foreground">Review brief</Text>
          <TextInput
            multiline
            autoFocus
            accessibilityLabel="Review brief"
            value={brief}
            onChangeText={setBrief}
            placeholder="Verify the login flow, including validation, loading, and failed submissions."
            textAlignVertical="top"
            className="min-h-28 rounded-xl bg-subtle px-4 py-3 text-base"
          />
        </View>
        <ListSection
          footer={
            reviewOnly
              ? "One review and the gap analysis that tickets what it finds, then stop. Nothing is repaired."
              : `Each cycle is one review, the repair tickets it writes, and the fix. A passing review ends the run early.`
          }
        >
          <ListToggleRow label="Only review" value={reviewOnly} onValueChange={setReviewOnly} />
          {reviewOnly ? null : (
            <View className="border-t border-border-subtle px-4 py-3">
              <NumberField
                label="Cycles"
                min={1}
                max={APP_REVIEW_WORKFLOW_MAX_CYCLES}
                value={cycleBudget}
                onValueChange={setCycleBudget}
              />
            </View>
          )}
        </ListSection>
        <View className="gap-2">
          <Text className="px-1 font-t3-medium text-sm text-foreground">Review URL</Text>
          <TextInput
            accessibilityLabel="Review URL"
            value={reviewUrl}
            onChangeText={setReviewUrl}
            placeholder="localhost:5173"
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            className="rounded-xl bg-subtle px-4 py-3 text-base"
          />
          <Text className="px-1 text-xs text-foreground-muted">
            {pinnedTarget === null
              ? "Leave empty to resolve this worktree's App Stack when the review starts."
              : `Reviews ${pinnedTarget} as given, without resolving an App Stack.`}
          </Text>
          {briefTargets.length > 0 ? (
            <Text className="px-1 text-xs text-foreground-muted">
              The brief also names {briefTargets.join(", ")}.
            </Text>
          ) : null}
        </View>
        {shell !== null && !sourceSettled ? (
          <Text className="text-sm text-danger-foreground">
            Wait for this thread's current turn to finish.
          </Text>
        ) : null}
        {!commands.canDispatch ? (
          <Text className="text-sm text-foreground-muted">
            This connection cannot launch App Reviews.
          </Text>
        ) : null}
        <Button
          tone="primary"
          icon="play"
          label="Launch App Review"
          fullWidth
          loading={commands.busy}
          disabled={commands.busy || !valid}
          onPress={() => void launch()}
        />
      </ScrollView>
    </AppStackSheetFrame>
  );
}
