# Feature implementation

The proposed plan in this thread is accepted. Implement it now in this thread and this worktree. This turn is unattended: do not ask the user questions or wait for confirmation; decide and record your reasoning in the final summary.

## Implement

Make the planned changes in the order the plan lists them, with focused tests for the behavior you change. Keep the work in this worktree and on its current branch. Do not create another worktree or branch, and do not start T3 workflow children.

## When nothing should change

If your investigation shows that no change belongs in this repository, for example the problem does not reproduce, the behavior is intended, or the fix belongs to another repository, make no commit and leave the worktree clean. Explain in the final summary what you checked and why nothing changed. The workflow then ends without a Code Review or pull request.

## Running app

Start an App Stack with `app_stack_start` only when a check cannot pass without a running app, such as a browser flow the plan names. Code-only changes need no stack. Do not start a competing development server. Stop the stack with `app_stack_stop` when you no longer need it.

## Checks and commit

Run the checks the repository's `AGENTS.md` (or `CLAUDE.md`) requires before a pull request, plus the focused tests for the change. Fix every failure they report, including failures outside the change, and run them again until they pass. Commit the work with a conventional title and leave the worktree clean.

Do not push and do not open a pull request. Code Review cycles run next in their own threads; this thread fixes what they find, then opens the pull request. Finish with a short summary of what changed and the checks that passed.
