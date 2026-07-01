import type { DevReviewRecord, DevReviewReplayGetResult, ThreadId } from "@t3tools/contracts";

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

export function devReviewReplayRefreshRevision(record: DevReviewRecord): string {
  return JSON.stringify([
    record.id,
    record.replay.status,
    record.replay.eventCount,
    record.replay.completedAt,
    record.replay.durationMs,
    record.updatedAt,
  ]);
}

export function shouldRefreshDevReviewReplay(input: {
  readonly record: DevReviewRecord | null;
  readonly data: DevReviewReplayGetResult | null;
  readonly isPending: boolean;
  readonly lastRefreshRevision: string | null;
}): { readonly refresh: boolean; readonly revision: string | null } {
  if (input.record === null) {
    return { refresh: false, revision: null };
  }
  const revision = devReviewReplayRefreshRevision(input.record);
  if (input.record.replay.eventCount <= 0 || input.isPending) {
    return { refresh: false, revision };
  }
  if (input.lastRefreshRevision === revision) {
    return { refresh: false, revision };
  }
  if (input.data?.reviewId !== input.record.id) {
    return { refresh: true, revision };
  }
  return {
    refresh: input.data.events.length < input.record.replay.eventCount,
    revision,
  };
}
