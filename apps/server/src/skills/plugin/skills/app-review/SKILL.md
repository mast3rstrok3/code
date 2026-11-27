---
name: app-review
description: Verify a change works in the running app and record the evidence in T3 Code's App Review. Use when asked for an App Review, to run the end-to-end tests, or to check a feature in the browser before calling it done.
---

# App Review

An App Review is the evidence that a change works in the real app, kept on this thread where the user replays it. You gather the evidence with the `app_review_*` tools and end on a verdict. The review is done when its status is `passed` or `failed` and every check in its document has a status.

## 1. Start

Call `app_review_start` with a `scope` and a one-sentence `brief` naming what is under review.

- `e2e`: the project's end-to-end test commands.
- `browser`: you drive the app in the preview browser.
- `both` (default): tests first, then the browser.

Pick `browser` or `both` only when the `preview_*` tools are available to you.

## 2. Run the end-to-end tests

Read `e2eCommands` from the worktree's `t3.json`. For a branch, prefer `e2eAffectedCommands` and pass `baseRef` (the commit the branch started from). With no commands configured, ask the user which command runs the suite.

Run each command with `app_review_run_test`. Every browser the suite launches is recorded as a DOM replay the user can watch in the review. A failed result lists its log files: read them, find the cause, and record it as a finding. After a fix, rerun the command; only its latest run counts toward the verdict.

If the tool reports that test prerequisites are not ready, the project's `e2ePreflight` check failed. Record the check as blocked with blockerKind `external-prerequisite` and say what the reason names.

## 3. Check the app in the browser

1. `preview_open` the app: its dev server as `target`, or the App Stack frontend URL from `app_stack_get`.
2. `app_review_recording_start`.
3. Walk through the behaviour the brief names with the `preview_*` tools, as a user would.
4. `app_review_capture_screenshot` at each state that proves or disproves a check, with a caption saying what it shows.
5. `app_review_recording_stop`.

## 4. Record the verdict

Call `app_review_update` with the complete `document`:

- `checks`: one per behaviour you verified, each `passed`, `failed`, `blocked` or `not-applicable`, with notes saying what you saw.
- `findings`: one per defect, with severity, reproduction steps, and the screenshot ids that show it in `evidenceIds`.
- `summary`, `questions`, `nextSteps`, and a `verdict` that matches the checks.

Set `status` in the same call. `passed` needs the evidence the scope covers: the latest run of every test command passing, and a saved recording plus a screenshot. When the evidence falls short, set `failed` and explain why in the summary.
