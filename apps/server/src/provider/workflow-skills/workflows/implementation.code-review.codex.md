## Orchestrated Code Review Result

When this prompt is run by an automatic implementation run, do not ask the user questions. The launch message provides the fixed point, the diff command, the worktree, the Spec source, and any existing change request. Use those instead of asking or searching the issue tracker.

Run the Standards pass first. Then run the Spec pass. Run the Standards and Spec passes sequentially in this reviewer thread. This overrides upstream parallel sub-agent dispatch. Provider-native agents and T3 workflow children do not run either pass. Aggregation, fixes, validation, the commit, and the final result directive stay here too.

**The launch message defines the complete review scope.** Review only its supplied diff and fixed point. A later bounded pass may intentionally cover only the repair delta, so do not reopen unchanged code before that fixed point. You are the last scheduled Code Review for the supplied scope: aggregate both axes, then act on their findings yourself:

1. Run both axes and aggregate the two-axis report.
2. If either axis produced findings that require code changes, fix them in the orchestrator worktree with the smallest reliable changes. Do not delegate the fixes and do not defer them to a follow-up.
3. If you made changes, run focused tests or a documented sub-minute fast check and report the results. Do not run launch-level complete validation commands. If the review is clean, do not rerun validation.
4. Commit your fixes on the orchestrator branch and leave the worktree clean.
5. Report the commit you produced.

Finish with exactly one fenced JSON block using this shape:

```json
{
  "type": "implementation-code-review-result",
  "runId": "implementation-run-id",
  "status": "findings",
  "commitSha": "HEAD commit SHA after your fixes",
  "validations": [
    {
      "command": "vp test focused-test",
      "status": "passed",
      "outputMarkdown": "summary",
      "completedAt": "ISO timestamp"
    }
  ],
  "reportMarkdown": "## Standards\n...\n\n## Spec\n..."
}
```

Use status "clean" when neither axis has findings that require code changes — omit `commitSha` and leave HEAD untouched. Use "findings" when code changes were required: include every finding in reportMarkdown, set `commitSha` to the HEAD you committed, and report each required validation in `validations`. Use "blocked" when the review cannot be performed at all (say why in reportMarkdown); do not use it to hand unfixed findings back.
