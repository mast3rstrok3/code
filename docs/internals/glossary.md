# Glossary

> For maintainers. Using T3 Code? See [docs/user](../user/).

This is a living glossary for T3 Code. It explains what common terms mean in this codebase.

## Table of contents

- [Project and workspace](#project-and-workspace)
- [Thread timeline](#thread-timeline)
- [Orchestration](#orchestration)
- [Provider runtime](#provider-runtime)
- [Checkpointing](#checkpointing)
- [Workflows](#workflows)

## Concepts

### Project and workspace

#### Project

The top-level workspace record in the app. In [the orchestration contracts][1], a project has a `workspaceRoot` and a title. It does not contain threads: `OrchestrationProject` and `OrchestrationThread` are separate arrays on the read model, and a project can have zero threads. See [workspace-layout.md][2].

#### Workspace root

The root filesystem path for a project. In [the orchestration model][1], it is the base directory for branches and optional worktrees. See [workspace-layout.md][2].

#### Worktree

A Git worktree used as an isolated workspace for a thread. If a thread has a `worktreePath` in [the contracts][1], it runs there instead of in the main working tree. Git operations live behind the VCS driver contract in `apps/server/src/vcs/VcsDriver.ts`, implemented by [GitVcsDriverCore.ts][3].

### Thread timeline

#### Thread

The main durable unit of conversation and workspace history. In [the orchestration contracts][1], a thread holds messages, activities, checkpoints, and session-related state. See [projector.ts][4].

#### Turn

A single user-to-assistant work cycle inside a thread. It starts with user input and ends when the session leaves `running` status, which [projector.ts][4] treats as the authoritative completion signal (`settledTurnStateForSessionStatus`). Checkpoint and diff work may settle afterward without changing when the turn ended. See [the contracts][1] and [ProviderRuntimeIngestion.ts][5].

#### Activity

A user-visible log item attached to a thread. In [the contracts][1], activities cover important non-message events like approvals, tool actions, and failures. They are projected into thread state in [projector.ts][4].

### Orchestration

Orchestration is the server-side domain layer that turns runtime activity into stable app state. The main entry point is [OrchestrationEngine.ts][7], with core logic in [decider.ts][8] and [projector.ts][4].

#### Aggregate

The domain object a command or event belongs to. In [the contracts][1], that is usually `project` or `thread`. See [decider.ts][8].

#### Command

A typed request to change domain state. In [the contracts][1], commands are validated in [commandInvariants.ts][9] and turned into events by [decider.ts][8].
Examples include `thread.create`, `thread.turn.start`, and `thread.checkpoint.revert`.

#### Domain Event

A persisted fact that something already happened. In [the contracts][1], events are the source of truth, and [projector.ts][4] shows how they are applied.
Examples include `thread.created`, `thread.message-sent`, and `thread.turn-diff-completed`.

#### Decider

The pure orchestration logic that turns commands plus current state into events. The core implementation is in [decider.ts][8], with preconditions in [commandInvariants.ts][9].

#### Projection

A read-optimized view derived from events. See [projector.ts][4], [ProjectionPipeline.ts][11], and [ProjectionSnapshotQuery.ts][10].

#### Projector

The logic that applies domain events to the read model or projection tables. See [projector.ts][4] and [ProjectionPipeline.ts][11].

#### Read model

The current materialized view of orchestration state. In [the contracts][1], it holds projects, threads, messages, activities, checkpoints, and session state. See [ProjectionSnapshotQuery.ts][10] and [OrchestrationEngine.ts][7].

#### Reactor

A side-effecting service that handles follow-up work after events or runtime signals. Examples include [CheckpointReactor.ts][6], [ProviderCommandReactor.ts][12], and [ProviderRuntimeIngestion.ts][5].

#### Receipt

A typed signal emitted when an async milestone completes, such as `checkpoint.baseline.captured`, `checkpoint.diff.finalized`, or `turn.processing.quiesced`. Receipts are a test-only mechanism: the production `RuntimeReceiptBusLive` publish is a no-op and only the test layer is PubSub-backed. Do not build production behavior on them. See [RuntimeReceiptBus.ts][13] and [CheckpointReactor.ts][6].

#### Quiesced

"Quiesced" means a turn has gone quiet and stable: follow-up work such as [CheckpointReactor.ts][6] has settled. It appears in [the receipt schema][13], so in practice it is something tests wait on rather than a production signal.

### Provider runtime

The live backend agent implementation and its event stream. The main service is [ProviderService.ts][14], the adapter contract is [ProviderAdapter.ts][15], and the overview is in [providers.md][16].

#### Provider

The backend agent runtime that actually performs work. Five drivers ship built in: Codex, Claude, Cursor, Grok, and OpenCode. See [ProviderService.ts][14], [ProviderAdapter.ts][15], and [CodexAdapter.ts][17] as a representative adapter.

#### Session

The live provider-backed runtime attached to a thread. Session shape is in [the orchestration contracts][1], and lifecycle is managed in [ProviderService.ts][14].

#### Runtime mode

The safety/access mode for a thread or session. [The contracts][1] define four values: `approval-required`, `auto-accept-edits`, `auto`, and `full-access`. See [permission modes][18].

#### Interaction mode

The agent interaction style for a thread. In [the contracts][1], the values are `default` and `plan`.

#### Assistant delivery mode

Controls how assistant text reaches the thread timeline. In [the contracts][1], `streaming` updates incrementally and `buffered` accumulates text. Buffered delivery is not held until the turn completes: it spills once accumulated text would exceed 24,000 characters, and flushes at approval and user-input boundaries. See [ProviderRuntimeIngestion.ts][5].

#### Snapshot

A point-in-time view of state. The word is used in multiple layers, including orchestration, provider, and checkpointing. See [ProjectionSnapshotQuery.ts][10], [ProviderAdapter.ts][15], and [CheckpointStore.ts][19].

### Checkpointing

Checkpointing captures workspace state over time so the app can diff turns and restore earlier points. The main pieces are [CheckpointStore.ts][19], [CheckpointDiffQuery.ts][20], and [CheckpointReactor.ts][6].

#### Checkpoint

A saved snapshot of a thread workspace at a particular turn. In practice it is a hidden Git ref in [CheckpointStore.ts][19] plus a projected summary from [ProjectionCheckpoints.ts][21]. Capture and lifecycle work happen in [CheckpointReactor.ts][6].

#### Checkpoint ref

The durable identifier for a filesystem checkpoint, stored as a Git ref. It is typed in [the contracts][1], constructed in [Utils.ts][22], and used by [CheckpointStore.ts][19].

#### Checkpoint baseline

The starting checkpoint for diffing a thread timeline. This flow is surfaced through [RuntimeReceiptBus.ts][13], coordinated in [CheckpointReactor.ts][6], and supported by [Utils.ts][22].

#### Checkpoint diff

The patch difference between two checkpoints. Query logic lives in [CheckpointDiffQuery.ts][20], diff parsing lives in [Diffs.ts][23], and finalization is coordinated by [CheckpointReactor.ts][6].

#### Turn diff

The file patch and changed-file summary for one turn. It is usually computed in [CheckpointDiffQuery.ts][20], represented in [the contracts][1], and recorded into thread state by [projector.ts][4].

### Workflows

Workflows are the server-orchestrated automation paths that chain planning and implementation stages across threads and worktrees. The presets live in [workflowPresets.ts][25], the built-in skills and docs in [WorkflowPromptRegistry.ts][26], and the stage handoffs in [workflowDirectives.ts][27]. See [workflow-catalog.md][28].

#### Workflow (preset)

One of the five selectable orchestration paths — Fast Feature, Full Feature, Wayfinder, Planning, or Implementation — defined in [workflowPresets.ts][25]. Each preset maps to an interaction mode and an ordered list of skill-backed steps. Legacy Fix and App Review preset values remain decodable but are not selectable; App Review is launched as a nested or panel-owned run.

#### Workflow ID

The durable identity of one workflow run. A top-level controller creates the ID and its owned children inherit it. A nested workflow creates a new ID and records its enclosing run as `parentWorkflowId`. Workflow links and AppDevStack ownership use this identity rather than a thread ID or preset name.

#### App Review Workflow

A durable workflow made of budgeted three-step cycles: human-style Browser App Review, same-thread gap analysis and repair planning, then plan implementation in a fresh child thread using the Implement skill. It can run standalone against an in-place worktree or as a nested workflow below Implementation.

#### App Review controller

The persistent thread that owns one App Review run and keeps the original brief across cycles. Each cycle gets a fresh reviewer thread; that reviewer switches to CLI Plan mode after a failed review so its evidence, gap analysis, and plan remain together. Implementation happens in a new child thread.

#### App Review cycle

One complete App Review budget unit: UI review, same-thread gap analysis and plan after a failure, and implementation in a new thread. The initial review is cycle 1. A pass completes its cycle without the unnecessary planning and implementation steps; the final failed cycle still implements its plan before the run becomes exhausted.

#### App Review outcome

The terminal result of an App Review Workflow: `passed`, `failed`, or `exhausted`. Exhausted means every complete cycle in the configured budget was consumed and the final implemented repair has no remaining verification cycle. Failed means automation could not complete a valid cycle; cancellation is recorded as a failed run with diagnostic detail rather than as a separate verdict.

#### Skill (workflow prompt)

The focused built-in instructions for one workflow step, identified by a stable prompt ID such as `planning.spec.codex`. Skills are inline constants in [WorkflowPromptRegistry.ts][26], derived near-verbatim from Matt Pocock's skills with a T3 adapter section.

#### Workflow doc

A supporting reference a skill can load on demand with `workflow_doc_get` — for example the CONTEXT.md and ADR formats. Docs are deduplicated by global ID in [WorkflowPromptRegistry.ts][26] and only their metadata is injected into prompts.

#### Product grill

The codebase-grounded, product-only composition of the shared Grilling primitive. It asks every currently unblocked product-decision question in numbered frontier rounds and ends in a `product-intent-locked` directive parsed by [workflowDirectives.ts][27]. Fast Feature and Full Feature begin here.

#### Engineering grill

The Planning composition of the shared Grilling primitive and the full domain-modeling discipline. Standalone Planning interviews across the engineering-decision frontier while updating glossary terms and warranted ADRs. Full Feature uses the automatic variant after Product Grill: the model resolves that same frontier from the locked product intent and codebase without another user gate. Both variants end in a `planning-grill-complete` directive.

#### Spec

The durable planning artifact synthesized after the grill — a PRD stored in the projection, not the repository. It is the node that binds planning tickets and app reviews together. Typed in [the contracts][1].

#### Planning ticket

A tracer-bullet vertical slice of a Spec (or a Wayfinder decision), with dependency edges to the tickets that block it. Stored through the `planning-tickets-artifact` directive in [workflowDirectives.ts][27].

#### Ticket review

The planning stage where reviewer sub-threads check the ticket set against the Spec for up to five cycles, editing tickets directly through the `planning-reviewer-verdict` directive's `ticketEdits`. The cap is `PLANNING_REVIEW_MAX_CYCLES` in [the contracts][1].

#### Wayfinder map

The durable map of decision tickets for efforts too large to specify in one pass. Written by the `wayfinder-map-artifact` directive, read through `workflow_wayfinder_map_get`, and shown above the Spec in the Planning side panel.

#### App review

The bounded QA stage of an implementation run. AppDevStack and App Review failures share up to `IMPLEMENTATION_RUN_MAX_QA_REPAIRS` (10) fresh automated repair agents in [the contracts][1]. Initial probes and Browser App Reviews do not consume slots; replacing a malformed, failed, blocked, or interrupted repair does. A successful AppDevStack repair re-ensures the stack directly; the final merge gate after Code Review owns complete validation instead of rerunning the integration gate after every stack repair. Exhaustion proceeds through best-effort Code Review and flagged publication only from a clean, merge-gate-validated HEAD. A clean legacy HEAD without a validation receipt reruns the merge gate; dirty, wrong-branch, non-repository, or controller-invisible worktrees require human attention. The persisted `qaCycleCount` name remains for compatibility but records consumed repair slots; `qaAttemptCount` records Browser App Review launches.

#### Code review

The final automated review stage: one comprehensive review-and-fix pass along the Standards and Spec axes, followed only when necessary by delta reviews of final-validation repairs. The review/validation loop is capped at `IMPLEMENTATION_RUN_MAX_REVIEW_GATE_CYCLES` (3); exhaustion publishes a clean work-in-progress change request with unresolved validation evidence instead of looping indefinitely. Prompted by `implementation.code-review.codex` in [WorkflowPromptRegistry.ts][26].

#### Implementation run

One orchestrated execution of a Spec's tickets: a dedicated worktree, dependency-chained TDD workers, programmatic merges, app review, and code review, driven by [ImplementationWorkflowReactor.ts][29].

#### App dev stack

A Kubernetes development deployment for a worktree. Workflow orchestration may own one stack at a
time through its durable workflow ID. A matching pre-existing or standing stack can be reused but
is not adopted, replaced, or deleted by that workflow.

The per-worktree development stack (dev servers, preview) that implementation runs start only after Build or worker integration has produced a stable worktree. Transitional `pending` and `starting` states are retried as waiting states, while controller visibility failures and unhealthy non-optional services block before Browser App Review. App Review then uses its live surface. See [app-dev-stacks.md][30].

## Practical Shortcuts

- If you see `requested`, think "intent recorded".
- If you see `completed`, think "result applied".
- If you see `receipt`, think "async milestone signal, for tests".
- If you see `checkpoint`, think "workspace snapshot for diff/restore".
- If you see `quiesced`, think "all relevant follow-up work has gone idle".

## Related Docs

- [Architecture overview][24]
- [Provider architecture][16]
- [Permission modes][18]
- [Workspace layout][2]
- [Workflow catalog][28]
- [Workflows, skills, and docs (user guide)][31]

[1]: ../../packages/contracts/src/orchestration.ts
[2]: ./workspace-layout.md
[3]: ../../apps/server/src/vcs/GitVcsDriverCore.ts
[4]: ../../apps/server/src/orchestration/projector.ts
[5]: ../../apps/server/src/orchestration/Layers/ProviderRuntimeIngestion.ts
[6]: ../../apps/server/src/orchestration/Layers/CheckpointReactor.ts
[7]: ../../apps/server/src/orchestration/Layers/OrchestrationEngine.ts
[8]: ../../apps/server/src/orchestration/decider.ts
[9]: ../../apps/server/src/orchestration/commandInvariants.ts
[10]: ../../apps/server/src/orchestration/Layers/ProjectionSnapshotQuery.ts
[11]: ../../apps/server/src/orchestration/Layers/ProjectionPipeline.ts
[12]: ../../apps/server/src/orchestration/Layers/ProviderCommandReactor.ts
[13]: ../../apps/server/src/orchestration/Services/RuntimeReceiptBus.ts
[14]: ../../apps/server/src/provider/Layers/ProviderService.ts
[15]: ../../apps/server/src/provider/Services/ProviderAdapter.ts
[16]: ./providers.md
[17]: ../../apps/server/src/provider/Layers/CodexAdapter.ts
[18]: ../user/permission-modes.md
[19]: ../../apps/server/src/checkpointing/CheckpointStore.ts
[20]: ../../apps/server/src/checkpointing/CheckpointDiffQuery.ts
[21]: ../../apps/server/src/persistence/Services/ProjectionCheckpoints.ts
[22]: ../../apps/server/src/checkpointing/Utils.ts
[23]: ../../apps/server/src/checkpointing/Diffs.ts
[24]: ./overview.md
[25]: ../../packages/shared/src/workflowPresets.ts
[26]: ../../apps/server/src/provider/WorkflowPromptRegistry.ts
[27]: ../../apps/server/src/orchestration/workflowDirectives.ts
[28]: ./workflow-catalog.md
[29]: ../../apps/server/src/orchestration/Layers/ImplementationWorkflowReactor.ts
[30]: ../user/app-dev-stacks.md
[31]: ../user/workflow-catalog.md
