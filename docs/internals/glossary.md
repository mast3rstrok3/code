# Glossary

Terms whose meaning matters across T3 Code. Architecture and lifecycle constraints belong in the
[overview](./overview.md), not in these definitions.

## Workspace and conversation

| Term           | Meaning                                                                                           |
| -------------- | ------------------------------------------------------------------------------------------------- |
| Environment    | One running server and the machine, credentials, workspace access, and state it owns.             |
| Client         | A web, desktop, or mobile UI connected to an environment. The desktop app can also host a server. |
| Project        | An environment-local workspace record rooted at a directory.                                      |
| Workspace root | The project's base filesystem directory on the environment.                                       |
| Worktree       | A separate Git checkout a thread can use instead of the project's main checkout.                  |
| Thread         | The durable conversation and work history for a project. It survives provider process exits.      |
| Turn           | One user-to-agent work cycle. Provider work can finish before checkpoint and diff work settles.   |
| Activity       | A non-message timeline item, such as a tool action, approval, or failure.                         |
| T3 home        | The base data directory. Runtime state normally lives under its `userdata` directory.             |

## Orchestration

| Term                    | Meaning                                                                                      |
| ----------------------- | -------------------------------------------------------------------------------------------- |
| Command                 | A request to change domain state. Accepting it does not mean its side effects have finished. |
| Event                   | A persisted fact produced by a command.                                                      |
| Decider                 | The pure logic that turns a command and current state into events.                           |
| Projection / read model | A view of current state derived from persisted events.                                       |
| Projector               | The logic that applies events to a read model.                                               |
| Reactor                 | A worker that performs follow-up work in response to recorded intent or runtime signals.     |
| Command receipt         | A durable record of a command's result, used to make retries idempotent.                     |
| Runtime receipt         | A test-only signal that an asynchronous milestone completed.                                 |
| Quiesced                | The relevant follow-up workers have finished, beyond the provider turn merely ending.        |

## Providers and checkpoints

| Term                | Meaning                                                                                                      |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| Provider            | The agent runtime T3 Code controls, such as Codex or Claude Code.                                            |
| Driver              | The integration for a provider kind.                                                                         |
| Provider instance   | One configured provider, with its own settings and lifecycle. Multiple instances can use the same driver.    |
| Adapter             | The boundary translating a provider's native protocol into T3 Code operations and events.                    |
| Session             | The provider runtime attached to a thread. A session can be stopped and resumed without deleting the thread. |
| Runtime mode        | The thread's permission policy. See [permission modes](../user/permission-modes.md).                         |
| Interaction mode    | How the agent approaches the task, such as planning. Separate from permission policy.                        |
| Checkpoint          | A saved workspace state used for diffs and restore, stored as a hidden Git ref.                              |
| Checkpoint baseline | The workspace state captured before the work being compared.                                                 |
| Turn diff           | The workspace changes attributed to one turn.                                                                |

### Workflows

Workflows are the server-orchestrated automation paths that chain planning and implementation stages across threads and worktrees. The presets live in [workflowPresets.ts][25], the built-in skills and docs in [WorkflowPromptRegistry.ts][26], and the stage handoffs in [workflowDirectives.ts][27]. See [workflow-catalog.md][28].

#### Workflow (preset)

One Engineering workflow configuration defined in [workflowPresets.ts][25]. Quick Feature and Feature use native CLI planning followed by Build. Quick Engineering and Engineering use the Spec-and-tickets planning flow followed by Implementation. Wayfinder is visible but disabled while its alternate planning phase is under development. A variant supplies run-local defaults that the user can change before launch. Earlier preset identities remain decodable for historical runs; App Review is launched as a nested or panel-owned run.

#### Workflow ID

The durable identity of one workflow run. A top-level controller creates the ID and its owned children inherit it. A nested workflow creates a new ID and records its enclosing run as `parentWorkflowId`. Workflow links and AppStack ownership use this identity rather than a thread ID or preset name.

#### App Review Workflow

A durable workflow made of budgeted three-step cycles: human-style Browser App Review, gap analysis and repair planning in a child thread, then plan implementation in a further child thread using the Implement skill. It can run standalone against an in-place worktree or as a nested workflow below Implementation.

#### App Review controller

The persistent thread that owns one App Review run and keeps the original brief across cycles. Each cycle gets a fresh reviewer thread. A failed review starts a gap analysis thread below it, which receives the brief and the complete actionable findings and persists the repair plan. Implementation happens in a further child thread.

#### App Review cycle

One complete App Review budget unit: one reviewer thread that owns the configured E2E commands and browser review, gap analysis and planning in a second thread after a product failure, and repair in a third thread. The durable review record stores the effective scope fixed at launch. E2E-only reviews pass from command checks without browser media, while scopes that include the browser require a saved recording and screenshot. Each phase thread gets one turn. The initial review is cycle 1. A pass completes its cycle without the planning and repair steps; the final failed product review still implements its plan before the run becomes exhausted. Provider and runtime failures replace only their current phase thread, with a bounded launch budget, and do not consume another product-review cycle. Recovery reopens failures marked retryable and reissues a claimed turn that never started. An explicit failed or blocked phase result stays terminal.

#### App Review outcome

The terminal result of an App Review Workflow: `passed`, `failed`, or `exhausted`. Exhausted means every complete cycle in the configured budget was consumed and the final implemented repair has no remaining verification cycle. Failed means automation could not complete a valid cycle; cancellation is recorded as a failed run with diagnostic detail rather than as a separate verdict.

#### Workflow step cycle budget

How many times one looping workflow step repeats before the run moves on, keyed by the step and, for a sub-step, the agent within it — the same key a [step model pin](#workflow-preset) uses. A budget on the workflow root governs that run; `workflowStepCycles` in server settings is the standing default behind it. `WORKFLOW_STEP_CYCLE_TARGETS` in [`packages/shared/src/workflowStepCycles.ts`](../../packages/shared/src/workflowStepCycles.ts) is the list of steps that have one, with each step's default and ceiling. Only three steps loop: [ticket review](#ticket-review), the run's own [App Review](#app-review-workflow), and a ticket's App Review. The ticket and run-level App Reviews run the same agent under different steps and carry separate budgets.

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

The planning stage where reviewer sub-threads check the ticket set against the Spec, editing tickets directly through the `planning-reviewer-verdict` directive's `ticketEdits`. Five cycles by default, raised or lowered per run by a [workflow step cycle budget](#workflow-step-cycle-budget); `PLANNING_REVIEW_MAX_CYCLES` in [the contracts][1] is the ceiling no budget can pass.

#### Wayfinder map

The durable map of decision tickets for efforts too large to specify in one pass. Written by the `wayfinder-map-artifact` directive, read through `workflow_wayfinder_map_get`, and shown above the Spec in the Planning side panel.

#### App review

The bounded QA stage of an implementation run. A run may use up to ten cycles. Each cycle has up to four consecutive phase threads: enabled E2E testing, enabled browser review, gap analysis when actionable findings exist, and TDD repair. E2E testing and browser review write separate durable App Review sections. E2E checks may link to a runner-published web replay, while browser review owns recordings and screenshots. Passing every enabled review section stops the run early. Budget exhaustion records unresolved findings and lets Implementation continue to Code Review. Ticket App Review resolves its effective scope before creating a ticket App Stack. A missing preview, stale workspace, dirty embedded worktree, or invalid workspace identity still requires human attention.

#### Code review

The ticket and final automated review stage. One logical cycle uses one fresh thread to review the complete applicable diff, apply clear fixes, validate, commit, and report. A clean result stops early. Findings start another fresh cycle, up to `IMPLEMENTATION_RUN_MAX_REVIEW_GATE_CYCLES` (5). Interrupted turns retry in the current cycle thread and do not consume a cycle. The Final Code Review thread that ends the stage runs complete validation. Exhaustion becomes a pull-request warning when the branch remains clean and usable. Prompted by `implementation.code-review.codex` in [WorkflowPromptRegistry.ts][26].

#### Thread budget

The maximum number of durable thread IDs a workflow stage may claim. Another turn in an existing thread does not spend the budget. A new review cycle, a ticket that has never started, or an explicit rerun generation may claim a fresh ID. Recovery never clears a claimed active ID to obtain a replacement.

#### Stage execution

The canonical ownership record for one Implementation stage, ticket stage, or nested App Review phase. It combines a target, generation, execution ID, explicit state, claim and lease times, last progress, failure, recovery episode, and optional durable job ID. Compatibility run and ticket statuses are derived from these records. Provider activity from the owned phase changes a planned-restart `reconciling` execution back to `running` and starts a fresh lease.

#### Recovery episode

One durable attempt sequence for a planned restart, crash, provider interruption, or historical failure. It stores its cause, start and deadline, attempt count, selected model, fallback history, and optional retry time. Infrastructure episodes do not consume product budgets.

#### Retry-wait

A stage state that has no active provider owner and a durable time at which recovery becomes eligible. Provider usage limits use the latest provider retry time, or five hours when none is available.

#### Lease

A renewable ownership deadline. Provider activity renews a stage lease for five minutes. A missed deadline moves the stage to reconciliation so the server can inspect sessions, commands, turns, results, checkpoints, and pause state before it resumes work.

#### Durable validation job

A persisted E2E command tied to a stage generation. It records the command, working directory, state, 30-second heartbeat, timestamps, output summary, and result receipt. Two minutes without a heartbeat expires its lease. Late results from revoked generations are ignored.

#### Planned drain

The server shutdown state used for updates and signals. It writes a planned-restart marker, stops new workflow launches, and waits up to 90 seconds for accepted work, provider turns, checkpoints, and internal queues. Repeated drain requests share one operation, and force ends the remaining wait.

#### Implementation run

One orchestrated execution of a Spec's tickets: a dedicated worktree, dependency-chained TDD workers, programmatic merges, App Review, and Code Review, driven by [ImplementationWorkflowReactor.ts][29]. Each ticket allocates one durable Implementation thread. Recovery adds continuation turns to that thread. An explicit rerun creates a new stage generation. Cleanup removes a ticket worktree only when its branch, accepted commit, integration ancestry, and clean status agree. Otherwise the ticket records a terminal retention reason and leaves the worktree for manual inspection. The recovery sweep also cancels ticket and run-level App Reviews that the implementation no longer owns.

#### Workflow nudge

The provider-facing part of stage recovery. It resumes the primary model once, resolves the run or standing `workflow.recovery-fallback` pin, and can replace the provider-native session while retaining the T3 thread and workspace. Usage limits then park until `retryAt` or five hours and may repeat without an attempt ceiling. Transport failures remain bounded to eight hours. Unknown historical failures keep two compatibility attempts. Authentication, configuration, pauses, live turns, approvals, user-input waits, and deliberate interruptions do not enter automatic retry. [StaleTurnReconciler.ts][32] records provider evidence; the stage execution owns the canonical recovery state.

#### App stack

A Kubernetes development deployment for a worktree. One workflow may own a shared stack and several
ticket stacks, each identified by the durable workflow ID and a distinct normalized worktree path.
A matching stack can be reused after restart. Duplicate stacks for one worktree and ownership
mismatches are reported instead of stopped automatically. A stack has a variant, `dev` (the
default, hot reload over the mounted worktree) or `prod` (the production build in a baked image);
a worktree can hold one of each. Workflows only ever create dev stacks.

The per-worktree development stack (dev servers, preview) that implementation runs start only after Build or worker integration has produced a stable worktree. Transitional `pending` and `starting` states are retried as waiting states, while controller visibility failures and unhealthy non-optional services block before Browser App Review. App Review then uses its live surface. See [app-stacks.md][30].

[1]: ../../packages/contracts/src/orchestration.ts
[2]: ./overview.md
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
[30]: ../user/app-stacks.md
[31]: ../user/workflow-catalog.md
[32]: ../../apps/server/src/orchestration/Layers/StaleTurnReconciler.ts
[33]: ../../apps/server/src/orchestration/workflowNudge.ts
[34]: ../../apps/server/src/environmentTheme.ts
[35]: ../user/appearance.md
