import type { DevReviewRecord, ThreadId } from "@t3tools/contracts";

export function selectActiveDevReviewRecord(
  records: readonly DevReviewRecord[],
  openedThreadId: ThreadId,
): DevReviewRecord | null {
  const sorted = [...records].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  );
  return sorted.find((record) => record.reviewThreadId === openedThreadId) ?? sorted.at(-1) ?? null;
}
