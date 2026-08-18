import {
  IMPLEMENTATION_RUN_MAX_QA_REPAIRS,
  type EnvironmentId,
  type EditorId,
  type ProjectScript,
  type OrchestrationImplementationRun,
  type OrchestrationPlanningWorkflow,
  type OrchestrationThreadWorkflowRole,
  type ProviderInteractionMode,
  type ThreadWorkflowContext,
  type ResolvedKeybindingsConfig,
  type ThreadId,
  type WorkspaceUser,
  type WorkflowPreset,
  WorkspaceUserId,
  type WorkspaceUserId as WorkspaceUserIdType,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ChangeRequestStateLike } from "@t3tools/client-runtime/state/thread-settled";
import { ChevronDownIcon } from "lucide-react";
import {
  memo,
  useCallback,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";
import { useThreadActionMenu } from "~/hooks/useThreadActionMenu";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProjectFavicon } from "../ProjectFavicon";
import {
  WorkspaceBreadcrumb,
  WorkspaceBreadcrumbItem,
  WorkspaceBreadcrumbSeparator,
} from "../WorkspaceBreadcrumb";
import { cn } from "~/lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Badge } from "../ui/badge";
import { isProductWorkflowRoot } from "@t3tools/shared/workflowPresets";

export function workflowProgressLabel(input: {
  readonly interactionMode: ProviderInteractionMode;
  readonly workflowPreset?: WorkflowPreset | null;
  readonly workflowRole: OrchestrationThreadWorkflowRole | null;
  readonly workflowContext: ThreadWorkflowContext | null;
  readonly planningWorkflow: OrchestrationPlanningWorkflow | null;
  readonly implementationRuns: ReadonlyArray<OrchestrationImplementationRun>;
}): string | null {
  if (input.workflowContext === null) return null;
  const run = [...input.implementationRuns].sort((left, right) =>
    right.updatedAt.localeCompare(left.updatedAt),
  )[0];
  if (run !== undefined) {
    if (run.artifactSource === "proposed-plan") {
      if (run.status === "launch-pending") return "Fast feature · Setup";
      if (run.status === "running") return "Fast feature · Build";
    }
    switch (run.status) {
      case "launch-pending":
        return "Implementation · Launching";
      case "running":
        return "Implementation · TDD";
      case "integrating":
      case "validating":
        return "Implementation · Merge gate";
      case "qa-reviewing":
        return "Implementation · Browser App Review";
      case "fixing":
        if (run.fixOrigin === "app-dev-stack" || run.fixOrigin === "app-review") {
          return `${run.artifactSource === "proposed-plan" ? "Fast feature" : "Implementation"} · TDD repair · ${run.qaCycleCount}/${IMPLEMENTATION_RUN_MAX_QA_REPAIRS}`;
        }
        return "Implementation · Fix";
      case "code-review-fixing":
        return "Implementation · Fix";
      case "code-reviewing":
        return "Implementation · Code review";
      case "completed":
        return "Implementation · Complete";
      case "needs-human-attention":
        return "Implementation · Attention";
      case "canceled":
        return "Implementation · Canceled";
    }
  }

  const workflow = input.planningWorkflow;
  if (workflow !== null) {
    switch (workflow.stage) {
      case "grill":
      case "spec-authoring":
        return "Planning · Spec";
      case "tickets-authoring":
      case "ticket-revision":
        return "Planning · Tickets";
      case "ticket-review": {
        const active = workflow.activeReview;
        const cycle = active?.cycleNumber ?? workflow.reviewCycles.length + 1;
        return active?.mode === "targeted"
          ? `Planning · Ticket fixes · ${cycle}/10`
          : `Planning · Full ticket review · ${cycle}/10`;
      }
      case "completed":
        return "Planning · Complete";
      case "completed-with-warnings":
        return "Planning · Complete with warnings";
      case "needs-human-attention":
        return "Planning · Attention";
    }
  }

  switch (input.workflowRole) {
    case "implementation-worker":
      return "Implementation · TDD";
    case "implementation-validator":
      return "Implementation · Merge gate";
    case "implementation-qa-reviewer":
      return "Implementation · Browser App Review";
    case "app-review-orchestrator":
      return "App Review · Controller";
    case "app-review-reviewer":
      return "App Review · Browser review";
    case "app-review-planner":
      return "App Review · Gap analysis";
    case "app-review-fixer":
      return "App Review · Implement plan";
    case "implementation-fixer":
    case "product-fix-implementer":
      return "Implementation · Fix";
    case "implementation-code-reviewer":
      return "Implementation · Code review";
    case "implementation-orchestrator":
    case "fast-feature-implementer":
      return "Fast feature · Build";
    case "planning-orchestrator":
    case "planning-reviewer":
      return "Planning · Spec";
    default:
      return isProductWorkflowRoot({
        interactionMode: input.interactionMode,
        workflowPreset: input.workflowPreset ?? null,
        workflowRole: input.workflowRole,
      })
        ? "Product · Intent"
        : null;
  }
}

interface ChatHeaderProps {
  activeThreadEnvironmentId: EnvironmentId;
  activeThreadId: ThreadId;
  draftId?: DraftId;
  activeThreadTitle: string;
  workflowProgress: {
    interactionMode: ProviderInteractionMode;
    workflowPreset?: WorkflowPreset | null;
    workflowRole: OrchestrationThreadWorkflowRole | null;
    workflowContext: ThreadWorkflowContext | null;
    planningWorkflow: OrchestrationPlanningWorkflow | null;
    implementationRuns: ReadonlyArray<OrchestrationImplementationRun>;
  };
  activeThreadOwnerUserId: WorkspaceUserIdType;
  workspaceUsers: ReadonlyArray<WorkspaceUser>;
  /** Drafts have no server thread yet, so the title carries no action menu. */
  isServerThread: boolean;
  /** PR state feeding the settled classification, resolved by ChatView. */
  changeRequestState: ChangeRequestStateLike | null;
  activeProjectName: string | undefined;
  activeProjectCwd: string | null;
  activeProjectFaviconPath: string | null;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  gitCwd: string | null;
  readonly onOpenPullRequest?: ((number: number) => void) | undefined;
  onNewThreadInProject: () => void;
  onRunProjectScript: (script: ProjectScript) => void;
  onOwnerUserIdChange: (ownerUserId: WorkspaceUserIdType) => void;
  onAddProjectScript: (input: NewProjectScriptInput) => Promise<ProjectScriptActionResult>;
  onUpdateProjectScript: (
    scriptId: string,
    input: NewProjectScriptInput,
  ) => Promise<ProjectScriptActionResult>;
  onDeleteProjectScript: (scriptId: string) => Promise<ProjectScriptActionResult>;
}

/**
 * Rename commit rule shared with the sidebar's inline rename: trim, reject
 * empty (the caller toasts), and skip the mutation when nothing changed.
 */
export function resolveRenameCommit(input: {
  readonly title: string;
  readonly originalTitle: string;
}): { action: "commit"; title: string } | { action: "reject-empty" } | { action: "noop" } {
  const trimmed = input.title.trim();
  if (trimmed.length === 0) return { action: "reject-empty" };
  if (trimmed === input.originalTitle) return { action: "noop" };
  return { action: "commit", title: trimmed };
}

export function shouldShowOpenInPicker(input: {
  readonly activeProjectName: string | undefined;
  readonly activeThreadEnvironmentId: EnvironmentId;
  readonly primaryEnvironmentId: EnvironmentId | null;
}): boolean {
  return (
    Boolean(input.activeProjectName) &&
    input.primaryEnvironmentId !== null &&
    input.activeThreadEnvironmentId === input.primaryEnvironmentId
  );
}

export const ChatHeader = memo(function ChatHeader({
  activeThreadEnvironmentId,
  activeThreadId,
  draftId,
  activeThreadTitle,
  workflowProgress,
  activeThreadOwnerUserId,
  workspaceUsers,
  isServerThread,
  changeRequestState,
  activeProjectName,
  activeProjectCwd,
  activeProjectFaviconPath,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  gitCwd,
  onOpenPullRequest,
  onNewThreadInProject,
  onRunProjectScript,
  onOwnerUserIdChange,
  onAddProjectScript,
  onUpdateProjectScript,
  onDeleteProjectScript,
}: ChatHeaderProps) {
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const fileScripts = useT3ProjectFileScripts(
    activeThreadEnvironmentId,
    activeProjectScripts ? activeProjectCwd : null,
  );
  const showOpenInPicker = shouldShowOpenInPicker({
    activeProjectName,
    activeThreadEnvironmentId,
    primaryEnvironmentId,
  });
  const activeThreadRef = useMemo(
    () => scopeThreadRef(activeThreadEnvironmentId, activeThreadId),
    [activeThreadEnvironmentId, activeThreadId],
  );
  const updateThreadMetadata = useAtomCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  // Inline rename, keyed by thread: navigating away drops an in-progress
  // rename instead of committing stale text. Cleared on thread change (not
  // just hidden) so returning to the thread doesn't revive the old draft.
  const [renaming, setRenaming] = useState<{ threadId: ThreadId; title: string } | null>(null);
  if (renaming !== null && renaming.threadId !== activeThreadId) {
    setRenaming(null);
  }
  const renamingTitle = renaming?.threadId === activeThreadId ? renaming.title : null;
  const renameCommittedRef = useRef(false);
  const startRename = useCallback(() => {
    renameCommittedRef.current = false;
    setRenaming({ threadId: activeThreadId, title: activeThreadTitle });
  }, [activeThreadId, activeThreadTitle]);
  const commitRename = useCallback(
    (title: string) => {
      setRenaming(null);
      const resolution = resolveRenameCommit({ title, originalTitle: activeThreadTitle });
      if (resolution.action === "reject-empty") {
        toastManager.add({ type: "warning", title: "Thread title cannot be empty" });
        return;
      }
      if (resolution.action === "noop") return;
      void updateThreadMetadata({
        environmentId: activeThreadEnvironmentId,
        input: { threadId: activeThreadId, title: resolution.title },
      }).then((result) => {
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const error = squashAtomCommandFailure(result);
          toastManager.add({
            type: "error",
            title: "Failed to rename thread",
            description: error instanceof Error ? error.message : "An error occurred.",
          });
        }
      });
    },
    [activeThreadEnvironmentId, activeThreadId, activeThreadTitle, updateThreadMetadata],
  );
  const { openMenu } = useThreadActionMenu({
    threadRef: isServerThread ? activeThreadRef : null,
    projectCwd: activeProjectCwd,
    changeRequestState,
    onStartRename: startRename,
  });
  const titleButtonRef = useRef<HTMLButtonElement | null>(null);
  const openMenuFromTitle = useCallback(() => {
    const rect = titleButtonRef.current?.getBoundingClientRect();
    if (!rect) return;
    openMenu({ x: rect.left, y: rect.bottom + 4 });
  }, [openMenu]);
  const handleHeaderContextMenu = useCallback(
    (event: ReactMouseEvent) => {
      if (!isServerThread || renamingTitle !== null) return;
      // The right-side controls (git, scripts, open-in) keep their own
      // behavior; only the breadcrumb area opens the thread menu.
      if ((event.target as HTMLElement).closest("[data-chat-header-actions]")) return;
      event.preventDefault();
      openMenu({ x: event.clientX, y: event.clientY });
    },
    [isServerThread, openMenu, renamingTitle],
  );
  const handleRenameKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLInputElement>) => {
      if (event.key === "Enter") {
        renameCommittedRef.current = true;
        commitRename(event.currentTarget.value);
      } else if (event.key === "Escape") {
        renameCommittedRef.current = true;
        setRenaming(null);
      }
    },
    [commitRename],
  );
  const progressLabel = workflowProgressLabel(workflowProgress);
  return (
    <div
      className={cn(
        "@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3",
        rightPanelOpen ? "pr-0" : "pr-16",
      )}
      onContextMenu={handleHeaderContextMenu}
    >
      <WorkspaceBreadcrumb ariaLabel="Thread breadcrumb" className="flex-1">
        {/* The project always leads the header: knowing which project a
            thread lives in is priority zero, and the thread title alone
            doesn't answer it. */}
        {activeProjectName ? (
          <>
            <WorkspaceBreadcrumbItem>
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      aria-label={`New thread in ${activeProjectName}`}
                      onClick={onNewThreadInProject}
                      className="inline-flex min-w-0 cursor-pointer items-center gap-1.5 rounded-sm text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                    />
                  }
                >
                  <ProjectFavicon
                    environmentId={activeThreadEnvironmentId}
                    cwd={activeProjectCwd ?? ""}
                    faviconPath={activeProjectFaviconPath}
                    className="size-3.5"
                  />
                  <span className="max-w-40 truncate">{activeProjectName}</span>
                </TooltipTrigger>
                <TooltipPopup side="top">New thread in {activeProjectName}</TooltipPopup>
              </Tooltip>
            </WorkspaceBreadcrumbItem>
            <WorkspaceBreadcrumbSeparator />
          </>
        ) : null}
        <WorkspaceBreadcrumbItem current className="flex-1">
          {renamingTitle !== null ? (
            <input
              autoFocus
              aria-label="Thread title"
              className="min-w-0 flex-1 rounded-sm bg-transparent text-sm font-medium text-foreground outline-none ring-1 ring-ring/50 focus:ring-ring"
              defaultValue={renamingTitle}
              onBlur={(event) => {
                if (renameCommittedRef.current) return;
                commitRename(event.currentTarget.value);
              }}
              onFocus={(event) => event.currentTarget.select()}
              onKeyDown={handleRenameKeyDown}
            />
          ) : isServerThread ? (
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    ref={titleButtonRef}
                    type="button"
                    aria-label={`Thread actions for ${activeThreadTitle}`}
                    aria-haspopup="menu"
                    onClick={openMenuFromTitle}
                    className="group/thread-title inline-flex min-w-0 max-w-full cursor-pointer items-center gap-1 rounded-sm text-left focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                  />
                }
              >
                <h2 className="min-w-0 truncate">{activeThreadTitle}</h2>
                <ChevronDownIcon
                  aria-hidden
                  className="size-3.5 shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover/thread-title:opacity-100 group-focus-visible/thread-title:opacity-100"
                />
              </TooltipTrigger>
              <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
            </Tooltip>
          ) : (
            <Tooltip>
              <TooltipTrigger
                render={
                  <h2 aria-label={activeThreadTitle} className="min-w-0 flex-1 truncate">
                    {activeThreadTitle}
                  </h2>
                }
              />
              <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
            </Tooltip>
          )}
        </WorkspaceBreadcrumbItem>
      </WorkspaceBreadcrumb>
      {progressLabel === null ? null : (
        <Tooltip>
          <TooltipTrigger
            render={
              <Badge
                variant="secondary"
                size="sm"
                aria-label={progressLabel}
                className="max-w-52 shrink truncate @max-md/header-actions:hidden"
              >
                <span className="truncate">{progressLabel}</span>
              </Badge>
            }
          />
          <TooltipPopup side="top">{progressLabel}</TooltipPopup>
        </Tooltip>
      )}
      {workspaceUsers.length > 1 ? (
        <Select
          value={activeThreadOwnerUserId}
          onValueChange={(value) => {
            if (value !== null) onOwnerUserIdChange(WorkspaceUserId.make(value));
          }}
        >
          <SelectTrigger
            className="h-7 max-w-32 shrink-0 px-2 text-xs text-muted-foreground @max-sm/header-actions:hidden"
            aria-label="Thread owner"
          >
            <SelectValue>
              {workspaceUsers.find((user) => user.id === activeThreadOwnerUserId)?.displayName ??
                activeThreadOwnerUserId}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {workspaceUsers.map((user) => (
              <SelectItem key={user.id} hideIndicator value={user.id}>
                {user.displayName}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      ) : null}
      <div
        data-chat-header-actions
        className="flex shrink-0 items-center justify-end gap-2 @max-sm/header-actions:hidden @3xl/header-actions:gap-3"
      >
        {activeProjectScripts && (
          <ProjectScriptsControl
            scripts={activeProjectScripts}
            fileScripts={fileScripts}
            keybindings={keybindings}
            preferredScriptId={preferredScriptId}
            onRunScript={onRunProjectScript}
            onAddScript={onAddProjectScript}
            onUpdateScript={onUpdateProjectScript}
            onDeleteScript={onDeleteProjectScript}
          />
        )}
        {showOpenInPicker && (
          <OpenInPicker
            environmentId={activeThreadEnvironmentId}
            keybindings={keybindings}
            availableEditors={availableEditors}
            openInCwd={openInCwd}
          />
        )}
        {activeProjectName && (
          <GitActionsControl
            gitCwd={gitCwd}
            activeThreadRef={scopeThreadRef(activeThreadEnvironmentId, activeThreadId)}
            onOpenPullRequest={onOpenPullRequest}
            {...(draftId ? { draftId } : {})}
          />
        )}
      </div>
    </div>
  );
});
