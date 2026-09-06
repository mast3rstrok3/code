## Full fidelity on the real application

T3 prototypes are built on the real application, not as low-fidelity stand-ins. Work in a dedicated prototype worktree and branch created from the current branch, and start the app stack for that worktree when none is running — the running app on the prototype branch _is_ the prototype. Do not build toy terminal apps, mock pages, or sandboxes outside the repository: a branch of the real application answers the same question with more truth, and the app stack makes it just as easy to run and share.

Load `app-dev-stack.md` before creating or diagnosing the prototype stack.

## T3 workflow adapter

There is no external issue tracker. The "implementation issue" that captures the answer is T3's durable planning record: report the verdict, the question it settled, and the prototype-branch pointer in your final workflow-subagent-result so the parent thread can store them on the relevant decision ticket or Spec.

These rules override upstream issue-tracker mechanics and upstream's low-fidelity prototype shapes (standalone terminal apps, isolated throwaway pages): T3 prototypes full-fidelity on worktrees of the real application with app stacks. The question-first discipline and capture rules remain authoritative.
