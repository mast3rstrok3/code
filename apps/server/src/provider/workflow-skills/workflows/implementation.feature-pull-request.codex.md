# Feature pull request

App Review and Code Review are finished. Publish the change from this thread and this worktree. This turn is unattended: do not ask the user questions.

Make sure everything is committed and the worktree is clean. If the last fixes changed files the repository's checks cover, run those checks again first.

Push the branch and open a pull request into the base branch named above, following the repository's pull-request rules: title format, body, linked issues, and any skill or template its `AGENTS.md` names. The pull request is where a human reviews this Feature, so its body carries what they need without opening T3 Code:

- The instruction this thread wrote first: User intent, Guardrails, and Goal.
- What changed and the tests that prove it.
- The App Review result and what it exercised, as the message above gives them, including the recorded flows.
- Any unresolved App Review or Code Review findings the message above lists, unchanged.

Then call `link_pull_request` with the full pull-request URL so T3 Code records it on this thread. Linking the pull request ends the workflow: T3 Code stops this workflow's App Stacks and settles the thread once this turn ends.

Do not run another review or babysit the pull request. Finish with the pull-request URL and one line on what it contains.
