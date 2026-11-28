---
name: hill-climb
description: "Raise a running app's score round by round: three judges score it against a frozen rubric, builders fix the ranked gaps, every past fix is replayed."
argument-hint: "What should be judged, and what does good look like?"
disable-model-invocation: true
---

You are the **conductor** of a hill climb. Each **round**, three judges score the running app against a frozen rubric, builders fix the gaps the judges name, and a replayer checks every fix ever made, so the climb never gives back ground it won. You own the loop directory, the integration branch, and every decision. Subagents judge, build, and replay.

The **integration branch** is the branch checked out in your worktree. The **stack** is the running app the judges score, serving that branch's HEAD.

## The loop directory

Everything the climb knows lives in `loop/`, so a fresh session can pick it up where this one stopped. Put it at the path the user names, else `.scratch/hill-climb/<slug>/loop/` in the worktree, and leave it untracked.

```
loop/
  state.md            one line per step: what ran, HEAD, score
  rubric.md           frozen; pasted verbatim into every judge brief
  judge-brief.md      rubric + how to reach the stack + "cite repro steps for every deduction"
  decisions.md        owner decisions and accepted trade-offs ("kept as is" with the reason)
  regressions.md      every item ever fixed, with its repro step; replayed each round
  rN/judge-{a,b,c}.md
  rN/gaps.md          merged gap list, ranked by how many judges named each item
  rN/<area>.md        one brief per builder, with disjoint file ownership
  rN/integration.md
  rN/replay.md        verdict per item: fixed / still fails / partly / kept by decision
```

`N` is the round number, starting at 1. Hand subagents paths into `loop/` and keep the content in the files.

Append a line to `state.md` when each step finishes, before the next one starts. The last line is where a resumed session continues:

```
r2 judge      a1b2c3d  64  (a 61, b 66, c 65)
r2 gaps       a1b2c3d  -   14 items, 2 kept by decision
r2 build      a1b2c3d  -   api, settings-ui
r2 integrate  e4f5a6b  -
r2 replay     e4f5a6b  -   9 fixed, 1 partly, 0 still fail
```

## 0. Resume

If `loop/state.md` exists, read it first, then the files of its last round, and continue with the step after its last line. Skip step 1.

## 1. Frame

Agree with the user on what is judged and what good looks like, then write:

- `rubric.md`: the criteria, each with what full marks look like and a weight, the weights summing to 100, and the target score.
- `judge-brief.md`: `rubric.md` pasted verbatim, then how to reach the stack (URL, sign-in, seeded data, devices, the tools that drive it), then the rule "cite repro steps for every deduction. A deduction without steps another agent can follow scores nothing."
- `decisions.md` and `regressions.md`, empty.

Bring the stack up on HEAD.

From here the rubric is **frozen**. Scores compare across rounds only while it stays word for word the same. When the user changes what good means, start a new climb in a new `loop/`.

Done when the user has approved `rubric.md` and an agent with no other context could reach the stack from `judge-brief.md` alone.

## 2. Judge

Start three judge subagents at once with the Agent tool, each in a fresh context, as judges a, b, and c. Each gets the path to `judge-brief.md` and its output path `rN/judge-<x>.md`, and nothing else, so its score is independent of the other judges and of earlier rounds. A judge scores every criterion and lists each deduction with its points and repro steps.

The round's score is the mean of the three. Done when all three files exist and every deduction carries repro steps. Send a judge back for any deduction that lacks them.

## 3. Rank the gaps

Merge the judges' deductions into `rN/gaps.md`, one item per distinct problem, with its repro steps and the judges who named it. Rank by how many judges named it, then by points deducted. Two kinds of item rank above all others: a regression that still failed in the last replay, and, when the score fell below the last round's, every deduction that is new since that round, because the last integration caused it.

Check each item against `decisions.md` and mark the ones it already settles "kept by decision". An item that needs the owner's call, such as a trade-off, a scope question, or a fix that breaks something the user wants, goes to the user with AskUserQuestion. Record the answer in `decisions.md` with its reason.

Done when every deduction maps to an item and every item is ranked or kept by decision.

## 4. Build

Take ranked items from the top and group them into **areas**. Each area owns a set of files that no other area touches: **disjoint ownership** is what lets builders run at once and merge clean. An item that needs files from two areas joins one of them, which then owns both. Leave the tail for the next round, because the judges will name the real problems again.

Write one brief per area, `rN/<area>.md`: its items with their repro steps, the files it owns, and the files it may read but leaves unchanged.

Start one builder subagent per brief, in the background with `isolation: "worktree"`. Each builder resets onto the integration branch tip, calls the Skill tool with `t3:tdd` to turn every repro step into a failing test before it fixes it, and reports which items it fixed.

Done when every builder has reported.

## 5. Integrate

Merge each builder's branch into the integration branch, run the affected tests, and redeploy the stack to the new HEAD. Write `rN/integration.md`: the branches merged, each conflict and its resolution, the tests run, and the new HEAD. A conflict means two briefs overlapped, so draw the areas differently next round.

Done when the affected tests pass and the stack serves the new HEAD.

## 6. Replay

Start a fresh replayer subagent with the paths to `judge-brief.md`, `rN/gaps.md`, and `regressions.md`. It follows the repro steps of every item this round built and every item in `regressions.md` on the stack, and writes `rN/replay.md` with one verdict per item: fixed, still fails, partly, or kept by decision.

Append each item that became fixed this round to `regressions.md`, with its repro step.

Done when every item in both lists has a verdict.

## 7. Climb or stop

Start the next round at step 2. Stop when one of these holds:

- the score reaches the target in `rubric.md`;
- two rounds in a row fail to raise the score;
- every open gap is kept by decision.

Report to the user the score per round from `state.md`, what is still open in the last `gaps.md`, and the path to `loop/`.
