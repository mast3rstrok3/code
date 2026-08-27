/**
 * One reading of "who owns this workflow stage, and are they still working?".
 *
 * A stage records its owner as a thread id on the run: `activeValidatorThreadId`,
 * `codeReviewThreadId`, `workerThreadId`, and so on. That id answers two
 * different questions, and the bugs come from answering them in two places.
 *
 * - The decider asks *would starting this stage now put a second agent on the
 *   same branch?* It must say no only while an agent is genuinely at work.
 * - Recovery asks *may I replace this owner?* It must wait out the quiet gaps a
 *   healthy agent leaves — between turns, while a nudge re-prompts it, while a
 *   queued provider session comes up — or it spawns a rival every sweep.
 *
 * Those answers are deliberately different, and each guard used to derive its
 * own. The recovery sweep read an idle validator as finished while
 * `startMergeGate` read the same thread as live, so the sweep asked for a gate
 * every minute and the gate declined every minute, on a run that carried no
 * halt and therefore still read as running. Nothing was wrong with either
 * answer; they were just never written down together.
 *
 * So: one inspection, {@link stageClaimState}, and the policies named as
 * policies. A guard picks a policy. It does not re-derive one.
 */

import { isAwaitingWorkflowNudge, type WorkflowNudgeThread } from "./workflowNudge.ts";

/**
 * How long a stage thread may stay quiet before recovery treats it as gone.
 *
 * A live session resting between turns reads as `ready` with no active turn,
 * which is also how a thread looks when it stopped without reporting. Reviewers
 * rest there for a minute or two mid-review, and recovering on the first idle
 * sweep put a second reviewer on the same ticket branch: whichever one reported
 * first froze the ticket's recorded commit, the other kept committing, and every
 * later step that compared the branch against that commit refused.
 *
 * The same window covers a thread that has never reported at all, which is what
 * a launch queued behind a busy provider looks like. It is left alone, but not
 * forever: a restart drops a queued start with nothing to re-drive it. This is a
 * floor on how often recovery can be wrong, not the test itself, which is why it
 * is generous.
 */
export const STAGE_CLAIM_GRACE_MS = 10 * 60 * 1_000;

export interface StageClaimThread extends WorkflowNudgeThread {
  readonly createdAt: string;
}

export type StageClaimState =
  /** Nothing owns the stage. */
  | "unclaimed"
  /** The owner exists and its provider session is coming up. */
  | "starting"
  /** The owner is running a session or a turn. */
  | "working"
  /** The owner's turn failed and the nudge path is re-prompting it in place. */
  | "awaiting-nudge"
  /** The owner is quiet, but not yet long enough to call it gone. */
  | "settling"
  /** The owner is deleted, ended, or silent past the grace window. */
  | "released";

/**
 * Inspect the thread a stage points at.
 *
 * `thread` being undefined means the stage points at nothing, or at a thread the
 * read model no longer has; both are `unclaimed`, because neither leaves an
 * agent that could still be writing.
 */
export function stageClaimState(input: {
  readonly thread: StageClaimThread | undefined;
  readonly threads: ReadonlyArray<WorkflowNudgeThread>;
  readonly nowMs: number;
  readonly graceMs?: number;
}): StageClaimState {
  const { thread, threads, nowMs } = input;
  const graceMs = input.graceMs ?? STAGE_CLAIM_GRACE_MS;
  if (thread === undefined) return "unclaimed";
  if (thread.deletedAt !== null) return "released";
  if (thread.session?.status === "starting") return "starting";
  if (thread.session?.status === "running" || thread.latestTurn?.state === "running") {
    return "working";
  }
  if (isAwaitingWorkflowNudge({ threads, thread, nowMs })) return "awaiting-nudge";
  const quietSince =
    thread.session === null && thread.latestTurn === null
      ? Date.parse(thread.createdAt)
      : thread.session?.status === "ready"
        ? Date.parse(thread.session.updatedAt)
        : null;
  // `stopped`, `error` and `interrupted` say the session is actually over and
  // are released at once; only silence has to prove itself by lasting.
  if (quietSince === null) return "released";
  return nowMs - quietSince >= graceMs ? "released" : "settling";
}

/**
 * Whether starting this stage again would put a second agent on the branch the
 * current owner is writing to.
 *
 * The guard behind a user's Re-run. It stays narrow on purpose: a stage whose
 * thread is merely idle, or waiting on a nudge, is one the user is entitled to
 * take over, and refusing there removes the main lever for unsticking a run.
 */
export function stageClaimBlocksRestart(state: StageClaimState): boolean {
  return state === "starting" || state === "working";
}

/**
 * Whether automatic recovery may replace this owner.
 *
 * Strictly stronger than {@link stageClaimBlocksRestart}: a sweep runs every
 * minute with no human watching, so it waits out every quiet gap a working agent
 * can leave. Anything a sweep relaunches on, a user may also re-run.
 */
export function stageClaimIsReleased(state: StageClaimState): boolean {
  return state === "unclaimed" || state === "released";
}
