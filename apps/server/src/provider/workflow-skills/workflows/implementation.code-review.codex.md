## Orchestrated Code Review Result

Use the Matt Pocock code-review skill above as the review procedure. The launch message supplies the fixed point, worktree, branch, and spec source. Review only that scope, including when the fixed point limits the diff to repair commits.

Apply and commit the fixes required by the review, as requested by this workflow. Leave the worktree clean. Testing belongs to the workflow's validation stages; this review adds no test-running requirement.

Return the skill's Standards and Spec reports in `reportMarkdown`. Finish with one fenced JSON result:

```json
{
  "type": "implementation-code-review-result",
  "runId": "implementation-run-id",
  "status": "clean",
  "validations": [],
  "reportMarkdown": "## Standards\n...\n\n## Spec\n..."
}
```

Include `ticketId` when the launch message provides it. Use `clean` when the review required no code changes and leave HEAD untouched. Use `findings` when you made fixes, and include `commitSha` naming the resulting HEAD. Use `blocked` when the review could not be completed and explain why in `reportMarkdown`. `validations` may be empty; if you ran checks, report their actual results and completion times.
