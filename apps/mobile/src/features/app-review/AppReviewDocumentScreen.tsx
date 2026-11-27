import type { StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Platform, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { useThreadAppReviews } from "../../state/appReview";
import { AppStackSheetFrame } from "../app-stacks/AppStackSheetFrame";
import { AppReviewRecordDocument } from "./AppReviewDocument";

type AppReviewDocumentTarget = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly reviewId: string;
};

export function AppReviewDocumentScreen({ route }: StaticScreenProps<AppReviewDocumentTarget>) {
  const insets = useSafeAreaInsets();
  const target = route.params;
  const reviews = useThreadAppReviews(target.environmentId, target.threadId);
  const record = reviews.data?.find((candidate) => candidate.id === target.reviewId);

  return (
    <AppStackSheetFrame
      screenId="thread-app-review-document-native"
      title={record?.document.brief || "App Review"}
    >
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        contentContainerClassName="gap-5 px-5 pt-2"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 16 }}
      >
        {record ? (
          <AppReviewRecordDocument record={record} environmentId={target.environmentId} />
        ) : (
          <Text className="pt-6 text-center text-sm text-foreground-muted">
            {reviews.data === undefined
              ? "Loading the review…"
              : "This review is no longer available."}
          </Text>
        )}
      </ScrollView>
    </AppStackSheetFrame>
  );
}
