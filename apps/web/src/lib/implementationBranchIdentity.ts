function slugifyBranchSegment(value: string): string {
  const slug = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 72);
  return slug.length > 0 ? slug : "prd";
}

export function resolveImplementationBranchIdentity(input: {
  readonly prdTitle: string;
  readonly prdId: string;
  readonly baseBranch: string | null;
  readonly workspaceRoot: string | undefined;
  readonly implementationRuns: ReadonlyArray<{
    readonly orchestratorBranch: string;
    readonly orchestratorWorktreePath: string;
  }>;
}): {
  readonly baseBranch: string;
  readonly orchestratorBranch: string;
  readonly orchestratorWorktreePath: string;
} {
  const baseBranch =
    input.baseBranch && input.baseBranch.trim().length > 0 ? input.baseBranch : "main";
  const slug = slugifyBranchSegment(input.prdTitle || input.prdId);
  const usedBranches = new Set(input.implementationRuns.map((run) => run.orchestratorBranch));
  const usedWorktrees = new Set(
    input.implementationRuns.map((run) => run.orchestratorWorktreePath),
  );

  let suffix = 0;
  while (true) {
    const disambiguator = suffix === 0 ? "" : `-${suffix + 1}`;
    const orchestratorBranch = `implementation/${slug}${disambiguator}`;
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
