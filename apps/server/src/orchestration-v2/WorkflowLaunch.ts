import type {
  ProjectId,
  ProviderInteractionMode,
  ScheduledTaskWorkflow,
  ServerSettings,
  WorkflowPreset,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { workflowPromptIdForPreset } from "@t3tools/shared/workflowPresets";
import * as Effect from "effect/Effect";

import {
  appendWorkflowSkillCommandSection,
  appendWorkflowStepInstructions,
} from "../provider/WorkflowPromptRegistry.ts";
import type { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { resolveProjectDevelopmentBranch } from "../vcs/developmentBranch.ts";

/**
 * The workflows a thread can be launched as without the composer, keyed by
 * the names `t3_thread_launch` and scheduled tasks accept.
 */
export const LAUNCHABLE_WORKFLOWS = {
  feature: { preset: "fast-plan", interactionMode: "plan" },
  engineering: { preset: "planning", interactionMode: "planning-workflow" },
} as const satisfies Record<
  ScheduledTaskWorkflow,
  { readonly preset: WorkflowPreset; readonly interactionMode: ProviderInteractionMode }
>;

/** The first message of a workflow thread: the task plus the workflow's skill and step instructions. */
export function workflowLaunchText(
  message: string,
  preset: WorkflowPreset,
  settings: ServerSettings | null,
): string {
  const workflowPromptId = workflowPromptIdForPreset(preset);
  return appendWorkflowStepInstructions(
    appendWorkflowSkillCommandSection(message, workflowPromptId),
    workflowPromptId,
    settings?.workflowStepInstructions ?? {},
  );
}

/**
 * A new worktree from the project's development branch, where a workflow
 * starts when nobody picks a base. Null when the checkout names no
 * development or default branch.
 */
export const developmentWorktreeStrategy = Effect.fn("developmentWorktreeStrategy")(
  function* (input: {
    readonly git: GitVcsDriver["Service"];
    readonly settings: ServerSettings | null;
    readonly workspaceRoot: string;
    readonly projectId: ProjectId;
  }) {
    const development = yield* resolveProjectDevelopmentBranch({
      git: input.git,
      settings: input.settings,
      cwd: input.workspaceRoot,
      projectId: input.projectId,
    });
    if (development === null) return null;
    const startFromOrigin =
      input.settings === null
        ? true
        : resolveProjectSettings(input.settings, input.projectId).settings
            .newWorktreesStartFromOrigin;
    return {
      type: "worktree" as const,
      baseRef: development.branch,
      startFromOrigin: startFromOrigin || !development.existsLocally,
    };
  },
);
