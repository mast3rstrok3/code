import {
  APP_REVIEW_WORKFLOW_DEFAULT_CYCLES,
  APP_REVIEW_WORKFLOW_MAX_CYCLES,
  type AssetCreateUrlInput,
  type AssetCreateUrlResult,
  type ChatFileAttachment,
  type EnvironmentId,
  isProviderDriverKind,
  type OrchestrationImplementationRun,
  ProjectId,
  type MessageId,
  type ModelSelection,
  type ProviderInteractionMode,
  type ProviderDriverKind,
  type ServerProvider,
  type ScopedProjectRef,
  type ScopedThreadRef,
  type ThreadId,
  type TurnId,
} from "@t3tools/contracts";
import { resolveAssetUrl } from "@t3tools/client-runtime/state/assets";
import {
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { isProductWorkflowRoot } from "@t3tools/shared/workflowPresets";
import { extractPreviewUrls, normalizePreviewUrl } from "@t3tools/shared/preview";
import { videoMimeType } from "@t3tools/shared/video";
import {
  appendCodexArtifactTemplateUsePrompt,
  codexArtifactTemplateUsePrompt,
  type CodexArtifactTemplate,
} from "@t3tools/client-runtime/codex-artifact-templates";
import {
  type ChatMessage,
  isImageAttachment,
  type SessionPhase,
  type Thread,
  type ThreadShell,
} from "../types";
import { type ComposerImageAttachment, type DraftThreadState } from "../composerDraftStore";
import * as Schema from "effect/Schema";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentThreadDetails } from "../state/threads";
import {
  filterTerminalContextsWithText,
  stripInlineTerminalContextPlaceholders,
  type TerminalContextDraft,
} from "../lib/terminalContext";
import type { DraftThreadEnvMode } from "../composerDraftStore";
import type { ComposerSubmissionIntent } from "../composer-logic";
import type { TimelineEntry } from "../session-logic";

export const LAST_INVOKED_SCRIPT_BY_PROJECT_KEY = "t3code:last-invoked-script-by-project";
export const MAX_HIDDEN_MOUNTED_TERMINAL_THREADS = 10;
export const MAX_HIDDEN_MOUNTED_PREVIEW_THREADS = 3;
export const ENVIRONMENT_RECONNECT_WARNING_GRACE_MS = 2_000;

export function normalizeAppReviewCycleBudget(value: number): number {
  if (!Number.isFinite(value)) return APP_REVIEW_WORKFLOW_DEFAULT_CYCLES;
  return Math.min(APP_REVIEW_WORKFLOW_MAX_CYCLES, Math.max(1, Math.round(value)));
}

export function collectAppReviewLaunchPreviewTargets(input: {
  readonly brief: string;
  readonly activeBrowserUrl: string | null;
}): ReadonlyArray<string> {
  return Array.from(
    new Set(
      [...extractPreviewUrls(input.brief), input.activeBrowserUrl]
        .map((target) => target?.trim())
        .filter((target): target is string => Boolean(target)),
    ),
  );
}

/**
 * The review target a user typed, as a full URL, or null when they typed
 * nothing usable. `localhost:5173` and `staging.example.com` both work; the
 * scheme is filled in the same way the preview surfaces fill it.
 */
export function normalizeAppReviewPreviewTarget(value: string): string | null {
  if (value.trim().length === 0) return null;
  try {
    return normalizePreviewUrl(value);
  } catch {
    return null;
  }
}

/**
 * What one App Review launch reviews.
 *
 * A target the user named is pinned: the run uses it as given, rather than
 * letting the worktree's App Stack substitute its own frontend. With no
 * named target the run keeps the old behavior — resolve the stack first, and
 * fall back to URLs found in the brief or the thread's open browser tab.
 */
export function buildAppReviewLaunchTargets(input: {
  readonly reviewUrl: string;
  readonly brief: string;
  readonly activeBrowserUrl: string | null;
}): { readonly previewTargets: ReadonlyArray<string>; readonly previewTargetsPinned: boolean } {
  const pinned = normalizeAppReviewPreviewTarget(input.reviewUrl);
  if (pinned !== null) return { previewTargets: [pinned], previewTargetsPinned: true };
  return {
    previewTargets: collectAppReviewLaunchPreviewTargets({
      brief: input.brief,
      activeBrowserUrl: input.activeBrowserUrl,
    }),
    previewTargetsPinned: false,
  };
}

export const LastInvokedScriptByProjectSchema = Schema.Record(ProjectId, Schema.String);

export function codexArtifactTemplatePromptToAppend(
  currentDraft: string,
  template: CodexArtifactTemplate,
): string | null {
  return appendCodexArtifactTemplateUsePrompt(currentDraft, template) === currentDraft
    ? null
    : codexArtifactTemplateUsePrompt(template);
}

export function shouldDockDraftHeroForSubmission(input: {
  isDraftHeroState: boolean;
  activeThreadKey: string | null;
  submissionIntent: ComposerSubmissionIntent;
}): boolean {
  return (
    input.submissionIntent === "foreground" &&
    input.isDraftHeroState &&
    input.activeThreadKey !== null
  );
}

export function shouldReleaseTimelineAnchorForToolActivity(input: {
  anchorMessageId: MessageId | null;
  liveFollowEnabled: boolean;
  runningTurnId: TurnId | null;
  timelineEntries: ReadonlyArray<TimelineEntry>;
}): boolean {
  if (input.anchorMessageId === null || !input.liveFollowEnabled || input.runningTurnId === null) {
    return false;
  }

  return input.timelineEntries.some((timelineEntry) => {
    if (timelineEntry.kind !== "work" || timelineEntry.entry.turnId !== input.runningTurnId) {
      return false;
    }

    const entry = timelineEntry.entry;
    return (
      entry.tone === "tool" ||
      entry.itemType !== undefined ||
      entry.requestKind !== undefined ||
      (entry.command?.trim().length ?? 0) > 0
    );
  });
}

export function toolGroupConsumesUpwardNavigation(target: EventTarget | null): boolean {
  const elementTarget = target instanceof Element ? target : null;
  const group = elementTarget?.closest<HTMLElement>("[data-tool-group-scroll]");
  if (!group) return false;

  // A nested result or the group itself can consume an upward scroll.
  for (let element = elementTarget; element; element = element.parentElement) {
    if (element.scrollTop > 0) {
      const overflowY = getComputedStyle(element).overflowY;
      if (overflowY === "auto" || overflowY === "scroll") return true;
    }
    if (element === group) break;
  }
  return false;
}

export function resolveDraftHeroState(input: {
  isLocalDraftThread: boolean;
  hasTimelineEntries: boolean;
  isWorking: boolean;
  draftHeroDockRequested: boolean;
  backgroundSubmissionPending: boolean;
}): boolean {
  if (input.backgroundSubmissionPending) {
    return true;
  }
  return (
    input.isLocalDraftThread &&
    !input.hasTimelineEntries &&
    !input.isWorking &&
    !input.draftHeroDockRequested
  );
}

export function resolveDraftPromotionNavigationTarget(input: {
  serverThreadRef: ScopedThreadRef | null;
  serverThread: Pick<Thread, "latestTurn" | "session"> | null | undefined;
  backgroundSubmissionPending: boolean;
}): ScopedThreadRef | null {
  if (input.backgroundSubmissionPending) {
    return null;
  }
  const sessionStatus = input.serverThread?.session?.status;
  const turnStarted = input.serverThread?.latestTurn?.startedAt != null;
  const startupStopped =
    sessionStatus === "error" || sessionStatus === "stopped" || sessionStatus === "interrupted";
  // Keep local preparation feedback mounted until the server can render the
  // running turn or its startup error on the canonical thread route.
  return turnStarted || startupStopped ? input.serverThreadRef : null;
}

export function scheduleEnvironmentReconnectWarning(showWarning: () => void): () => void {
  const timeoutId = globalThis.setTimeout(showWarning, ENVIRONMENT_RECONNECT_WARNING_GRACE_MS);
  return () => globalThis.clearTimeout(timeoutId);
}

export function hasEnvironmentReconnectWarningGraceElapsed(
  activeEnvironmentId: EnvironmentId | null,
  elapsedEnvironmentId: EnvironmentId | null,
): boolean {
  return activeEnvironmentId !== null && activeEnvironmentId === elapsedEnvironmentId;
}

export function startNewThreadForProject(
  projectRef: ScopedProjectRef | null,
  handleNewThread: (projectRef: ScopedProjectRef) => Promise<unknown>,
): boolean {
  if (projectRef === null) return false;
  void handleNewThread(projectRef);

  return true;
}

export function resolveThreadMetadataUpdateForNextTurn(input: {
  currentModelSelection: ModelSelection;
  nextModelSelection?: ModelSelection;
  currentBranch: string | null;
  nextBranch?: string;
}): {
  modelSelection?: ModelSelection;
  branch?: string;
  worktreePath?: null;
} | null {
  const nextModelSelection = input.nextModelSelection;
  const modelSelectionChanged =
    nextModelSelection !== undefined &&
    (nextModelSelection.model !== input.currentModelSelection.model ||
      nextModelSelection.instanceId !== input.currentModelSelection.instanceId ||
      JSON.stringify(nextModelSelection.options ?? null) !==
        JSON.stringify(input.currentModelSelection.options ?? null));
  const branchChanged = input.nextBranch !== undefined && input.nextBranch !== input.currentBranch;
  if (!modelSelectionChanged && !branchChanged) {
    return null;
  }
  return {
    ...(modelSelectionChanged ? { modelSelection: nextModelSelection } : {}),
    ...(branchChanged ? { branch: input.nextBranch, worktreePath: null } : {}),
  };
}

export function buildLocalDraftThread(
  threadId: ThreadId,
  draftThread: DraftThreadState,
  fallbackModelSelection: ModelSelection,
): Thread {
  return {
    id: threadId,
    environmentId: draftThread.environmentId,
    projectId: draftThread.projectId,
    ownerUserId: draftThread.ownerUserId,
    parentThreadId: null,
    workflowRole: null,
    title: "New thread",
    modelSelection: fallbackModelSelection,
    runtimeMode: draftThread.runtimeMode,
    interactionMode: draftThread.interactionMode,
    workflowPreset: draftThread.workflowPreset,
    session: null,
    messages: [],
    createdAt: draftThread.createdAt,
    updatedAt: draftThread.createdAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    latestTurn: null,
    branch: draftThread.branch,
    worktreePath: draftThread.worktreePath,
    checkpoints: [],
    activities: [],
    proposedPlans: [],
    planningWorkflow: null,
    appReviews: [],
  };
}

export function buildLoadingThreadFromShell(shell: ThreadShell): Thread {
  return {
    ...shell,
    messages: [],
    proposedPlans: [],
    activities: [],
    checkpoints: [],
    deletedAt: null,
    planningWorkflow: null,
    appReviews: [],
  };
}

export function shouldWriteThreadErrorToCurrentServerThread(input: {
  activeServerThread:
    | {
        environmentId: EnvironmentId;
        id: ThreadId;
      }
    | null
    | undefined;
  routeThreadRef: ScopedThreadRef;
  targetThreadId: ThreadId;
}): boolean {
  return Boolean(
    input.activeServerThread &&
    input.targetThreadId === input.routeThreadRef.threadId &&
    input.activeServerThread.environmentId === input.routeThreadRef.environmentId &&
    input.activeServerThread.id === input.targetThreadId,
  );
}

export function buildThreadTurnInterruptInput(thread: Pick<Thread, "id" | "session">): {
  threadId: ThreadId;
  turnId?: TurnId;
} {
  const runningTurnId = thread.session?.status === "running" ? thread.session.activeTurnId : null;
  return {
    threadId: thread.id,
    ...(runningTurnId !== null ? { turnId: runningTurnId } : {}),
  };
}

/**
 * The implementation run a thread's stop button should cancel: the run this
 * thread orchestrates, or the run launched from the proposed plan in this
 * thread. Terminal runs are ignored — there is nothing left to stop.
 */
export function findCancelableImplementationRunForThread(input: {
  threadId: ThreadId;
  implementationRuns: ReadonlyArray<OrchestrationImplementationRun>;
}): OrchestrationImplementationRun | null {
  const candidates = input.implementationRuns.filter(
    (run) =>
      run.status !== "completed" &&
      run.status !== "canceled" &&
      (run.orchestratorThreadId === input.threadId ||
        run.sourceProposedPlan?.threadId === input.threadId),
  );
  return (
    [...candidates].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ?? null
  );
}

export function resolveProductWorkflowPlanningThreadId(input: {
  activeThread:
    | Pick<Thread, "id" | "interactionMode" | "workflowPreset" | "workflowRole">
    | null
    | undefined;
  workflowThreadShells: ReadonlyArray<Pick<ThreadShell, "id" | "parentThreadId" | "workflowRole">>;
}): ThreadId | null {
  const activeThread = input.activeThread;
  if (!activeThread || !isProductWorkflowRoot(activeThread)) {
    return null;
  }
  return (
    input.workflowThreadShells.find(
      (thread) =>
        thread.parentThreadId === activeThread.id &&
        thread.workflowRole === "planning-orchestrator",
    )?.id ?? null
  );
}

export function reconcileMountedTerminalThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadTerminalOpen: boolean;
  maxHiddenThreadCount?: number;
}): string[] {
  return reconcileRetainedMountedThreadIds({
    currentThreadIds: input.currentThreadIds,
    openThreadIds: input.openThreadIds,
    activeThreadId: input.activeThreadId,
    activeThreadOpen: input.activeThreadTerminalOpen,
    maxHiddenThreadCount: input.maxHiddenThreadCount ?? MAX_HIDDEN_MOUNTED_TERMINAL_THREADS,
  });
}

export function reconcileRetainedMountedThreadIds(input: {
  currentThreadIds: ReadonlyArray<string>;
  openThreadIds: ReadonlyArray<string>;
  activeThreadId: string | null;
  activeThreadOpen: boolean;
  maxHiddenThreadCount: number;
  retainInactiveActiveThread?: boolean;
}): string[] {
  const openThreadIdSet = new Set(input.openThreadIds);
  const hiddenThreadIds = input.currentThreadIds.filter(
    (threadId) =>
      (threadId !== input.activeThreadId || input.retainInactiveActiveThread === true) &&
      openThreadIdSet.has(threadId),
  );
  const maxHiddenThreadCount = Math.max(0, input.maxHiddenThreadCount);
  const nextThreadIds =
    hiddenThreadIds.length > maxHiddenThreadCount
      ? hiddenThreadIds.slice(-maxHiddenThreadCount)
      : hiddenThreadIds;

  if (
    input.activeThreadId &&
    input.activeThreadOpen &&
    !nextThreadIds.includes(input.activeThreadId)
  ) {
    nextThreadIds.push(input.activeThreadId);
  }

  return nextThreadIds;
}

export function revokeBlobPreviewUrl(previewUrl: string | undefined): void {
  if (!previewUrl || typeof URL === "undefined" || !previewUrl.startsWith("blob:")) {
    return;
  }
  URL.revokeObjectURL(previewUrl);
}

/** Signs an attachment URL without reading its bytes, so video playback can request byte ranges. */
export async function resolveFileAttachmentUrl(input: {
  attachment: ChatFileAttachment;
  environmentId: EnvironmentId;
  httpBaseUrl: string;
  createAssetUrl: (input: {
    environmentId: EnvironmentId;
    input: AssetCreateUrlInput;
  }) => Promise<AtomCommandResult<AssetCreateUrlResult, unknown>>;
}): Promise<string> {
  const { attachment } = input;
  const result = await input.createAssetUrl({
    environmentId: input.environmentId,
    input: {
      resource: {
        _tag: "attachment",
        attachmentId: attachment.id,
        fileName: attachment.name,
        mimeType: videoMimeType(attachment) ?? attachment.mimeType,
      },
    },
  });
  if (result._tag === "Failure") throw squashAtomCommandFailure(result);
  const url = resolveAssetUrl(input.httpBaseUrl, result.value.relativeUrl);
  if (url === null) throw new Error("The environment returned an invalid attachment URL.");
  return url;
}

export function isVideoPreviewRequestCurrent(
  requestThreadKey: string,
  currentThreadKey: string,
  requestId: number,
  currentRequestId: number,
): boolean {
  return requestThreadKey === currentThreadKey && requestId === currentRequestId;
}

export function revokeUserMessagePreviewUrls(message: ChatMessage): void {
  if (message.role !== "user" || !message.attachments) {
    return;
  }
  for (const attachment of message.attachments) {
    if (!isImageAttachment(attachment)) {
      continue;
    }
    revokeBlobPreviewUrl(attachment.previewUrl);
  }
}

export function collectUserMessageBlobPreviewUrls(message: ChatMessage): string[] {
  if (message.role !== "user" || !message.attachments) {
    return [];
  }
  const previewUrls: string[] = [];
  for (const attachment of message.attachments) {
    if (!isImageAttachment(attachment)) continue;
    if (!attachment.previewUrl || !attachment.previewUrl.startsWith("blob:")) continue;
    previewUrls.push(attachment.previewUrl);
  }
  return previewUrls;
}

export interface AppReviewWorkflowLaunchRequest {
  readonly brief: string;
  readonly cycleBudget: number;
  /** Empty means "resolve this worktree's App Stack". */
  readonly reviewUrl: string;
  /** Review and ticket the gaps once, without repairing them. */
  readonly reviewOnly: boolean;
}

export interface BrowserAppReviewSourceContextMessage {
  readonly role: ChatMessage["role"];
  readonly text: string;
  readonly createdAt: string;
}

export interface BrowserAppReviewSourceContext {
  readonly turnId: TurnId | null;
  readonly messages: ReadonlyArray<BrowserAppReviewSourceContextMessage>;
}

export function selectBrowserAppReviewAutoContext(input: {
  readonly messages: ReadonlyArray<ChatMessage>;
  readonly latestTurn: Thread["latestTurn"] | null;
}): BrowserAppReviewSourceContext | null {
  const runningTurnId =
    input.latestTurn?.state === "running" ? (input.latestTurn.turnId as TurnId) : null;
  for (let index = input.messages.length - 1; index >= 0; index -= 1) {
    const message = input.messages[index];
    if (message?.role !== "user") continue;
    const turnMessages = collectMessagesForTurn(input.messages, index);
    const turnId = resolveTurnIdForContext(turnMessages);
    if (runningTurnId !== null && turnId === runningTurnId) continue;
    if (turnMessages.some((entry) => entry.streaming)) continue;
    return {
      turnId,
      messages: turnMessages.map((entry) => ({
        role: entry.role,
        text: entry.text,
        createdAt: entry.createdAt,
      })),
    };
  }
  return null;
}

function collectMessagesForTurn(
  messages: ReadonlyArray<ChatMessage>,
  userMessageIndex: number,
): ReadonlyArray<ChatMessage> {
  const entries: ChatMessage[] = [];
  for (let index = userMessageIndex; index < messages.length; index += 1) {
    const message = messages[index];
    if (!message) continue;
    if (index !== userMessageIndex && message.role === "user") break;
    entries.push(message);
  }
  return entries;
}

function resolveTurnIdForContext(messages: ReadonlyArray<ChatMessage>): TurnId | null {
  for (const message of messages) {
    if (message.turnId !== null) return message.turnId;
  }
  return null;
}

export interface PullRequestDialogState {
  initialReference: string | null;
  key: number;
}

export function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
        return;
      }
      reject(new Error("Could not read image data."));
    });
    reader.addEventListener("error", () => {
      reject(reader.error ?? new Error("Failed to read image."));
    });
    reader.readAsDataURL(file);
  });
}

export function resolveSendEnvMode(input: {
  requestedEnvMode: DraftThreadEnvMode;
  isGitRepo: boolean;
}): DraftThreadEnvMode {
  return input.isGitRepo ? input.requestedEnvMode : "local";
}

export function resolveBackgroundDraftWorkspaceOptions(input: {
  envMode: DraftThreadEnvMode;
  branch: string | null;
  startFromOrigin: boolean;
}): {
  envMode: DraftThreadEnvMode;
  branch: string | null;
  worktreePath: null;
  startFromOrigin: boolean;
} {
  return {
    envMode: input.envMode,
    branch: input.branch,
    worktreePath: null,
    startFromOrigin: input.envMode === "worktree" && input.startFromOrigin,
  };
}

export function cloneComposerImageForRetry(
  image: ComposerImageAttachment,
): ComposerImageAttachment {
  if (typeof URL === "undefined" || !image.previewUrl.startsWith("blob:")) {
    return image;
  }
  try {
    return {
      ...image,
      previewUrl: URL.createObjectURL(image.file),
    };
  } catch {
    return image;
  }
}

export function deriveComposerSendState(options: {
  prompt: string;
  imageCount: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  /**
   * Optional element-pick attachment count. Element contexts contribute to
   * "sendable content" exactly like images and (text-bearing) terminal
   * contexts do: a prompt of just element chips is still a valid send.
   */
  elementContextCount?: number;
}): {
  trimmedPrompt: string;
  sendableTerminalContexts: TerminalContextDraft[];
  expiredTerminalContextCount: number;
  hasSendableContent: boolean;
} {
  const trimmedPrompt = stripInlineTerminalContextPlaceholders(options.prompt).trim();
  const sendableTerminalContexts = filterTerminalContextsWithText(options.terminalContexts);
  const expiredTerminalContextCount =
    options.terminalContexts.length - sendableTerminalContexts.length;
  const elementContextCount = options.elementContextCount ?? 0;
  return {
    trimmedPrompt,
    sendableTerminalContexts,
    expiredTerminalContextCount,
    hasSendableContent:
      trimmedPrompt.length > 0 ||
      options.imageCount > 0 ||
      sendableTerminalContexts.length > 0 ||
      elementContextCount > 0,
  };
}

export function buildExpiredTerminalContextToastCopy(
  expiredTerminalContextCount: number,
  variant: "omitted" | "empty",
): { title: string; description: string } {
  const count = Math.max(1, Math.floor(expiredTerminalContextCount));
  const noun = count === 1 ? "Expired terminal context" : "Expired terminal contexts";
  if (variant === "empty") {
    return {
      title: `${noun} won't be sent`,
      description: "Remove it or re-add it to include terminal output.",
    };
  }
  return {
    title: `${noun} omitted from message`,
    description: "Re-add it if you want that terminal output included.",
  };
}

export function branchMismatchKey(
  threadId: string | null,
  mismatch: { threadBranch: string; currentBranch: string } | null,
): string | null {
  if (!threadId || !mismatch) {
    return null;
  }
  return `${threadId}:${mismatch.threadBranch}:${mismatch.currentBranch}`;
}

// The mismatch banner only matters when the user is about to send: passive
// reading of an old thread carries no risk (the branch picker tint already
// covers ambient awareness). Draft content is the intent signal — composer
// focus is useless here because ChatView autofocuses the composer on every
// thread open. `wasShownForCurrentMismatch` keeps the banner mounted once
// revealed so it doesn't flicker away when the draft is cleared.
export function shouldShowBranchMismatchBanner(input: {
  hasMismatch: boolean;
  isDismissed: boolean;
  composerHasContent: boolean;
  wasShownForCurrentMismatch: boolean;
}): boolean {
  if (!input.hasMismatch || input.isDismissed) {
    return false;
  }
  return input.composerHasContent || input.wasShownForCurrentMismatch;
}

export function shouldShowPlanFollowUpPrompt(input: {
  pendingUserInputCount: number;
  interactionMode: ProviderInteractionMode;
  latestTurnSettled: boolean;
  hasActionableProposedPlan: boolean;
  hasComposerAttachments: boolean;
}): boolean {
  return (
    input.pendingUserInputCount === 0 &&
    input.interactionMode === "plan" &&
    input.latestTurnSettled &&
    input.hasActionableProposedPlan &&
    !input.hasComposerAttachments
  );
}

// Session-scoped (module-level so it survives ChatView remounts, e.g. route
// changes). Durable cross-device dismissal is planned as a server-side ack.
const sessionDismissedBranchMismatchKeys = new Set<string>();

export function dismissBranchMismatchForSession(key: string): void {
  sessionDismissedBranchMismatchKeys.add(key);
}

export function isBranchMismatchDismissedForSession(key: string | null): boolean {
  return key !== null && sessionDismissedBranchMismatchKeys.has(key);
}

export function threadHasStarted(thread: Thread | null | undefined): boolean {
  return Boolean(
    thread && (thread.latestTurn !== null || thread.messages.length > 0 || thread.session !== null),
  );
}

// `threadProvider` is the open branded driver kind carried by the session.
// Unknown driver kinds degrade to `null` (i.e. "unlocked"), which is the safe
// rollback / fork behavior — the routing layer is the right place to surface
// "driver not installed" errors, not the lock state.
//
// `selectedProvider` takes the same open-string shape because the composer
// now tracks the picker selection as a `ProviderInstanceId` (e.g.
// `codex_personal`). Custom instance ids that don't directly match a
// registered driver resolve to `null` here, which matches the existing
// "unknown driver -> unlocked" semantics. Callers that want the lock to track
// a custom instance's underlying driver kind should resolve the instance id
// upstream and pass the correlated kind.
export function deriveLockedProvider(input: {
  thread: Thread | null | undefined;
  selectedProvider: string | null;
  threadProvider: string | null;
}): ProviderDriverKind | null {
  if (!threadHasStarted(input.thread)) {
    return null;
  }
  const sessionProvider = input.thread?.session?.providerName ?? null;
  if (sessionProvider && isProviderDriverKind(sessionProvider)) {
    return sessionProvider;
  }
  const narrowedThreadProvider =
    input.threadProvider && isProviderDriverKind(input.threadProvider)
      ? input.threadProvider
      : null;
  const narrowedSelectedProvider =
    input.selectedProvider && isProviderDriverKind(input.selectedProvider)
      ? input.selectedProvider
      : null;
  return narrowedThreadProvider ?? narrowedSelectedProvider ?? null;
}

export function getStartedThreadModelChangeBlockReason(input: {
  providers: ReadonlyArray<Pick<ServerProvider, "instanceId" | "requiresNewThreadForModelChange">>;
  hasStartedSession: boolean;
  currentModelSelection: ModelSelection;
  currentProviderInstanceId?: ModelSelection["instanceId"] | null | undefined;
  nextModelSelection: ModelSelection;
}): { title: string; description: string } | null {
  if (!input.hasStartedSession) {
    return null;
  }
  const currentModelSelection = {
    ...input.currentModelSelection,
    instanceId: input.currentProviderInstanceId ?? input.currentModelSelection.instanceId,
  };
  if (
    currentModelSelection.instanceId === input.nextModelSelection.instanceId &&
    currentModelSelection.model === input.nextModelSelection.model
  ) {
    return null;
  }
  const currentProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === currentModelSelection.instanceId,
  );
  const nextProvider = input.providers.find(
    (snapshot) => snapshot.instanceId === input.nextModelSelection.instanceId,
  );
  if (
    currentProvider?.requiresNewThreadForModelChange !== true &&
    nextProvider?.requiresNewThreadForModelChange !== true
  ) {
    return null;
  }
  return {
    title: "Start a new chat to change models",
    description: "This provider does not allow switching models after a conversation has started.",
  };
}

export async function waitForStartedServerThread(
  threadRef: ScopedThreadRef,
  timeoutMs = 1_000,
): Promise<boolean> {
  const threadAtom = environmentThreadDetails.detailAtom(threadRef);
  const getThread = () => appAtomRegistry.get(threadAtom);
  const thread = getThread();

  if (threadHasStarted(thread)) {
    return true;
  }

  return await new Promise<boolean>((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof globalThis.setTimeout> | null = null;
    const finish = (result: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        globalThis.clearTimeout(timeoutId);
      }
      unsubscribe();
      resolve(result);
    };

    const unsubscribe = appAtomRegistry.subscribe(threadAtom, (thread) => {
      if (!threadHasStarted(thread)) {
        return;
      }
      finish(true);
    });

    if (threadHasStarted(getThread())) {
      finish(true);
      return;
    }

    timeoutId = globalThis.setTimeout(() => {
      finish(false);
    }, timeoutMs);
  });
}

export interface LocalDispatchSnapshot {
  startedAt: string;
  preparingWorktree: boolean;
  submissionIntent: ComposerSubmissionIntent;
  latestUserMessageId: ChatMessage["id"] | null;
  latestTurnTurnId: TurnId | null;
  latestTurnRequestedAt: string | null;
  latestTurnStartedAt: string | null;
  latestTurnCompletedAt: string | null;
  sessionStatus: NonNullable<Thread["session"]>["status"] | null;
  sessionUpdatedAt: string | null;
}

export function createLocalDispatchSnapshot(
  activeThread: Thread | undefined,
  options?: {
    preparingWorktree?: boolean;
    submissionIntent?: ComposerSubmissionIntent;
  },
): LocalDispatchSnapshot {
  const latestTurn = activeThread?.latestTurn ?? null;
  const session = activeThread?.session ?? null;
  const latestUserMessage = activeThread?.messages.findLast((message) => message.role === "user");
  return {
    startedAt: new Date().toISOString(),
    preparingWorktree: Boolean(options?.preparingWorktree),
    submissionIntent: options?.submissionIntent ?? "foreground",
    latestUserMessageId: latestUserMessage?.id ?? null,
    latestTurnTurnId: latestTurn?.turnId ?? null,
    latestTurnRequestedAt: latestTurn?.requestedAt ?? null,
    latestTurnStartedAt: latestTurn?.startedAt ?? null,
    latestTurnCompletedAt: latestTurn?.completedAt ?? null,
    sessionStatus: session?.status ?? null,
    sessionUpdatedAt: session?.updatedAt ?? null,
  };
}

export function hasServerAcknowledgedLocalDispatch(input: {
  localDispatch: LocalDispatchSnapshot | null;
  phase: SessionPhase;
  latestTurn: Thread["latestTurn"] | null;
  latestUserMessageId: ChatMessage["id"] | null;
  session: Thread["session"] | null;
  hasPendingApproval: boolean;
  hasPendingUserInput: boolean;
  threadError: string | null | undefined;
}): boolean {
  if (!input.localDispatch) {
    return false;
  }
  if (input.hasPendingApproval || input.hasPendingUserInput || Boolean(input.threadError)) {
    return true;
  }
  if (input.phase === "connecting") {
    return false;
  }

  const latestTurn = input.latestTurn ?? null;
  const session = input.session ?? null;
  const latestUserMessageChanged =
    input.localDispatch.latestUserMessageId !== input.latestUserMessageId;
  const latestTurnChanged =
    input.localDispatch.latestTurnTurnId !== (latestTurn?.turnId ?? null) ||
    input.localDispatch.latestTurnRequestedAt !== (latestTurn?.requestedAt ?? null) ||
    input.localDispatch.latestTurnStartedAt !== (latestTurn?.startedAt ?? null) ||
    input.localDispatch.latestTurnCompletedAt !== (latestTurn?.completedAt ?? null);

  if (input.phase === "running") {
    // Steering adds a user message to the current running turn without
    // necessarily changing any of the turn timestamps. Treat that projected
    // message as the server acknowledgment so the composer does not remain
    // stuck in its local "Sending" state until the turn settles.
    if (latestUserMessageChanged) {
      return true;
    }
    if (!latestTurnChanged) {
      return false;
    }
    if (latestTurn?.startedAt === null || latestTurn === null) {
      return false;
    }
    if (
      session?.activeTurnId !== null &&
      session?.activeTurnId !== undefined &&
      latestTurn?.turnId !== session.activeTurnId
    ) {
      return false;
    }
    return true;
  }

  return (
    latestTurnChanged ||
    input.localDispatch.sessionStatus !== (session?.status ?? null) ||
    input.localDispatch.sessionUpdatedAt !== (session?.updatedAt ?? null)
  );
}
