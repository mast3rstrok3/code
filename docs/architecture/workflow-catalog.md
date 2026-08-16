# Workflow catalog

The server owns a compiled workflow catalog with three linked record types: workflows contain ordered steps, skill-backed steps reference stable workflow prompt IDs, and skills reference deduplicated supporting document IDs. Prompt IDs identify skills, workflow presets identify definitions, and durable workflow IDs identify individual runs.

`server.getWorkflowCatalog` exposes the read-only catalog to clients. `server.getWorkflowPrompts` remains available for older clients and is derived from the same registry.

The source of truth is `apps/server/src/provider/WorkflowPromptRegistry.ts`. Every skill prompt and supporting document is an inline constant compiled into the server; nothing is read from disk. `buildWorkflowCatalog()` runs once at module load and validates the whole graph: a step referencing an unknown skill ID throws, and two documents sharing an ID with different content throw a conflict error, so a broken catalog fails the server at startup rather than at runtime.

## Skill prompt anatomy

The built-in skills derive from [Matt Pocock's skills repo](https://github.com/mattpocock/skills). Each prompt follows one convention: the upstream SKILL.md body appears near-verbatim first (including upstream frontmatter where present), doc references are swapped inline for `workflow_doc_get` loads, and T3-specific behavior lives in trailing sections — `## T3 workflow adapter` for storage, tool, and handoff mapping, plus purpose-specific directive sections such as `## Orchestrated Worker Result`. Adapter sections end by stating which upstream mechanics they override; everything else in the upstream body remains authoritative.

Provenance of the main skills:

| Skill ID                                                                                                 | Upstream source                                                                                         |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `shared.grilling.codex`                                                                                  | `productivity/grilling`, the verbatim shared interview primitive                                        |
| `product.fast-feature.codex`, `product.full-feature.codex`                                               | shared `grilling`, plus a short codebase-grounded product-only adapter                                  |
| `planning.grill-stage.codex`                                                                             | shared `grilling`, plus the complete `domain-modeling` discipline                                       |
| `planning.engineering-grill-automatic.codex`                                                             | the Engineering Grill composition, plus the Full Feature autonomous adapter                             |
| `planning.domain-modeling.codex`                                                                         | `engineering/domain-modeling`                                                                           |
| `planning.wayfinder.codex`                                                                               | `engineering/wayfinder`                                                                                 |
| `planning.research.codex`                                                                                | `engineering/research`                                                                                  |
| `planning.prototype.codex`                                                                               | `engineering/prototype`, adapted to full-fidelity prototyping on real-app worktrees with app dev stacks |
| `planning.spec.codex`                                                                                    | `engineering/to-spec`                                                                                   |
| `planning.tickets.codex`                                                                                 | `engineering/to-tickets`                                                                                |
| `planning.ticket-reviewer.codex`                                                                         | T3-native, assembled from `to-tickets` steps 4–5                                                        |
| `implementation.orchestrator-planning.codex`                                                             | `engineering/implement`                                                                                 |
| `implementation.tdd.codex`                                                                               | `engineering/tdd` (+ `tests.md`, `mocking.md`)                                                          |
| `implementation.code-review.codex`                                                                       | `engineering/code-review`                                                                               |
| `implementation.merge-gate.codex`, `implementation.browser-dev-review.codex`, `implementation.fix.codex` | T3-native stages                                                                                        |

The registry contains one independent Grilling primitive and two compositions. Product Grill adds codebase grounding, product-decision scope, the structured-question adapter, and the minimal `product-intent-locked` handoff; its two selectable preset prompt IDs fix the intent kind up front. The old `product.fix.codex` prompt remains registered only so historical runs can be decoded and resumed. Engineering Grill adds the complete domain-modeling discipline and the Planning handoff, with the same structured-question adapter on its interactive prompt. The upstream `shared.grilling.codex` primitive remains verbatim. Full Feature uses a separate automatic adapter that keeps the design tree, dependency frontier, fact-finding, domain-modeling, and completeness requirements, but resolves every engineering decision internally from the locked Product Grill intent instead of asking another round of user questions.

The structured adapter requires T3's `workflow_request_user_input` dynamic tool for every interview round and the final shared-understanding gate. It sends the complete currently unblocked dependency frontier when that frontier contains one through seven questions. Seven is a maximum rather than a target: smaller rounds keep their natural size, and frontiers larger than seven continue in stable design-tree order after the first seven answers. Questions with unresolved dependencies are never combined in one round. Each question has two or three naturally ordered choices with neutral impact or tradeoff descriptions, plus a separate recommendation object whose `optionLabel` references one unchanged option label and whose `rationale` explains the preference. Questions and recommendations are not duplicated in Markdown, and T3's existing free-form answer input remains implicit.

For fresh Codex Product Grill and interactive Engineering Grill sessions, `CodexSessionRuntime` registers `workflow_request_user_input` in `V2ThreadStartParams.dynamicTools`, handles `item/tool/call`, emits the canonical `user-input.requested` lifecycle, and waits on the existing user-input response path before returning the full answer map to Codex. Provider threads created before dynamic-tool registration retain native Plan collaboration transport as a temporary compatibility fallback and may use native `request_user_input` only in chunks of up to three. T3's stored interaction modes, visible workflow semantics, directives, and Engineering Grill's narrow domain-document write authorization remain unchanged. Automatic Engineering Grill, Wayfinder's separate stages, Spec, tickets, review, implementation, and all other workflow turns use native Default transport. An explicit `plan` interaction mode always retains normal CLI Plan behavior, even if a stale grill prompt ID is attached.

This presentation follows Matt Pocock's separation of options, recommendation, and rationale, but deliberately keeps T3's dependency-frontier batching instead of adopting an exactly-one-question-at-a-time interview rule.

Supporting documents (`context-format`, `adr-format`, `domain-docs`, `agent-brief`, `prototype-logic`, `prototype-ui`, `tdd-mocking`, `tdd-tests`, `tdd-logging`, `preview-browser-qa`) are deduplicated by global ID and back-linked to the skills that carry them.

At runtime, prompt rendering includes only document metadata in an `available-workflow-docs` block. Registered workflow sessions receive the existing `workflow-artifacts` MCP capability and can call the read-only `workflow_doc_get` tool to retrieve a built-in document by ID. Document content is static server data and contains no project or user state.

## Artifacts and directives

Specs, planning tickets, Wayfinder Maps, and dev reviews are durable artifacts in the server's event-sourced projection — not repository files or external tracker issues. This is a deliberate deviation from the upstream skills, which publish to an issue tracker or `.scratch/` files.

The server-hosted live tab used by a Browser Dev Review is an ephemeral workflow resource. Terminal Dev Review and workflow-child events close it deterministically; the persisted screenshots, recording, findings, checks, and verdict are the post-review inspection artifacts.

Workflow stages hand results to the orchestration by ending a message with exactly one fenced JSON directive, parsed in `apps/server/src/orchestration/workflowDirectives.ts`:

- `product-intent-locked` — Product Grill finished with the intent kind fixed by its workflow preset.
- `planning-grill-complete` — Engineering Grill finished.
- `planning-spec-artifact` / `wayfinder-map-artifact` — write the durable Spec or Wayfinder Map.
- `planning-tickets-artifact` — store the drafted ticket set against a Spec or map.
- `planning-reviewer-verdict` — the ticket reviewer's per-cycle verdict, including a `ticketEdits` array (update / create / delete / update-dependencies) through which the reviewer edits tickets directly.
- `implementation-worker-result`, `implementation-merge-gate-result`, `implementation-fix-result`, `implementation-code-review-result` — implementation stage results.
- `workflow-subagent-create`, `workflow-subagents-create`, `workflow-subagent-result`, `workflow-agent-message` — sub-thread lifecycle and messaging.

Workflow threads read canonical artifacts through the read-only `workflow-artifacts` MCP toolkit: `workflow_context_get`, `workflow_spec_get`, `workflow_wayfinder_map_get`, `workflow_tickets_list`, `workflow_ticket_get`, `workflow_dev_reviews_list`, `workflow_dev_review_get`, and `workflow_doc_get`.

## The five selectable workflows

Workflows appear in catalog order: Fast Feature, Full Feature, Wayfinder, Implementation, Planning. The Spec is the node that binds tickets and dev reviews into one package. `fix` and `dev-review` remain accepted persistence values for historical compatibility but are not catalog entries or composer choices.

### Fast Feature

The workflow first creates its dedicated branch and worktree from the selected branch, then starts Product Grill immediately. Temporary branches use `worktree/<token>` and their directories use `worktree-<token>`; first-turn semantic renaming removes the temporary prefix entirely. In a detached bootstrap path, the repository-declared setup terminal must exit successfully before AppDevStack creation is requested; repositories without a setup script are ready immediately. At every provider turn boundary, the server injects the projected worktree path and branch plus a bounded live lookup of that worktree's AppDevStack. A missing stack is described as pending dependency readiness, while a registered stack contributes its exact id and state and, once healthy, its frontend URL. The context forbids runtime evidence from unmatched host containers, databases, or stacks. Product Grill (intent kind fixed to `feature`) → same-thread CLI Plan mode → once the temporary worktree branch has its semantic name, the proposed plan launches a Build child thread in that shared worktree → Build completes and commits → the inherited AppDevStack is probed → nested Dev Review workflow against that stack → Code Review sub-thread (single pass) → the change request is published into the starting branch. Dev Review exhaustion continues best-effort and is called out explicitly; a blocked run requires human attention.

### Full Feature

Before Product Grill, Full Feature creates one dedicated branch and worktree from the branch the user selected, then starts the thread immediately. Worktree setup runs concurrently with the Grill and gates early AppDevStack creation. Product Grill is the only user-interactive gate. After the user confirms the product intent, the same thread enters the complete Planning workflow at the automatic Engineering Grill, where the model resolves the engineering and domain design tree from the locked intent and codebase without asking the user. Spec authoring, tickets, ticket review, and the complete Implementation workflow then continue automatically in that same workspace. Implementation runs in its own controller sub-thread but reuses the Planning worktree, branch, and stack; only ticket TDD workers branch into child worktrees.

### Wayfinder

For efforts too large or uncertain to specify in one pass. Wayfinder replaces the normal Engineering Grill at the head of the planning flow: name the destination → grill breadth-first with the same engineering/domain discipline → write the durable Wayfinder Map (`wayfinder-map-artifact`) → resolve research and prototype decision tickets (stored as normal planning tickets linked to the map, with dependency edges) → advance the decision frontier → hand off to Spec authoring, then tickets, ticket review, and implementation.

Wayfinder reuses the Planning Workflow projection. `wayfinder-map-artifact` writes a separate durable map on the planning workflow, while `planning-tickets-artifact` targets the map ID to store decision tickets through the existing ticket schema and dependency graph. `workflow_wayfinder_map_get` exposes the canonical map to focused workflow turns. A later Spec and its implementation tickets coexist with the map and its decision tickets; the client groups each ticket set by its parent artifact.

### Planning

Planning first creates its dedicated branch and worktree from the selected branch, then starts Engineering Grill immediately. Worktree setup runs concurrently; only successful completion allows early AppDevStack creation. Engineering Grill is the only user-interactive stage: it works the engineering and domain frontier in structured batches above the composer, while domain modeling writes `CONTEXT.md`, ADRs, and — in multi-context repos — a `CONTEXT-MAP.md` as decisions crystallize. Once the user confirms shared understanding through the structured final gate, Spec authoring in the same thread (`planning-spec-artifact`), ticket drafting (`planning-tickets-artifact`), and ticket review continue automatically without another user gate. Ticket review runs in sub-threads for up to `PLANNING_REVIEW_MAX_CYCLES` (3), with each reviewer editing tickets directly through `ticketEdits`; a clean verdict automatically finalizes the set. Planning records the shared worktree, branch, and AppDevStack identity for the later Implementation workflow.

### Implementation

Loads the Spec and tickets via the MCP tools, then:

1. Reuses the Planning workflow's dedicated worktree, branch, and AppDevStack; the finished change request is filed back into the branch from which Planning created that workspace. Historical or standalone runs without a Planning workspace retain the legacy worktree setup fallback, but a missing inherited AppDevStack blocks explicitly.
2. Runs dependency-aware TDD workers, each a sub-thread with its own worktree and branch. A dependent ticket's worker branches from its blocker's worker branch, so chained tickets build on each other; every worker commits to its own branch.
3. Merges worker branches programmatically back into the orchestrator worktree; the Merge Gate stage runs only when programmatic integration stops on a real conflict.
4. Requires and re-ensures the inherited AppDevStack, then probes both its frontend root and same-origin `/api/health` before Dev Review. A serving static shell with an unavailable backend is a failed runtime, not a healthy preview. Implementation never creates a replacement when the workflow-owned stack is missing.
5. Launches a nested Dev Review workflow with its own workflow ID and the Implementation workflow ID as its parent. AppDevStack repair remains Implementation-owned and does not consume Dev Review attempts. The nested workflow refreshes the frontend URL after every repair. Pass continues to Code Review and exhaustion continues with an unresolved-review warning. When a blocked review coincides with failed backend health, Implementation captures stack diagnostics and pod logs and launches a fresh TDD repair cycle. When backend health remains good, a blocked outcome is treated as review-automation trouble: Implementation re-ensures the inherited stack and launches a fresh nested run, bounded to three consecutive automatic unblock attempts independently of the ten product-repair slots. The next automation-blocked outcome requires human attention; an explicit retry resets that recovery window. Runs created before this strategy retain the legacy inline QA path.
6. Runs one comprehensive Code Review (Standards and Spec axes) that commits its own corrections. A failed complete validation gets a focused repair and a delta-only re-review. This review/validation loop is capped at three Code Review passes; exhaustion publishes the clean branch into the original branch with a prominent work-in-progress warning and the latest failed validation evidence.

### Nested and panel-launched Dev Review

Dev Review is a reusable, restartable loop. Cycle 1 always launches a fresh Browser Dev Review. A pass ends the run. A failed review below budget switches the persistent controller to non-interactive CLI Plan mode, requires one persisted proposed plan, and launches a fresh TDD fixer child before the next review. The original brief remains the acceptance boundary throughout. Complete evidence is a saved recording plus screenshots. If video finalization fails, a failed review remains actionable when it has failed checks and every finding references a persisted screenshot; recording degradation is preserved as evidence state instead of converting product defects into an infrastructure block. Pass remains strict and requires complete evidence. A final failed attempt ends as `exhausted` without an unverified repair.

Standalone panel launches create a dedicated controller child and edit the selected worktree in place, including unrelated dirty WIP. A new composer draft becomes its own top-level controller. Embedded runs put the controller below Implementation and require each repair to leave a clean committed HEAD. A run is `blocked` for invalid automation rather than ordinary findings: unavailable review tooling, malformed or missing plans, fixer failure, unexpected interaction, or a stale workspace fingerprint.

`projection_dev_review_workflow_runs` stores canonical run JSON. Each run records caller and target identity, original brief, preview targets, cycle budget, ordered reviewer/plan/fixer history, the active phase, HEAD and diff-hash fingerprint, terminal outcome, and timestamps. Launch, update, cancel, and refreshed-preview resume commands produce projected run events; `DevReviewWorkflowReactor` reconciles every nonterminal run after restart without polling.

## Workflow identity and links

`workflowPreset` identifies the selected workflow definition; it is not a run identity. Every new top-level run receives a durable `workflowId`, and every child owned by that run inherits it. A nested controller such as Dev Review receives a new `workflowId` and stores the enclosing run as `parentWorkflowId`. AppDevStack ownership uses the durable run ID, so it follows the implementation worktree rather than a transient thread.

The web thread route accepts `?workflow=<workflowId>`. A copied workflow link targets the top-level thread route, opens the Workflows panel, expands the matching run, and keeps the workflow query while navigating among its child threads. The explicit parent link is also what nests Dev Review under its invoking Fast Feature or Implementation run when physical thread ancestry is incomplete. The panel takes its ordered step labels directly from `WORKFLOW_PRESET_DEFINITION_BY_ID[preset].helpSteps`; runtime threads attach to those definitions, and repeated review or repair threads render as cycles of one step. A human-blocked implementation stage exposes the existing stage-scoped retry command directly on its matching step, preserving the run and its workspace state.

## Orchestration

`ProductWorkflowReactor.ts` drives Fast Feature and Full Feature from the locked intent; its Fix branch remains only for historical runs. First-turn bootstrap owns the shared workflow worktree, starts the Product or Engineering Grill immediately, waits for the repository-declared setup terminal to complete, and then creates AppDevStack. `ImplementationWorkflowReactor.ts` reuses that workspace and stack, owns ticket-worker worktrees, the merge pipeline, AppDevStack probing, composition with Dev Review, and change-request publication. `DevReviewWorkflowReactor.ts` owns browser-review, plan, and repair cycles. Caps live in the contracts (`PLANNING_REVIEW_MAX_CYCLES`, `DEV_REVIEW_WORKFLOW_DEFAULT_CYCLES`, and `DEV_REVIEW_WORKFLOW_MAX_CYCLES`). Shared sub-agent conventions (stage IDs, MCP tools, directives) are in `apps/server/src/provider/WorkflowSubagentInstructions.ts`.
