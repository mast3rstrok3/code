import type {
  AppDevStack,
  AppDevStackListResult,
  OrchestrationReadModel,
} from "@t3tools/contracts";
const normalizeWorktreePath = (value: string) =>
  value
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/{2,}/gu, "/")
    .replace(/\/+$/u, "");

export function appDevStackWorkflowConflicts(
  stacks: ReadonlyArray<AppDevStack>,
  readModel: OrchestrationReadModel,
): NonNullable<AppDevStackListResult["workflowConflicts"]> {
  const groups = new Map<
    string,
    { stackIds: Set<string>; runIds: Set<string>; worktreePaths: Set<string> }
  >();
  const add = (workflowId: string, stack: AppDevStack, runId?: string) => {
    const group = groups.get(workflowId) ?? {
      stackIds: new Set<string>(),
      runIds: new Set<string>(),
      worktreePaths: new Set<string>(),
    };
    group.stackIds.add(stack.id);
    group.worktreePaths.add(normalizeWorktreePath(stack.worktreePath));
    if (runId !== undefined) group.runIds.add(runId);
    groups.set(workflowId, group);
  };

  for (const stack of stacks) {
    if (stack.workflowId) add(stack.workflowId, stack);
  }

  const stacksByPath = new Map(
    stacks.map((stack) => [normalizeWorktreePath(stack.worktreePath), stack] as const),
  );
  const threadsById = new Map(readModel.threads.map((thread) => [thread.id, thread] as const));
  for (const run of readModel.implementationRuns) {
    const workflowId = threadsById.get(run.orchestratorThreadId)?.workflowContext?.workflowId;
    const stack = stacksByPath.get(normalizeWorktreePath(run.orchestratorWorktreePath));
    if (workflowId !== undefined && stack !== undefined) add(workflowId, stack, run.id);
  }

  return [...groups.entries()]
    .filter(([, group]) => group.stackIds.size > 1)
    .map(([workflowId, group]) => ({
      workflowId,
      stackIds: [...group.stackIds].sort(),
      runIds: [...group.runIds].sort(),
      worktreePaths: [...group.worktreePaths].sort(),
    }))
    .sort((left, right) => left.workflowId.localeCompare(right.workflowId));
}
