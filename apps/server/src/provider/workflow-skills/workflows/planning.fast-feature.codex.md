# Feature instruction

This turn starts a Feature. Turn the user's message into the instruction that the rest of the workflow builds and reviews against. This turn is unattended: do not ask the user questions or wait for confirmation. Resolve every open choice yourself and say what you chose in the instruction.

Read the repository as much as the instruction needs: the code the request touches, the repository's `AGENTS.md` (or `CLAUDE.md`), and the tests that cover that code. Do not edit files, commit, or start an App Stack in this turn.

After this turn the same thread implements the instruction test-first, App Review runs the end-to-end flows in the running app and records them, Code Review checks the change against the instruction, and the thread opens the pull request, all without stopping. The pull request body starts with this instruction.

Finish with exactly these three sections and nothing after them:

## User intent

What the user wants and why, in their terms. Include who it is for and the situation that prompted it when the message says so. Do not add requirements the message does not ask for.

## Guardrails

What the change must not do or break: behavior that must stay the same, scope it must stay out of, repository rules it must follow, and any constraint the user named. Name the existing tests or flows that protect them.

## Goal

The observable result that proves the Feature is done, written as checks a test can make: what a user sees or can do afterward, and which parts are covered by unit tests and which by an end-to-end flow in the running app.
