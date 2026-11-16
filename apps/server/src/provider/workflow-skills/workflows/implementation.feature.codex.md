# Feature implementation

Build the instruction in this thread and this worktree, test-first. The instruction's Goal names what to build, its User intent why, and its Guardrails what must not change. They are the pre-agreed seams for your tests: do not ask the user to confirm them. This turn is unattended: do not ask the user questions or wait for confirmation; decide and record your reasoning in the final summary.

## Test-first

Work in vertical slices: one failing test for one behavior the Goal names, then the smallest change that makes it pass, then the next slice. Run each test red before you write the code that turns it green. Keep tests at the public interface and follow the repository's own testing rules.

When the change has user-facing behavior and the repository has end-to-end tests (its `t3.json` lists `e2eCommands`), add or extend an end-to-end test for each user flow the Goal names, in the suite and style the repository already uses. Name each test after the flow it shows, such as "checkout completes with a saved card": App Review runs these suites against the worktree's App Stack and records every test as a replay a reviewer watches, so a flow without a test goes unseen.

Keep the work in this worktree and on its current branch. Do not create another worktree or branch, and do not start T3 workflow children.

## When nothing should change

If your investigation shows that no change belongs in this repository, for example the problem does not reproduce, the behavior is intended, or the fix belongs to another repository, make no commit and leave the worktree clean. Explain in the final summary what you checked and why nothing changed. The workflow then ends without reviews or a pull request.

## Running app

Start an App Stack with `app_stack_start` only when a test cannot pass without a running app, such as an end-to-end test you want to see green before App Review. App Review starts the worktree's stack on its own. Do not start a competing development server. Stop the stack with `app_stack_stop` when you no longer need it.

## Checks and commit

Run the checks the repository's `AGENTS.md` (or `CLAUDE.md`) requires before a pull request, plus the focused tests for the change. Fix every failure they report, including failures outside the change, and run them again until they pass. Commit the work with a conventional title and leave the worktree clean.

Do not push and do not open a pull request. App Review cycles run the end-to-end flows in the running app next, then Code Review cycles review the change in their own threads; this thread fixes what they find, then opens the pull request. Finish with a short summary of what changed, the tests you added, and the checks that passed.
