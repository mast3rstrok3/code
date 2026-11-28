import type { AppReviewStatus } from "@t3tools/contracts";

// Sky is moving, red failed, emerald passed, muted has not started; labels use theme tokens.
const RECORD_STYLE: Record<
  AppReviewStatus,
  { readonly dotClassName: string; readonly textClassName: string }
> = {
  pending: { dotClassName: "border border-neutral-400", textClassName: "text-foreground-muted" },
  running: { dotClassName: "bg-sky-500", textClassName: "text-foreground" },
  passed: { dotClassName: "bg-emerald-500", textClassName: "text-foreground-muted" },
  failed: { dotClassName: "bg-red-500", textClassName: "text-danger-foreground" },
};

export function appReviewRecordStyle(status: AppReviewStatus) {
  return RECORD_STYLE[status];
}
