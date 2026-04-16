interface TerminalSnapshotLike {
  readonly cwd: string;
  readonly worktreePath: string | null;
}

export function resolvePreferredThreadWorktreePath(input: {
  readonly threadShellWorktreePath: string | null;
  readonly threadDetailWorktreePath: string | null;
}): string | null {
  return input.threadDetailWorktreePath ?? input.threadShellWorktreePath ?? null;
}

export function resolveTerminalOpenLocation(input: {
  readonly terminalSnapshot: TerminalSnapshotLike | null;
  readonly activeSessionSnapshot: TerminalSnapshotLike | null;
  readonly workspaceRoot: string;
  readonly threadShellWorktreePath: string | null;
  readonly threadDetailWorktreePath: string | null;
}): {
  readonly cwd: string;
  readonly worktreePath: string | null;
} {
  const preferredThreadWorktreePath = resolvePreferredThreadWorktreePath({
    threadShellWorktreePath: input.threadShellWorktreePath,
    threadDetailWorktreePath: input.threadDetailWorktreePath,
  });

  return {
    cwd:
      input.terminalSnapshot?.cwd ??
      input.activeSessionSnapshot?.cwd ??
      preferredThreadWorktreePath ??
      input.workspaceRoot,
    worktreePath:
      input.terminalSnapshot?.worktreePath ??
      input.activeSessionSnapshot?.worktreePath ??
      preferredThreadWorktreePath,
  };
}
