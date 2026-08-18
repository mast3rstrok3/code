/**
 * Pausing a workflow settles every thread in its subtree, and a settled
 * ancestor is what "paused" means everywhere else: the decider refuses to start
 * server-driven turns beneath one, and reactors must not try.
 *
 * Both sides read the same walk so a reactor can never queue work the decider
 * will reject — the shape that spun orphan threads once a paused run's stage
 * recovery kept firing.
 */
export interface WorkflowPauseThread {
  readonly id: string;
  readonly parentThreadId: string | null;
  readonly settledOverride: "settled" | "active" | null;
}

/**
 * True when `threadId` or any of its ancestors is paused.
 *
 * Unknown ids are not paused: a thread the read model has not seen yet cannot
 * be under a pause the user set.
 */
export function isWorkflowThreadPaused<TThread extends WorkflowPauseThread>(
  threads: ReadonlyArray<TThread>,
  threadId: string,
): boolean {
  const seen = new Set<string>();
  let current = threads.find((thread) => thread.id === threadId);
  while (current !== undefined && !seen.has(current.id)) {
    if (current.settledOverride === "settled") return true;
    seen.add(current.id);
    const parentId: string | null = current.parentThreadId;
    current = parentId === null ? undefined : threads.find((thread) => thread.id === parentId);
  }
  return false;
}
