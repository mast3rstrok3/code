# Preview Browser QA

Browser App Review drives the T3-hosted collaborative browser through the `preview_*` MCP tools and attaches durable evidence through the `app_review_*` MCP tools. There is no CLI and no external browser: every browser action is an MCP tool call.

## Session flow

1. `preview_open` to show and initialize the thread's browser tab, then `preview_navigate` to the feature URL when the launch message provides one.
2. `app_review_recording_start` to begin the screen recording. Everything you do in the tab until `app_review_recording_stop` ends up in the review's video.
3. Interact, snapshotting between steps (see below).
4. `app_review_capture_screenshot` with a descriptive caption at each meaningful state.
5. `app_review_recording_stop`, then `app_review_update` with the full document and verdict.

## Snapshot before you interact

`preview_snapshot` returns the current URL, title, visible text, interactive elements (with selectors and coordinates), and a viewport screenshot. Always snapshot before the first interaction and re-snapshot after anything that changes the DOM (navigation, clicks that open dialogs, async loads). Selectors and coordinates from an old snapshot go stale.

Interaction tools:

- `preview_click` — one target per call: a Playwright `locator` (preferred, e.g. `role=button[name='Send']`), a legacy CSS `selector`, or an `x`/`y` pair from the latest snapshot.
- `preview_type` — types into a locator/selector, or the focused element when neither is given; `clear: true` empties the field first.
- `preview_press` — a single key (Enter, Escape, Tab, ArrowDown, ...) with optional modifiers.
- `preview_scroll` — scrolls the viewport or a locator/selector container by deltaX/deltaY.
- `preview_wait_for` — waits for a locator/selector, visible `text`, or `urlIncludes` condition. Use after actions that trigger async work instead of assuming the page settled.
- `preview_navigate` — direct URL or `{kind:'environment-port', port}` targets, with readiness waiting.

## Viewports

`preview_resize` switches the tab between `fill`, `freeform` (exact width/height), and named device `preset` modes. Use it to verify responsive behavior (for example a phone preset for mobile flows), and prefer returning to the default before capturing final evidence unless the review targets a specific viewport.

## preview_evaluate limits

`preview_evaluate` runs a JavaScript expression in the page and returns the serialized value (capped at 2 MB). Use it for inspection only — reading state, checking computed styles, probing app globals — not to drive the UI. Interactions must go through the semantic tools above so they appear in the recording like real user input.

## Evidence workflow

The review's evidence is server-authoritative: recordings and screenshots are stored on the server and attached to the App Review record; file paths never pass through you.

- `app_review_recording_start` / `app_review_recording_stop` bracket the whole testing session. Stop returns the recording evidence; status `failed` means no video was saved.
- `app_review_capture_screenshot` saves a PNG of the current tab with your caption and returns `{id, caption, capturedAt}`. Reference these ids in findings' `evidenceIds`.
- A passed verdict requires a saved recording plus at least one screenshot. A failed verdict normally uses the same evidence. If recording finalization fails after product testing, retain a failed verdict when at least one check failed and every actionable finding references a captured screenshot; the recording error remains visible as an evidence warning.
- If no trustworthy product evidence was captured, or no URL or usable preview exists, mark the review `failed` with concrete diagnostic details instead of inventing a target or using a third verdict.
