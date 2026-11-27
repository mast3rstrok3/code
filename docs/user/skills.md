# Skills

T3 Code gives every Claude session a set of bundled skills: Matt Pocock's engineering and productivity skills from [mattpocock/skills](https://github.com/mattpocock/skills), plus T3 Code's own `workflow`, `app-review`, and `hill-climb` skills. They arrive as a Claude Code plugin named `t3`, so each skill's name starts with `t3:`.

## Run a skill

Type `/t3:<name>` or mention `$t3:<name>` in the composer, for example `/t3:tdd` or `$t3:diagnosing-bugs`. Claude also starts a skill on its own when a task matches the skill's description. Skills that Settings → Skills marks **Runs only when you invoke it**, such as `to-spec`, `grill-with-docs`, `workflow`, and `hill-climb`, start only when you type them.

Many engineering skills publish specs and tickets to an issue tracker. Run `/t3:setup-matt-pocock-skills` once in a repository to choose one. Without a tracker, they write Markdown under `.scratch/` in the project.

## Take a feature from brief to pull request

`/t3:workflow <brief>` makes the thread a conductor. It starts subagents that grill the plan, write a spec and tickets, review the tickets, build each ticket test-first in its own worktree, run an App Review of the end-to-end tests, then review the code and open a pull request. The conductor answers the planning questions itself from the brief and the codebase, and asks you only for decisions it cannot make.

## Raise a score round by round

`/t3:hill-climb <goal>` runs a loop against a rubric you approve first. Each round, three independent judges score the running app and cite repro steps for every deduction. Builders fix the problems most judges named, and a replayer re-checks every fix made in any round, so old fixes stay fixed. The loop keeps its state in a `loop/` folder, so a new session can resume it. It stops at your target score, after two rounds without progress, or when only problems you chose to keep remain.

## Read and extend skills

Settings → Skills shows each skill's full instructions, and Settings → Docs shows the supporting files the skills read. Under **Your default additions**, add your own instructions to a skill, such as project conventions or testing rules. Additions belong to the environment and reach Claude sessions started after you save.

## Providers

Only Claude sessions receive the bundled skills. Other providers list the skills they find in their own skill folders.

Matt Pocock's skills are MIT licensed; the license ships with the plugin.
