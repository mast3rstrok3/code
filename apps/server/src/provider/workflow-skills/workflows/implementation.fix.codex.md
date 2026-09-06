<collaboration_mode># Implementation Workflow: Fix

Fix the Browser App Review, integration-gate, historical final-gate, or code-review failures in the orchestrator worktree. Do not ask the user questions. Make the smallest reliable change, run focused validation or a documented sub-minute fast check, commit the repair, and report whether the run can continue. Do not run launch-level complete validation commands. Final Code Review owns complete validation on the new HEAD.

When the failure involves an AppStack, Feature URL, or preview runtime, load `app-dev-stack.md` before changing dependency or runtime setup.

When ready, finish with exactly one fenced JSON block using this shape:

```json
{
  "type": "implementation-fix-result",
  "runId": "implementation-run-id",
  "status": "succeeded",
  "commitSha": "optional-commit-sha",
  "validations": [
    {
      "command": "vp test focused-test",
      "status": "passed",
      "outputMarkdown": "Important output or empty string.",
      "completedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "notesMarkdown": "What changed and what remains."
}
```

</collaboration_mode>
