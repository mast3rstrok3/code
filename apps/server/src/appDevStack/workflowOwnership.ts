import type {
  AppDevStack,
  AppDevStackListResult,
  OrchestrationReadModel,
} from "@t3tools/contracts";

export const normalizeWorkflowWorktreePath = (value: string) =>
  value
    .trim()
    .replaceAll("\\", "/")
    .replace(/\/{2,}/gu, "/")
    .replace(/\/+$/u, "");

type WorkflowConflict = NonNullable<AppDevStackListResult["workflowConflicts"]>[number];

/** Report only ownership shapes that can stop or reuse the wrong stack. */
export function appDevStackWorkflowConflicts(
  stacks: ReadonlyArray<AppDevStack>,
  readModel: OrchestrationReadModel,
): NonNullable<AppDevStackListResult["workflowConflicts"]> {
  const threadsById = new Map(readModel.threads.map((thread) => [thread.id, thread] as const));
  const expectedByWorkflow = new Map<
    string,
    Map<string, { readonly runIds: Set<string>; readonly roles: Set<"shared" | "ticket"> }>
  >();
  const workflowsByPath = new Map<string, Set<string>>();

  for (const run of readModel.implementationRuns) {
    const context = threadsById.get(run.orchestratorThreadId)?.workflowContext;
    if (context === undefined || context === null) continue;
    const workflowIds: string[] = [context.workflowId];
    if (context.parentWorkflowId !== null && context.parentWorkflowId !== undefined) {
      workflowIds.push(context.parentWorkflowId);
    }
    const addExpected = (workflowId: string, path: string, role: "shared" | "ticket") => {
      const normalizedPath = normalizeWorkflowWorktreePath(path);
      const paths = expectedByWorkflow.get(workflowId) ?? new Map();
      const expected = paths.get(normalizedPath) ?? {
        runIds: new Set<string>(),
        roles: new Set<"shared" | "ticket">(),
      };
      expected.runIds.add(run.id);
      expected.roles.add(role);
      paths.set(normalizedPath, expected);
      expectedByWorkflow.set(workflowId, paths);
      const workflows = workflowsByPath.get(normalizedPath) ?? new Set<string>();
      workflows.add(workflowId);
      workflowsByPath.set(normalizedPath, workflows);
    };
    for (const workflowId of workflowIds) {
      addExpected(workflowId, run.orchestratorWorktreePath, "shared");
      for (const state of run.ticketStates ?? []) {
        if (state.worktreePath !== null) addExpected(workflowId, state.worktreePath, "ticket");
      }
    }
  }

  const conflicts: WorkflowConflict[] = [];
  const explicitGroups = new Map<string, AppDevStack[]>();
  for (const stack of stacks) {
    if (!stack.workflowId) continue;
    const path = normalizeWorkflowWorktreePath(stack.worktreePath);
    const key = `${stack.workflowId}\0${path}`;
    const group = explicitGroups.get(key) ?? [];
    group.push(stack);
    explicitGroups.set(key, group);

    const expected = expectedByWorkflow.get(stack.workflowId)?.get(path);
    const otherOwners = [...(workflowsByPath.get(path) ?? [])].filter(
      (workflowId) => workflowId !== stack.workflowId,
    );
    if (
      expected === undefined &&
      (expectedByWorkflow.has(stack.workflowId) || otherOwners.length > 0)
    ) {
      conflicts.push({
        kind: "ownership-mismatch",
        workflowId: stack.workflowId,
        stackIds: [stack.id],
        runIds: [],
        worktreePaths: [path],
      });
    }
  }

  for (const [key, group] of explicitGroups) {
    if (group.length < 2) continue;
    const separator = key.indexOf("\0");
    const workflowId = key.slice(0, separator);
    const path = key.slice(separator + 1);
    const expected = expectedByWorkflow.get(workflowId)?.get(path);
    conflicts.push({
      kind: "duplicate-worktree",
      workflowId,
      stackIds: group.map((stack) => stack.id).sort(),
      runIds: [...(expected?.runIds ?? [])].sort(),
      worktreePaths: [path],
    });
  }

  return conflicts.toSorted((left, right) => {
    const workflow = left.workflowId.localeCompare(right.workflowId);
    if (workflow !== 0) return workflow;
    const kind = (left.kind ?? "").localeCompare(right.kind ?? "");
    return kind !== 0
      ? kind
      : left.worktreePaths.join("\0").localeCompare(right.worktreePaths.join("\0"));
  });
}
