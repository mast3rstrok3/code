---
name: workflow
description: "Take a brief to a reviewed pull request with subagents: grill, spec, tickets, parallel TDD, App Review, code review, PR."
argument-hint: "What should be built?"
disable-model-invocation: true
---

You are the **conductor**. You own the brief, the integration branch, and every decision. Subagents do the work; you start them, answer them, and merge what they return.

## Subagents

Start every subagent with the Agent tool and a fresh context window. Give it its skill by full name, because this plugin namespaces skills as `t3:<name>`: "call the Skill tool with `t3:tdd`". `t3:to-spec` and `t3:to-tickets` are user-invoked, so the Skill tool refuses them; hand the subagent the file instead. Every bundled skill sits beside this one: `<this skill's base directory>/../to-spec/SKILL.md`.

Talk to subagents through **context pointers**: the spec path, ticket paths, branch names, commits. Keep shared notes in a scratch directory outside the repository that every subagent can read.

The **integration branch** is the branch checked out in your worktree. Everything lands there.

## 1. Grill

Start one **planner subagent** with the user's brief verbatim. It calls the Skill tool with `t3:grilling` and `t3:domain-modeling`, with you in the user's seat: it returns each grilling round as its final report.

Answer each round from the brief, the codebase, and sensible defaults, then continue the same planner with your answers (SendMessage). Ask the user only for a decision that only they can make, where a wrong guess changes what gets built.

Done when the planner reports an empty frontier and you confirm the shared understanding.

## 2. Spec and tickets

Continue the same planner, which holds the whole design tree: it follows `to-spec/SKILL.md`, then `to-tickets/SKILL.md`, and you answer the ticket quiz. Without a configured issue tracker, it publishes local markdown under `.scratch/<feature-slug>/`.

Each ticket names its **end-to-end tests**: the user flows it proves in the running app, written as tests its implementer adds.

Done when the spec and every ticket are published and the planner reports their paths.

## 3. Review the tickets

Start a fresh **ticket reviewer subagent** with pointers to the spec and the tickets. In one pass it checks every ticket against the spec and the codebase for gaps, wrong blocking edges, slices that are not vertical, and missing end-to-end tests, and fixes the tickets in place.

Done when the reviewer reports its changes and every user story in the spec maps to at least one ticket.

## 4. Implement

The tickets form a **task graph**; the **frontier** is every open ticket whose blockers are resolved. For each frontier ticket, start one **implementer subagent** in the background with `isolation: "worktree"`, so the frontier runs concurrently. Each implementer:

- resets its worktree onto the integration branch tip when it starts anywhere else;
- calls the Skill tool with `t3:tdd` to build the ticket, its end-to-end tests included;
- merges the integration branch tip into its branch and reruns the affected tests before it reports.

When an implementer reports, merge its branch into the integration branch, mark the ticket resolved, and start implementers for the tickets the merge unblocked. On a conflict, start a **merger subagent** with [resolving-merge-conflicts.md](resolving-merge-conflicts.md).

Done when every ticket is resolved on the integration branch, the affected tests pass there, and every implementer worktree is removed.

## 5. App Review

Start a fresh **app reviewer subagent** on your worktree. It calls the Skill tool with `t3:app-review` and runs the implementers' end-to-end tests, recorded as DOM replays in an App Review for this thread. Send what it reports to a fresh implementer, merge, and review again.

Done when the App Review passes on the integration branch tip.

## 6. Code review and pull request

Start a fresh **reviewer subagent** on your worktree. It calls the Skill tool with `t3:code-review` against the integration branch's base, fixes every finding it confirms, and reruns the affected tests. It then calls the Skill tool with `t3:pr` to write the body and opens the pull request, linking the spec, the tickets, and the App Review.

Done when the pull request is open. Report its URL, the spec, and the App Review to the user.
