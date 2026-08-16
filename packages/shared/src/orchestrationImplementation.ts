import type { WorkflowPreset } from "@t3tools/contracts";
import * as Predicate from "effect/Predicate";

export const WORKFLOW_WORKSPACE_PREPARED_ACTIVITY_KIND = "workflow-workspace-prepared";

export interface WorkflowWorkspaceIdentity {
  readonly baseBranch: string;
  readonly branch: string;
  readonly worktreePath: string;
}

export function workflowPresetStartsInDedicatedWorkspace(
  preset: WorkflowPreset | null | undefined,
): boolean {
  return (
    preset === "planning" ||
    preset === "product-planning" ||
    preset === "full-feature" ||
    preset === "fast-feature"
  );
}

export function resolveWorkflowWorkspaceIdentity(
  activities: ReadonlyArray<{ readonly kind: string; readonly payload: unknown }>,
): WorkflowWorkspaceIdentity | null {
  for (let index = activities.length - 1; index >= 0; index -= 1) {
    const activity = activities[index];
    if (activity?.kind !== WORKFLOW_WORKSPACE_PREPARED_ACTIVITY_KIND) continue;
    if (!Predicate.isObject(activity.payload)) continue;
    const baseBranch = activity.payload["baseBranch"];
    const branch = activity.payload["branch"];
    const worktreePath = activity.payload["worktreePath"];
    if (
      !Predicate.isString(baseBranch) ||
      baseBranch.trim().length === 0 ||
      !Predicate.isString(branch) ||
      branch.trim().length === 0 ||
      !Predicate.isString(worktreePath) ||
      worktreePath.trim().length === 0
    ) {
      continue;
    }
    return { baseBranch, branch, worktreePath };
  }
  return null;
}

function slugifyBranchSegment(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug.length > 0 ? slug : "spec";
}

export function resolveImplementationBranchIdentity(input: {
  readonly specTitle: string;
  readonly specId: string;
  readonly baseBranch: string | null;
  readonly workspaceRoot: string | undefined;
  readonly implementationRuns: ReadonlyArray<{
    readonly orchestratorBranch: string;
    readonly orchestratorWorktreePath: string;
  }>;
  readonly branchPrefix?: string;
}): {
  readonly baseBranch: string;
  readonly orchestratorBranch: string;
  readonly orchestratorWorktreePath: string;
} {
  const baseBranch =
    input.baseBranch && input.baseBranch.trim().length > 0 ? input.baseBranch : "main";
  const slug = slugifyBranchSegment(input.specTitle || input.specId);
  const usedBranches = new Set(input.implementationRuns.map((run) => run.orchestratorBranch));
  const usedWorktrees = new Set(
    input.implementationRuns.map((run) => run.orchestratorWorktreePath),
  );

  let suffix = 0;
  while (true) {
    const disambiguator = suffix === 0 ? "" : `-${suffix + 1}`;
    const orchestratorBranch = `${input.branchPrefix ?? "implementation"}/${slug}${disambiguator}`;
    const worktreeBase = input.workspaceRoot?.replace(/[/\\]+$/, "") ?? "";
    const orchestratorWorktreePath =
      worktreeBase.length > 0
        ? `${worktreeBase}.worktrees/${slug}${disambiguator}`
        : `${slug}${disambiguator}`;
    if (!usedBranches.has(orchestratorBranch) && !usedWorktrees.has(orchestratorWorktreePath)) {
      return { baseBranch, orchestratorBranch, orchestratorWorktreePath };
    }
    suffix += 1;
  }
}
