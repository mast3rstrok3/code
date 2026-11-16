import type { StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { Platform, ScrollView } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { AppStackSheetFrame } from "../app-stacks/AppStackSheetFrame";
import { AppReviewCycleDocument, AppReviewRecordDocument } from "./AppReviewDocument";
import { useAppReview } from "./useAppReview";

type AppReviewDocumentTarget = {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
} & ({ readonly runId: string; readonly cycleNumber: number } | { readonly reviewId: string });

/** One cycle's results, or one review recorded before App Review ran as a workflow. */
export function AppReviewDocumentScreen({ route }: StaticScreenProps<AppReviewDocumentTarget>) {
  const insets = useSafeAreaInsets();
  const target = route.params;
  const review = useAppReview(target.environmentId, target.threadId);
  const recordById = new Map(review.records.map((record) => [record.id as string, record]));

  const document = (() => {
    if ("reviewId" in target) {
      const record = recordById.get(target.reviewId);
      return record === undefined
        ? null
        : {
            title: "Browser App Review",
            body: <AppReviewRecordDocument record={record} environmentId={target.environmentId} />,
          };
    }
    const run = review.allRuns.find((candidate) => candidate.id === target.runId);
    const cycle = run?.cycles.find((candidate) => candidate.cycleNumber === target.cycleNumber);
    if (run === undefined || cycle === undefined) return null;
    return {
      title: `Cycle ${String(cycle.cycleNumber)} of ${String(run.cycleBudget)}`,
      body: (
        <AppReviewCycleDocument
          cycle={cycle}
          e2eRecord={cycle.e2eReviewId == null ? undefined : recordById.get(cycle.e2eReviewId)}
          browserRecord={recordById.get(cycle.reviewId)}
          environmentId={target.environmentId}
        />
      ),
    };
  })();

  return (
    <AppStackSheetFrame
      screenId="thread-app-review-document-native"
      title={document?.title ?? "App Review"}
    >
      <ScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior={Platform.OS === "ios" ? "automatic" : "never"}
        contentContainerClassName="gap-5 px-5 pt-2"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 16) + 16 }}
      >
        {document?.body ?? (
          <Text className="pt-6 text-center text-sm text-foreground-muted">
            {review.loading ? "Loading the review…" : "This review is no longer available."}
          </Text>
        )}
      </ScrollView>
    </AppStackSheetFrame>
  );
}
