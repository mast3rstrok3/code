# App Review

App Review is the evidence that a change works in the running app. The agent on a thread runs the project's end-to-end tests, tries the app in the browser, and records a verdict with its checks and findings. You replay what it saw in the thread's **App Review** panel.

## Start a review

Ask the agent for one, for example "run an App Review of this change". Agents that load T3 Code's skills, such as Claude, follow the bundled `app-review` skill; the empty App Review panel offers a button that puts `$t3:app-review` in the composer. Every agent can use the App Review tools, so any provider can run one.

A thread keeps every review its agent ran, newest first. Open the panel from the thread's right panel or the command palette (**Open App Review**). On mobile, open the thread's Git sheet and choose **App Review**.

## End-to-end tests

The agent runs the commands listed in `e2eCommands` in the project's `t3.json`, or `e2eAffectedCommands` for a branch. Each command runs in the thread's worktree, waits for the result, and joins the review with its exit status and an output tail. A command that runs longer than `e2eTimeoutMinutes` (45 minutes by default, at most 60) fails with a timeout.

Commands receive:

- `APP_REVIEW_PREVIEW_URL`: the app under test, by default the worktree's App Stack frontend.
- `APP_REVIEW_TEST_PLATFORMS`: comma-separated platforms such as `web,android`. iOS and macOS need a Mac server.
- `APP_REVIEW_STACK_ID`: the App Stack serving that URL, when the worktree has one.
- `APP_REVIEW_BASE_REF`: the commit the branch started from, when the agent passes one.
- `APP_REVIEW_ARTIFACT_DIR`: a directory that belongs to the review, for builds and receipts that should outlive the worktree.
- `APP_REVIEW_TEST_TIMEOUT_MS`: the command's time limit, so the suite can save partial results first.
- `APP_DEV_STACK_API_URL` and `APP_DEV_STACK_API_TOKEN`, when the server has Stacks controller access.

For tests that need a database or another service, set `e2ePreflight` in `t3.json`. T3 Code runs its read-only command before every test command: exit 0 means ready, and anything else stops the run with your `blockedReason`.

```json
{
  "e2ePreflight": {
    "command": "node scripts/check-e2e-readiness.mjs",
    "blockedReason": "The test environment operator must provide a reachable test database."
  }
}
```

### Test recordings

Every test can be replayed in the App Review panel: open a command and choose a test to watch it with play and scrub controls. Recordings capture the page, not pixels, so they stay small. Your suite launches its own browsers, so it attaches the recorder. T3 Code sets three variables for every command:

- `APP_REVIEW_RECORDER_SCRIPT`: a script to add to each browser context as an init script.
- `APP_REVIEW_RECORDER_BINDING`: the binding that script calls with batches of events. Expose it on the context and append each event of a batch as one JSON line.
- `APP_REVIEW_RECORDING_DIR`: write one file per test here, named `<test name>.rrweb.jsonl`.

With Playwright for Python this is a context fixture of a few lines: `context.expose_binding(name, handler)` and `context.add_init_script(path=script)`. T3 Code collects the directory when the command exits, whether it passed or failed. Skip the variables and the suite runs as before, without recordings.

The mobile app lists recorded tests; replay them on web or desktop.

## Browser checks

An agent with browser tools opens the app in the preview browser, records the session, and captures captioned screenshots at the states that matter. Findings point at those screenshots.

Browser recordings also capture the page rather than video. When a review starts on a page drawn mostly in canvas or WebGL, which a page recording cannot replay, T3 Code records video instead. A review recorded from the desktop app's browser is always video.

## Verdict

A review passes only with the evidence it covers: the latest run of every test command passing, and for browser checks a saved recording plus at least one screenshot. Otherwise the agent records a failure and says what was missing. Blocked checks say whether the gap is test coverage the agent can add, or a prerequisite such as credentials or a service that someone has to provide.
