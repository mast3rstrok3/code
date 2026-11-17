# Wizard API contract (T3 Code fork ↔ Rudi backend)

Served by the Wizard instance of Code at `https://wizard.nightingale-ai.com`
(host: `127.0.0.1:7030`). Rudi-dev's backend is the only caller.

## Enabling and auth

- Enabled only when the server env has `T3CODE_WIZARD_API_TOKEN` (non-empty).
  Without it every `/api/wizard/*` route answers 404.
- Every request carries `Authorization: Bearer <token>`. Compare in constant
  time. Wrong or missing token: 401 with `{"error":"unauthorized"}`. The token
  never appears in logs or responses.
- `T3CODE_WIZARD_PROJECT_PATH` (default `/home/wizard/repos/healthcare-platform`)
  names the project Wizard threads work in; it must already be a project in
  Code. `T3CODE_WIZARD_BASE_BRANCH` (default `origin/dev`) is the base. The
  server fetches the base branch from `origin` before each new thread so the
  worktree starts from the newest `dev`.
- `T3CODE_WIZARD_PUBLIC_URL` (default `https://wizard.nightingale-ai.com`) is
  the origin `WizardThread.url` points at.
- The Wizard's words are untrusted input to an agent, same as a webhook body.

## Types (JSON, camelCase)

```ts
type Wizard = { id: string; name: string; email?: string }; // Rudi user id + display name; id at most 57 characters; email is accepted but not stored or returned

type ModelChoice = { provider: string; model: string; effort?: string };

type WizardThread = {
  threadId: string;
  title: string;
  wizard: Wizard;
  state: "starting" | "working" | "waiting" | "idle" | "error" | "archived";
  branch: string | null; // wizard/<wizard-slug>/<title-slug>
  createdAt: string;
  updatedAt: string;
  url: string; // https://wizard.nightingale-ai.com/<route to the thread>, for the owner to take over
  stack: {
    stackId: string;
    status: string;
    urls: Record<string, string>;
    testPassword: string | null;
  } | null;
  pullRequest: { number: number; url: string; state: string; draft: boolean } | null;
  model: ModelChoice | null;
};

type TranscriptItem = {
  id: string;
  seq: number; // strictly increasing per thread; the cursor
  kind: "user" | "assistant" | "reasoning" | "tool" | "command" | "diff" | "status" | "error";
  createdAt: string;
  text?: string; // markdown for user/assistant/reasoning/status/error
  tool?: { name: string; input?: string; output?: string; status: "running" | "done" | "failed" };
  command?: { command: string; output?: string; exitCode?: number | null };
  diff?: { files: { path: string; additions: number; deletions: number }[]; patch?: string };
  final?: boolean; // false while the item is still streaming; it is resent with the same id/new seq when it grows
};
// `seq` values are large integers (microseconds since the epoch at the change).
// After a server restart every item comes once more with a higher seq, so keep
// items by `id`. Long command outputs keep their last 20 000 characters and
// patches their first 50 000.
```

## Routes

| Method | Path                                                                     | Body                                                                                                | Answer                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------ | ------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GET    | `/api/wizard/models`                                                     |                                                                                                     | `{ models: { provider, model, label, efforts: string[], defaultEffort?: string }[], default: ModelChoice }`                                                                                                                                                                                                                                                                                                                |
| POST   | `/api/wizard/threads`                                                    | `{ wizard: Wizard, message: string, title?: string, model?: ModelChoice, clientRequestId: string }` | 201 `WizardThread`. Same `clientRequestId` from the same Wizard again returns the same thread with 201 (idempotent). Creates the worktree from the base, tags the thread `wizard`, `wizard:<wizard.id>` and `wizard-name:<name>` (the name, cut to fit a 64-character tag), sends `message` as the first turn. Without `title`, the title is the message's first line. The branch gets `-2`, `-3`… when the name is taken. |
| GET    | `/api/wizard/threads?wizardId=<id>`                                      |                                                                                                     | `{ threads: WizardThread[] }`, newest first; without `wizardId` all of them                                                                                                                                                                                                                                                                                                                                                |
| GET    | `/api/wizard/threads/:threadId`                                          |                                                                                                     | `WizardThread` (404 for a thread that is not a Wizard thread)                                                                                                                                                                                                                                                                                                                                                              |
| POST   | `/api/wizard/threads/:threadId/messages`                                 | `{ message: string, model?: ModelChoice, clientRequestId: string }`                                 | 202 `{ accepted: true }`; queued if a turn is running. The same `clientRequestId` again sends nothing new.                                                                                                                                                                                                                                                                                                                 |
| POST   | `/api/wizard/threads/:threadId/interrupt`                                |                                                                                                     | 202 `{ accepted: true }`                                                                                                                                                                                                                                                                                                                                                                                                   |
| GET    | `/api/wizard/threads/:threadId/transcript?after=<seq>&waitMs=<0..25000>` |                                                                                                     | `{ items: TranscriptItem[], cursor: number, thread: WizardThread }`. Long-poll: with `waitMs` the call holds until there are items after `after` or the wait ends. `after` omitted = from the start.                                                                                                                                                                                                                       |

Errors: `{ "error": "<code>", "message": "<human text>" }` with 400/401/404/409/503:

- 400 `invalid_request` (body or query), `too_large`, `invalid_model`
- 401 `unauthorized`; 404 `not_found` (also every route while the API is off)
- 409 `message_refused` (the thread would not take the message)
- 503 `project_missing`, `base_unavailable`, `no_default_model`, `unavailable`

The API does not start App Stacks: the agent in the thread starts one with its
tools, so no route answers `cluster_full`. A stack that cannot start shows in
the transcript, and `WizardThread.stack` reports its status.

## Owner's view

Wizard threads show in Code's sidebar with the Wizard's name, and the
sidebar's wand button shows only Wizard threads (the archive follows it). The owner can open any thread and
send messages in it as usual.
