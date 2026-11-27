import type { AppReviewStatus } from "@t3tools/contracts";

const DOM_REPLAY_MIME_TYPE = "application/x-rrweb+jsonl";

/** An rrweb DOM recording, which only a DOM replayer can play. */
export function isDomReplayRecording(mimeType: string | null | undefined): boolean {
  return mimeType === DOM_REPLAY_MIME_TYPE;
}

/** What the composer offers when a thread has no App Review: ask its agent to run one. */
export const APP_REVIEW_SKILL_PROMPT = "$app-review ";

export const APP_REVIEW_STATUS_LABELS: Record<AppReviewStatus, string> = {
  pending: "Pending",
  running: "In progress",
  passed: "Passed",
  failed: "Failed",
};
