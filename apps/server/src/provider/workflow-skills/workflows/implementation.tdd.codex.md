## Logging

When a ticket adds or reviews logging, logger calls, or logging infrastructure, load [logging.md](logging.md) with workflow_doc_get before editing. Add logging when the new behavior creates an operational question that tests cannot answer: failure cause, retry outcome, external boundary latency, fallback selection, or state transition. Apply the document's wide-event shape and completion checklist.

## Orchestrated Worker Result

When this prompt is run by an automatic implementation-worker thread, do not ask the user questions. In an orchestrated worker thread the Spec's Testing Decisions and the assigned ticket's acceptance criteria _are_ the pre-agreed seams — never ask the user to confirm them. Implement the assigned planning ticket, run focused validation, and finish with exactly one fenced JSON block using this shape:

- Run one focused failing test before implementation.
- After each behavioral slice, run the relevant focused test.
- At completion, run only affected-file formatting, linting, typing, and focused tests.
- Do not run launch-level complete validation commands or full test suites. A documented sub-minute fast check such as `pnpm check` is allowed. Final Code Review owns complete validation.
- Do not rerun an unchanged passing command unless a code change could affect its result.

```json
{
  "type": "implementation-worker-result",
  "ticketId": "planning-ticket-id",
  "workerThreadId": "thread-id",
  "branch": "worker-branch",
  "worktreePath": "/absolute/worktree",
  "status": "succeeded",
  "commitSha": "commit-sha",
  "validations": [
    {
      "command": "vp test targeted-test",
      "status": "passed",
      "outputMarkdown": "Important output or empty string.",
      "completedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "notesMarkdown": "What changed and remaining risks.",
  "reportedAt": "2026-01-01T00:00:00.000Z"
}
```

## Orchestrated QA Repair Result

When the launch message identifies an AppStack or Browser App Review failure, this is a QA repair thread rather than a planning-ticket worker. Load `app-dev-stack.md` before changing dependency or runtime setup. The programmatic diagnostics, original Spec/tickets or proposed plan, and the failed review are the pre-agreed seams. Do not ask the user to confirm them. Work red then green in the orchestrator worktree, run focused validation or a documented sub-minute fast check, commit the repair, leave the worktree clean, and finish with exactly one fenced JSON block using this shape. Final Code Review owns complete validation on the new HEAD; do not run launch-level complete validation commands here.

```json
{
  "type": "implementation-fix-result",
  "runId": "implementation-run-id",
  "status": "succeeded",
  "commitSha": "commit-sha",
  "validations": [
    {
      "command": "vp test targeted-test",
      "status": "passed",
      "outputMarkdown": "Important output or empty string.",
      "completedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "notesMarkdown": "What failed, the red-green repair, and remaining risks."
}
```
