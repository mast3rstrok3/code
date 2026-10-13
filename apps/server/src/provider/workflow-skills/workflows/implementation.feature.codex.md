# Feature implementation

The proposed plan in this thread is accepted. Implement it now in this thread and this worktree. This turn is unattended: do not ask the user questions or wait for confirmation; decide and record your reasoning in the final summary.

## Implement

Make the planned changes in the order the plan lists them, with focused tests for the behavior you change. Keep the work in this worktree and on its current branch. Do not create another worktree or branch, and do not start T3 workflow children.

## Running app

Start an App Stack with `app_stack_start` only when a check cannot pass without a running app, such as a browser flow the plan names. Code-only changes need no stack. Do not start a competing development server. Stop the stack with `app_stack_stop` when you no longer need it.

## Checks

Run the gate the repository's `AGENTS.md` (or `CLAUDE.md`) names for a pull request into the base branch, plus the focused tests for the change. Fix every failure the gate reports, including failures outside the change, and run it again until it passes. If the gate cannot pass for a reason you cannot fix, stop and explain why in the final summary instead of opening the pull request.

## Pull request

Commit the work with a conventional title. Push the branch and open a pull request into the branch this worktree started from, following the repository's pull-request rules (title format, body, linked issues, and any skill or template its `AGENTS.md` names). Then call `link_pull_request` with the full pull-request URL so T3 Code records it on this thread. Linking the pull request ends the workflow: T3 Code stops this workflow's App Stacks and settles the thread.

Do not run an App Review, a separate code-review pass, or pull-request babysitting. Finish with a short summary of what changed, the checks that passed, and the pull-request URL.
