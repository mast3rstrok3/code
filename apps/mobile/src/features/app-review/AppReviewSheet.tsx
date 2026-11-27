import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  APP_REVIEW_SKILL_PROMPT,
  APP_REVIEW_STATUS_LABELS,
} from "@t3tools/client-runtime/app-review";
import type { AppReviewRecord, EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Haptics from "expo-haptics";
import { Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { Button } from "../../components/ui/Button";
import { EmptyState } from "../../components/ui/EmptyState";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { cn } from "../../lib/cn";
import { scopedThreadKey } from "../../lib/scopedEntities";
import { useThreadAppReviews } from "../../state/appReview";
import { getComposerDraftSnapshot, setComposerDraftText } from "../../state/use-composer-drafts";
import { AppStackSheetFrame } from "../app-stacks/AppStackSheetFrame";
import { appReviewRecordStyle } from "./appReviewStatusStyle";

type AppReviewSheetTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };

/** The App Reviews an agent ran on this thread, newest first. */
export function AppReviewSheet({ route }: StaticScreenProps<AppReviewSheetTarget>) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const target = route.params;
  const reviews = useThreadAppReviews(target.environmentId, target.threadId);
  const newestFirst = [...(reviews.data ?? [])].reverse();
  const newest = newestFirst[0];

  const openDocument = (record: AppReviewRecord) => {
    void Haptics.selectionAsync();
    navigation.dispatch(
      StackActions.push("ThreadAppReviewDocument", {
        environmentId: target.environmentId,
        threadId: target.threadId,
        reviewId: record.id,
      }),
    );
  };
  const askAgent = () => {
    const draftKey = scopedThreadKey(target.environmentId, target.threadId);
    const draft = getComposerDraftSnapshot(draftKey).text;
    if (!draft.startsWith(APP_REVIEW_SKILL_PROMPT)) {
      setComposerDraftText(draftKey, `${APP_REVIEW_SKILL_PROMPT}${draft}`);
    }
    navigation.goBack();
  };

  return (
    <AppStackSheetFrame
      screenId="thread-app-review-sheet-native"
      title={newestFirst.length > 1 ? `App Reviews · ${String(newestFirst.length)}` : "App Review"}
      subtitle={newest ? APP_REVIEW_STATUS_LABELS[newest.status] : null}
    >
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        contentContainerClassName="px-5 pt-2"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 8 }}
      >
        {reviews.error !== null && newest === undefined ? (
          <ErrorBanner message={reviews.error} />
        ) : null}
        {newest === undefined && reviews.error === null ? (
          <EmptyState
            variant="plain"
            title={reviews.isPending ? "Loading App Reviews…" : "No App Review yet"}
            detail="The agent runs the end-to-end tests, tries the app in the browser, and records what it sees here."
            action={
              reviews.isPending ? undefined : (
                <Button
                  tone="primary"
                  icon="checkmark.circle"
                  label="Ask the agent for an App Review"
                  onPress={askAgent}
                />
              )
            }
          />
        ) : null}
        {newestFirst.map((record, index) => (
          <ReviewRow
            key={record.id}
            record={record}
            label={record.document.brief || `App Review ${String(newestFirst.length - index)}`}
            onPress={() => openDocument(record)}
          />
        ))}
      </ScrollView>
    </AppStackSheetFrame>
  );
}

function ReviewRow(props: {
  readonly record: AppReviewRecord;
  readonly label: string;
  readonly onPress: () => void;
}) {
  const style = appReviewRecordStyle(props.record.status);
  const statusLabel = APP_REVIEW_STATUS_LABELS[props.record.status];
  const tests = props.record.evidence.tests?.length ?? 0;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${props.label}, ${statusLabel}`}
      onPress={props.onPress}
      className="min-h-12 flex-row items-center gap-3 border-t border-border py-3 active:opacity-70"
    >
      <View className={cn("size-2 shrink-0 rounded-full", style.dotClassName)} />
      <View className="min-w-0 flex-1 gap-0.5">
        <Text numberOfLines={1} className="font-t3-medium text-sm text-foreground">
          {props.label}
        </Text>
        <Text numberOfLines={1} className={cn("text-xs", style.textClassName)}>
          {statusLabel}
          {tests > 0 ? ` · ${String(tests)} test ${tests === 1 ? "run" : "runs"}` : ""}
        </Text>
      </View>
      <SymbolView
        name="chevron.right"
        size={12}
        tintColorClassName="accent-icon-muted"
        type="monochrome"
      />
    </Pressable>
  );
}
