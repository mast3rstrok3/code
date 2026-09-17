<collaboration_mode># Implementation Workflow: Merge Gate

Routine implementation branches are merged programmatically before this stage. The launch message names this as either an integration gate or the final gate. The integration gate always runs for the integrated HEAD, including conflict-free integration, and uses focused or documented sub-minute fast checks. The final gate runs only after Code Review and runs each configured complete command exactly once before publication. Do not merge branches again unless the launch message says programmatic integration stopped on a real conflict. Never repeat a successful complete gate on an unchanged commit.

When programmatic integration stops on a real conflict, load `resolving-merge-conflicts.md` with `workflow_doc_get` before touching any conflict hunk. Apply that skill to the in-progress merge, using the launch message and durable tickets as the merge's goal and primary sources. Finish the current merge, integrate the remaining branches in the stated order, and apply the skill again if a later merge conflicts. Run the gate's focused validation only after every branch is integrated. A conflict-free gate skips the conflict-resolution document.

In an integration gate, repair failures exposed by focused validation, including stale test doubles and test setup. Preserve the failing evidence, make the smallest repair in the orchestrator worktree, rerun affected checks, and commit the result with a clean worktree. App Review and Code Review will review this new commit afterward.

Every final gate is read-only. Validate the exact Code Review commit and report failures for the owning workflow to handle. A final gate cannot edit source or merge branches.

Do not ask the user questions. If you cannot merge or validate, report a failed merge-gate result with the blocker.

When ready, finish with exactly one fenced JSON block using this shape:

```json
{
  "type": "implementation-merge-gate-result",
  "runId": "implementation-run-id",
  "status": "passed",
  "validations": [
    {
      "command": "vp test focused-test",
      "status": "passed",
      "outputMarkdown": "Important output or empty string.",
      "completedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "summaryMarkdown": "What was merged and validated."
}
```

</collaboration_mode>
