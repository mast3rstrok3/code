import {
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
import { memo } from "react";
import GitActionsControl from "../GitActionsControl";
import { type DraftId } from "~/composerDraftStore";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import ProjectScriptsControl, {
  type NewProjectScriptInput,
  type ProjectScriptActionResult,
} from "../ProjectScriptsControl";
import { OpenInPicker } from "./OpenInPicker";
import { usePrimaryEnvironmentId } from "../../state/environments";
import { useT3ProjectFileScripts } from "~/hooks/useT3ProjectFileScripts";
import { ProjectFavicon } from "../ProjectFavicon";
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
        return "Implementation · Browser Dev Review";
      case "fixing":
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
      return "Implementation · Browser Dev Review";
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
  activeProjectName: string | undefined;
  activeProjectCwd: string | null;
  openInCwd: string | null;
  activeProjectScripts: ReadonlyArray<ProjectScript> | undefined;
  preferredScriptId: string | null;
  keybindings: ResolvedKeybindingsConfig;
  availableEditors: ReadonlyArray<EditorId>;
  rightPanelOpen: boolean;
  gitCwd: string | null;
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
  activeProjectName,
  activeProjectCwd,
  openInCwd,
  activeProjectScripts,
  preferredScriptId,
  keybindings,
  availableEditors,
  rightPanelOpen,
  gitCwd,
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
  const progressLabel = workflowProgressLabel(workflowProgress);
  return (
    <div className="@container/header-actions flex min-w-0 flex-1 items-center gap-2 sm:gap-3">
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-hidden sm:gap-3">
        {/* The project always leads the header: knowing which project a
            thread lives in is priority zero, and the thread title alone
            doesn't answer it. */}
        {activeProjectName ? (
          <span className="inline-flex shrink-0 items-center gap-2">
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
                  className="size-3.5"
                />
                <span className="max-w-40 truncate text-sm font-medium">{activeProjectName}</span>
              </TooltipTrigger>
              <TooltipPopup side="top">New thread in {activeProjectName}</TooltipPopup>
            </Tooltip>
            <span aria-hidden className="text-muted-foreground/40">
              /
            </span>
          </span>
        ) : null}
        <Tooltip>
          <TooltipTrigger
            render={
              <h2
                aria-label={activeThreadTitle}
                className="min-w-20 flex-1 truncate text-sm font-medium text-foreground"
              >
                {activeThreadTitle}
              </h2>
            }
          />
          <TooltipPopup side="top">{activeThreadTitle}</TooltipPopup>
        </Tooltip>
        {progressLabel === null ? null : (
          <Tooltip>
            <TooltipTrigger
              render={
                <Badge
                  variant="secondary"
                  size="sm"
                  aria-label={progressLabel}
                  className="min-w-0 max-w-[55%] shrink truncate"
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
              if (value === null) {
                return;
              }
              onOwnerUserIdChange(WorkspaceUserId.make(value));
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
      </div>
      <div
        data-chat-header-actions
        className={cn(
          "flex shrink-0 items-center justify-end gap-2 @max-sm/header-actions:hidden @3xl/header-actions:gap-3",
          rightPanelOpen ? "pr-0" : "pr-16",
        )}
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
            {...(draftId ? { draftId } : {})}
          />
        )}
      </div>
    </div>
  );
});
