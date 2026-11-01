import type { OrchestrationThreadShell } from "@t3tools/contracts";
// @effect-diagnostics globalDate:off -- UI snooze presets use local calendar boundaries and Intl labels.
import * as DateTime from "effect/DateTime";
import { DEFAULT_SNOOZE_PRESETS, type SnoozePresetSetting } from "@t3tools/contracts/settings";

import type { EnvironmentThreadShell, PendingSubagentRequest } from "./models.ts";

interface SettlementRunLike {
  readonly turnId?: unknown;
  readonly assistantMessageId?: unknown;
  readonly status?: string;
  readonly state?: string;
  readonly requestedAt?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
}

interface SettlementRuntimeLike {
  readonly threadId?: unknown;
  readonly providerName?: unknown;
  readonly runtimeMode?: unknown;
  readonly activeTurnId?: unknown;
  readonly lastError?: unknown;
  readonly status: string;
  readonly updatedAt?: string;
}

interface QueuedThreadShell {
  readonly latestUserMessageAt?: string | null;
  readonly latestTurn?: SettlementRunLike | null;
  readonly latestRun?: SettlementRunLike | null;
  readonly session?: SettlementRuntimeLike | null;
  readonly runtime?: SettlementRuntimeLike | null;
}

export type ChangeRequestStateLike = "open" | "closed" | "merged";

/**
 * The slice of a change request the settle rules need. `updatedAt` is the
 * provider's last-activity timestamp; for a merged/closed request it bounds
 * when the terminal state landed.
 */
export interface ChangeRequestSettleSource {
  readonly state: ChangeRequestStateLike;
  readonly updatedAt?: string | null | undefined;
}

/** What the settle rules need to know about the thread's own timeline. */
export type ThreadActivitySource = Pick<
  OrchestrationThreadShell,
  "createdAt" | "latestUserMessageAt" | "latestTurn"
>;

/**
 * Latest USER-initiated activity: messages and the turn requests they start,
 * deliberately not the agent-side started/completed stamps. The settle-on-
 * merge anchor uses this so a merge landing mid-turn still settles the
 * thread when that turn finishes, while a user re-engaging after the merge
 * blocks it for good. Falls back to creation time for untouched threads.
 */
function threadUserActivityAnchorAt(thread: ThreadActivitySource): string {
  const messageAt = thread.latestUserMessageAt;
  const requestedAt = thread.latestTurn?.requestedAt;
  let anchor = thread.createdAt;
  for (const candidate of [messageAt, requestedAt]) {
    if (candidate != null && Date.parse(candidate) > Date.parse(anchor)) {
      anchor = candidate;
    }
  }
  return anchor;
}

/**
 * Returns whether the change request settles the thread immediately. A
 * terminal request settles the thread only while it postdates every user-
 * initiated event in it: settling on a merge happens ONCE. A request last
 * touched before the thread was created is inherited branch history (a new
 * thread started at a worktree root whose PR already merged), and one older
 * than the user's latest engagement was already adjudicated — re-engaging a
 * thread whose PR merged is the user saying the conversation outlived the
 * PR. Unknown timestamps keep the old always-settle behavior.
 */
export function changeRequestAutoSettles(
  changeRequest: ChangeRequestSettleSource | null | undefined,
  options: {
    readonly autoSettleOnMerge?: boolean | undefined;
    readonly thread?: ThreadActivitySource | null | undefined;
  } = {},
): boolean {
  if (changeRequest == null) return false;
  const terminal =
    changeRequest.state === "closed" ||
    (changeRequest.state === "merged" && options.autoSettleOnMerge !== false);
  if (!terminal) return false;
  if (changeRequest.updatedAt == null || options.thread == null) return true;
  const updatedAtMs = Date.parse(changeRequest.updatedAt);
  const anchorAtMs = Date.parse(threadUserActivityAnchorAt(options.thread));
  // Malformed timestamps fall back to settling, matching servers that never
  // report updatedAt.
  if (Number.isNaN(updatedAtMs) || Number.isNaN(anchorAtMs)) return true;
  return updatedAtMs >= anchorAtMs;
}

const DAY_MS = 24 * 60 * 60 * 1_000;

export function threadLastActivityAt(
  shell: Pick<OrchestrationThreadShell, "latestUserMessageAt" | "latestTurn">,
): string | null {
  const candidates = [
    shell.latestUserMessageAt,
    shell.latestTurn?.requestedAt,
    shell.latestTurn?.startedAt,
    shell.latestTurn?.completedAt,
  ];
  let latest: string | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const candidate of candidates) {
    if (candidate === null || candidate === undefined) continue;
    const timestamp = Date.parse(candidate);
    if (timestamp > latestTimestamp) {
      latest = candidate;
      latestTimestamp = timestamp;
    }
  }

  return latest;
}

/**
 * Failed starts and stale shells from older servers can leave user messages unadopted.
 * Bound the pending window so those threads can eventually settle.
 */
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;

export function hasQueuedTurnStart(
  shell: QueuedThreadShell,
  options: { readonly now: string },
): boolean {
  if (
    shell.runtime?.status === "preparing" ||
    shell.runtime?.status === "queued" ||
    shell.runtime?.status === "starting"
  ) {
    return true;
  }
  if (shell.latestUserMessageAt == null) return false;
  if (shell.session?.status === "error") return false;
  const messageAt = Date.parse(shell.latestUserMessageAt);
  if (Number.isNaN(messageAt)) return false;
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(nowMs)) return false;
  // Bounded on both sides: message timestamps originate on whichever device
  // sent the message, so a clock ahead of this one yields a negative age
  // that would otherwise hold the queued state for the whole skew. Mirrors
  // the decider's guard.
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  const turn = shell.latestRun ?? shell.latestTurn ?? null;
  if (turn === null) return true;
  return [turn.requestedAt, turn.startedAt, turn.completedAt].every(
    (candidate) => candidate == null || Date.parse(candidate) < messageAt,
  );
}

/**
 * A thread may be settled only when none of effectiveSettled's activity
 * blockers hold. This is deliberately the same list: anything the partition
 * refuses to CLASSIFY as settled must also be refused as a settle TARGET.
 * The server enforces its own invariants; this client-side twin exists so
 * the UI can disable/reject before a round trip.
 */
export function canSettle(
  shell: Pick<
    OrchestrationThreadShell,
    "hasPendingApprovals" | "hasPendingUserInput" | "session" | "latestUserMessageAt" | "latestTurn"
  >,
  options: { readonly now: string },
): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  if (shell.session?.status === "starting" || shell.session?.status === "running") return false;
  // Queued work is as blocked-on-progress as a live session: settling it
  // (or auto-settling it on a closed PR) would hide a just-requested turn.
  if (hasQueuedTurnStart(shell, options)) return false;
  return true;
}

/**
 * The snooze lifecycle fields plus everything needed to detect a raised
 * hand. Snooze is an overlay on the active state: a snoozed thread stays
 * "active" in the data model and is only suppressed from the inbox until
 * its wake time passes or the thread demands attention.
 */
export interface ThreadSnoozeShell extends QueuedThreadShell {
  readonly source?: Pick<EnvironmentThreadShell["source"], "pendingRuntimeRequest">;
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly pendingSubagentRequest?: PendingSubagentRequest | null;
  readonly pendingGuestMessageCount?: number;
}

/**
 * Only a request for the user or a fresh failure ends a snooze early. Completed runs never do:
 * a snoozed long-running thread keeps waking itself for background work and stays hidden
 * until its timer.
 */
export function threadRaisedHandWhileSnoozed(shell: ThreadSnoozeShell): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return true;
  if (shell.source?.pendingRuntimeRequest != null) return true;
  if (shell.pendingSubagentRequest != null) return true;
  if ((shell.pendingGuestMessageCount ?? 0) > 0) return true;
  const failedAt = failureEdgeAt(shell);
  return (
    failedAt !== undefined &&
    (shell.snoozedAt == null ||
      (failedAt != null && Date.parse(failedAt) > Date.parse(shell.snoozedAt)))
  );
}

// V2 runtime.updatedAt includes metadata writes; prefer the failed run's completion.
// Legacy sessions only expose the runtime timestamp.
function failureEdgeAt(shell: ThreadSnoozeShell): string | null | undefined {
  const runtime = shell.runtime ?? shell.session ?? null;
  if (runtime?.status !== "error" && runtime?.status !== "failed") return undefined;
  const latestRun = shell.latestRun ?? shell.latestTurn ?? null;
  if (latestRun?.status === "failed" && latestRun.completedAt != null) {
    return latestRun.completedAt;
  }
  return runtime.updatedAt ?? null;
}

export function canSnooze(
  shell: Pick<
    ThreadSnoozeShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "pendingGuestMessageCount"
    | "latestUserMessageAt"
    | "latestTurn"
    | "latestRun"
    | "session"
    | "runtime"
    | "source"
  >,
  options: { readonly now: string },
): boolean {
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  // The server rejects snoozing for any pending request.
  if (shell.source?.pendingRuntimeRequest != null) return false;
  if (shell.pendingSubagentRequest != null) return false;
  // A waiting guest message would wake it at once.
  if ((shell.pendingGuestMessageCount ?? 0) > 0) return false;
  if (hasQueuedTurnStart(shell, options)) return false;
  return true;
}

export function effectiveSnoozed(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): boolean {
  if (shell.snoozedUntil == null) return false;
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  if (Number.isNaN(wakeAtMs)) return false;
  if (wakeAtMs <= Date.parse(options.now)) return false;
  return !threadRaisedHandWhileSnoozed(shell);
}

export function threadWokeAt(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): string | null {
  if (shell.snoozedUntil == null) return null;
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  if (Number.isNaN(wakeAtMs)) return null;
  // An early hand-raise wake stays authoritative even after the scheduled
  // wake time passes: reporting snoozedUntil then would resurface a Woke
  // indicator the user already cleared by visiting (snoozedUntil is newer
  // than that visit's lastVisitedAt).
  if (threadRaisedHandWhileSnoozed(shell)) {
    // An old failure must not replace the activity time of an approval or input wake.
    const failedAt = failureEdgeAt(shell);
    if (
      failedAt != null &&
      (shell.snoozedAt == null || Date.parse(failedAt) > Date.parse(shell.snoozedAt))
    ) {
      return failedAt;
    }
    const runtime = shell.runtime ?? shell.session ?? null;
    return runtime?.updatedAt ?? shell.snoozedAt ?? null;
  }
  return wakeAtMs <= Date.parse(options.now) ? shell.snoozedUntil : null;
}

/**
 * Settled resolution over the server-backed settled lifecycle. Activity
 * blockers (pending approval/user-input, a live session, an unadjudicated
 * queued turn) are checked first and hold a thread active regardless of any
 * override. Past the blockers, the explicit user override (thread.settle /
 * thread.unsettle commands, projected into settledOverride + settledAt)
 * wins in both directions; without one, a non-actionable thread auto-settles
 * on inactivity past the window. Failed and plan-ready threads stay visible
 * until the user reviews and settles them. A thread can also auto-settle on a
 * merged or closed change request when that state is its latest event. An open
 * change request blocks inactivity-based settling. The server
 * un-settles on real activity (user message, session start, approval/
 * user-input request), so an override never goes stale silently.
 */
export function effectiveSettled(
  shell: OrchestrationThreadShell,
  options: {
    readonly now: string;
    readonly autoSettleAfterDays: number | null;
    readonly autoSettleOnMerge?: boolean;
    readonly changeRequest?: ChangeRequestSettleSource | null;
  },
): boolean {
  // Blocked work must remain visible even when a user explicitly settled it.
  if (shell.hasPendingApprovals || shell.hasPendingUserInput) return false;
  // A paused workflow is stopped whatever its session row still says. That row
  // can outlive the agent: the provider's last write is lost if the server
  // restarts before it lands, and a stale "running" would pin a stopped run to
  // the inbox with a spinner nobody can turn off.
  if (shell.workflowPausedAt != null) return true;
  if (shell.session?.status === "starting" || shell.session?.status === "running") return false;
  if (hasQueuedTurnStart(shell, { now: options.now })) {
    // The queued-turn blocker alone is forgivable: it is clock-derived, and
    // list callers pass a coarser `now` than the settle action used. When
    // the server already adjudicated the queued message by accepting a
    // settle after it (settledAt stamps server accept time), trust that
    // ruling — otherwise a settle near the grace boundary leaves the row
    // pinned active until the caller's clock ticks over. A message NEWER
    // than settledAt is genuinely new work and keeps the block until the
    // server's auto-unsettle lands.
    const serverAdjudicated =
      shell.settledOverride === "settled" &&
      shell.settledAt !== null &&
      shell.latestUserMessageAt !== null &&
      Date.parse(shell.settledAt) >= Date.parse(shell.latestUserMessageAt);
    if (!serverAdjudicated) return false;
  }
  if (shell.settledOverride === "settled") return true;
  // "active" is the explicit keep-active pin: it suppresses auto-settle
  // until real activity clears it server-side.
  if (shell.settledOverride === "active") return false;
  if (
    changeRequestAutoSettles(options.changeRequest, {
      autoSettleOnMerge: options.autoSettleOnMerge,
      thread: shell,
    })
  ) {
    return true;
  }
  // These resting states still need a human decision. They may be settled
  // explicitly, but age alone must not move them out of the inbox.
  if (shell.session?.status === "error" || shell.hasActionableProposedPlan) return false;
  // An open PR is unfinished business regardless of how long the thread has
  // been quiet: review can take days, and hiding the thread would bury the
  // work waiting on it. A configured merge, a close, or an explicit user
  // settle resolves it.
  if (options.changeRequest?.state === "open") return false;
  if (options.autoSettleAfterDays === null) return false;

  const lastActivityAt = threadLastActivityAt(shell);
  if (lastActivityAt === null) return false;

  // threadLastActivityAt only returns candidates whose Date.parse beat
  // -Infinity, so this parse is a real number; a malformed `now` yields NaN,
  // the comparison is false, and the thread stays active (never a surprise
  // auto-settle on bad input).
  return (
    Date.parse(lastActivityAt) < Date.parse(options.now) - options.autoSettleAfterDays * DAY_MS
  );
}

const HOUR_MS = 60 * 60 * 1_000;

const WEEKDAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
} as const;

export interface SnoozePreset {
  readonly id: string;
  readonly label: string;
  readonly whenLabel: string;
  readonly snoozedUntil: string;
}

export interface SnoozePresetOptions {
  readonly presets?: ReadonlyArray<SnoozePresetSetting>;
  readonly formatTime?: (date: Date) => string;
}

function snoozeTimeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Calendar-day advance instead of adding DAY_MS: fixed millisecond offsets
// land on the wrong local day across DST transitions (a spring-forward day
// is 23 hours, so 23:30 + 24h skips the whole next day).
function addSnoozeDays(base: Date, days: number): Date {
  const next = DateTime.toDate(DateTime.makeUnsafe(base));
  next.setDate(next.getDate() + days);
  return next;
}

function pluralize(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** "3 hours", "90 minutes", "2 days": the largest unit that divides evenly. */
function formatSnoozeDuration(minutes: number): string {
  if (minutes % (24 * 60) === 0) return pluralize(minutes / (24 * 60), "day");
  if (minutes % 60 === 0) return pluralize(minutes / 60, "hour");
  return pluralize(minutes, "minute");
}

function capitalize(word: string): string {
  return word[0]!.toUpperCase() + word.slice(1);
}

function snoozePresetDaysAhead(
  setting: Extract<SnoozePresetSetting, { kind: "at" }>,
  now: Date,
): number {
  if (setting.day === "today") return 0;
  if (setting.day === "tomorrow") return 1;
  return (WEEKDAY_INDEX[setting.day] - now.getDay() + 7) % 7 || 7;
}

/** Labels follow the actual day gap, so a Monday option on a Sunday reads "Tomorrow". */
function snoozePresetLabel(setting: SnoozePresetSetting, daysAhead: number): string {
  if (setting.kind === "after") return `In ${formatSnoozeDuration(setting.minutes)}`;
  if (daysAhead === 0) {
    const hour = Number(setting.time.slice(0, 2));
    return hour < 12 ? "This morning" : hour < 17 ? "This afternoon" : "This evening";
  }
  if (daysAhead === 1) return "Tomorrow";
  if (setting.day === "monday") return "Next week";
  return daysAhead === 7 ? `Next ${capitalize(setting.day)}` : capitalize(setting.day);
}

export function snoozePresetId(setting: SnoozePresetSetting): string {
  return setting.kind === "after"
    ? `after:${setting.minutes}`
    : `at:${setting.day}:${setting.time}`;
}

export function resolveSnoozePreset(
  setting: SnoozePresetSetting,
  now: Date,
  formatTime: (date: Date) => string = snoozeTimeOfDayLabel,
): SnoozePreset | null {
  let wake: Date;
  let daysAhead = 0;
  if (setting.kind === "after") {
    wake = DateTime.toDate(DateTime.makeUnsafe(now.getTime() + setting.minutes * 60_000));
  } else {
    daysAhead = snoozePresetDaysAhead(setting, now);
    wake = addSnoozeDays(now, daysAhead);
    wake.setHours(Number(setting.time.slice(0, 2)), Number(setting.time.slice(3)), 0, 0);
    // A today option whose time has passed is left out until tomorrow.
    if (wake.getTime() <= now.getTime()) return null;
  }
  const label = snoozePresetLabel(setting, daysAhead);
  // Durations and "Next week" don't name the wake day, so a wake on another day shows it.
  const labelNamesDay = setting.kind === "at" && label !== "Next week";
  const time = formatTime(wake);
  return {
    id: snoozePresetId(setting),
    label,
    whenLabel:
      labelNamesDay || wake.toDateString() === now.toDateString()
        ? time
        : `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`,
    snoozedUntil: wake.toISOString(),
  };
}

/** The snooze menu: soonest first, one row per wake minute. */
export function resolveSnoozePresets(
  now: Date,
  options: SnoozePresetOptions = {},
): ReadonlyArray<SnoozePreset> {
  // By minute, so a duration (which keeps the clock's seconds) and a set time in the same
  // minute tie, and the stable sort keeps whichever comes first in settings.
  const wakeMinute = (preset: SnoozePreset) => Math.floor(Date.parse(preset.snoozedUntil) / 60_000);
  const seen = new Set<number>();
  return (
    (options.presets ?? DEFAULT_SNOOZE_PRESETS)
      .flatMap((setting) => resolveSnoozePreset(setting, now, options.formatTime) ?? [])
      // flatMap returned a new array; Hermes has no `toSorted`.
      .sort((a, b) => wakeMinute(a) - wakeMinute(b))
      .filter((preset) => {
        if (seen.has(wakeMinute(preset))) return false;
        seen.add(wakeMinute(preset));
        return true;
      })
  );
}

/**
 * A menu choice as picked. A duration re-resolves from its setting (not the deduped menu) so it
 * starts at selection. A set time keeps the shown wake, which a day change would otherwise shift.
 */
export function pickSnoozePreset(input: {
  readonly shown: ReadonlyArray<SnoozePreset>;
  readonly id: string;
  readonly now: Date;
  readonly presets?: ReadonlyArray<SnoozePresetSetting>;
  readonly formatTime?: (date: Date) => string;
}): SnoozePreset | undefined {
  const original = input.shown.find((preset) => preset.id === input.id);
  const ahead =
    original && Date.parse(original.snoozedUntil) > input.now.getTime() ? original : undefined;
  const setting = (input.presets ?? DEFAULT_SNOOZE_PRESETS).find(
    (candidate) => candidate.kind === "after" && snoozePresetId(candidate) === input.id,
  );
  return (setting && resolveSnoozePreset(setting, input.now, input.formatTime)) ?? ahead;
}

export function snoozeWakeLabel(snoozedUntil: string, options: { readonly now: string }): string {
  const wakeMs = Date.parse(snoozedUntil);
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(wakeMs) || Number.isNaN(nowMs)) return "now";
  const remainingMs = wakeMs - nowMs;
  if (remainingMs <= 0) return "now";
  if (remainingMs < HOUR_MS) return `${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
  if (remainingMs < DAY_MS) return `${Math.ceil(remainingMs / HOUR_MS)}h`;
  return `${Math.ceil(remainingMs / DAY_MS)}d`;
}

export type CustomSnoozeInput =
  | { readonly mode: "date"; readonly date: string; readonly time: string }
  | {
      readonly mode: "duration";
      readonly amount: string;
      readonly unit: "minutes" | "hours" | "days";
    };

export function resolveCustomSnooze(input: CustomSnoozeInput, now: Date): string | null {
  let wake: Date;
  if (input.mode === "duration") {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unitMs = { minutes: 60_000, hours: HOUR_MS, days: 24 * HOUR_MS }[input.unit];
    wake = new Date(now.getTime() + amount * unitMs);
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.time)) return null;
    wake = new Date(`${input.date}T${input.time}:00`);
    // Reject rolled-over dates and nonexistent local times during DST changes.
    if (localSnoozeDate(wake) !== input.date || localSnoozeTime(wake) !== input.time) return null;
  }
  return Number.isFinite(wake.getTime()) && wake.getTime() > now.getTime()
    ? wake.toISOString()
    : null;
}

export function localSnoozeDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function localSnoozeTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Whether a woken thread woke after the user last saw it. A run that completed
 * after the last visit counts as seeing it, since the user watched it finish.
 */
export function isThreadWokeUnseen(input: {
  readonly wokeAt: string | null;
  readonly settled: boolean;
  readonly lastVisitedAt: string | null | undefined;
  readonly latestRunCompletedAt: string | null;
}): boolean {
  if (input.wokeAt === null || input.settled) return false;
  const wokeAtMs = Date.parse(input.wokeAt);
  if (Number.isNaN(wokeAtMs)) return false;
  const seenAt = [input.lastVisitedAt, input.latestRunCompletedAt]
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter((ms) => !Number.isNaN(ms));
  return seenAt.every((ms) => ms < wokeAtMs);
}
