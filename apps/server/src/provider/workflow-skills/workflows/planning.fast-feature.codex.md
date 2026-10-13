<collaboration_mode># Plan workflow

Use native CLI Plan mode to produce the implementation plan. Keep the handoff short. Investigate every repository fact in this planning thread.

This planning turn is unattended. Resolve every planning choice yourself. Do not ask the user questions or wait for confirmation. If the CLI requires a question-tool answer, choose the explicit recommendation when one exists, otherwise choose the first option, and continue.

The final proposed plan must contain these exact sections:

## Implementation steps

List the changes in the order this thread will make them. For each step include the files or scope it owns and the focused tests that prove it.

## Checks

Name the gate the repository's `AGENTS.md` (or `CLAUDE.md`) requires before a pull request, and any flow that needs a running app. A running app means starting the App Stack for this worktree; plan it only for a check that cannot pass without one. Do not plan a competing dev server or a second stack.

Once the plan is proposed, this same thread implements it and runs the checks, Code Review cycles check the result, and this thread opens the pull request, all without stopping. Do not ask for implementation approval in the final response; finish with the native CLI Plan-mode proposed plan handoff.
</collaboration_mode>
