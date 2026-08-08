# Workflow catalog

The server owns a compiled workflow catalog with three linked record types: workflows contain ordered steps, skill-backed steps reference stable workflow prompt IDs, and skills reference deduplicated supporting document IDs. Existing prompt IDs remain the runtime and persistence identity.

`server.getWorkflowCatalog` exposes the read-only catalog to clients. `server.getWorkflowPrompts` remains available for older clients and is derived from the same registry.

The source of truth is `apps/server/src/provider/WorkflowPromptRegistry.ts`. Every skill prompt and supporting document is an inline constant compiled into the server; nothing is read from disk. `buildWorkflowCatalog()` runs once at module load and validates the whole graph: a step referencing an unknown skill ID throws, and two documents sharing an ID with different content throw a conflict error, so a broken catalog fails the server at startup rather than at runtime.

## Skill prompt anatomy

The built-in skills derive from [Matt Pocock's skills repo](https://github.com/mattpocock/skills). Each prompt follows one convention: the upstream SKILL.md body appears near-verbatim first (including upstream frontmatter where present), doc references are swapped inline for `workflow_doc_get` loads, and T3-specific behavior lives in trailing sections — `## T3 workflow adapter` for storage, tool, and handoff mapping, plus purpose-specific directive sections such as `## Orchestrated Worker Result`. Adapter sections end by stating which upstream mechanics they override; everything else in the upstream body remains authoritative.

Provenance of the main skills:

| Skill ID                                                                                                 | Upstream source                                                                                         |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `shared.grilling.codex`                                                                                  | `productivity/grilling`, the verbatim shared interview primitive                                        |
| `product.fix.codex`, `product.fast-feature.codex`, `product.full-feature.codex`                          | shared `grilling`, plus a short codebase-grounded product-only adapter                                  |
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

The registry contains one independent Grilling primitive and two compositions. Product Grill adds only codebase grounding, product-decision scope, and the minimal `product-intent-locked` handoff; its three preset prompt IDs fix the intent kind up front. Engineering Grill adds the complete domain-modeling discipline and the Planning handoff. Standalone Planning uses the interactive composition verbatim. Full Feature uses a separate automatic adapter that keeps the design tree, dependency frontier, fact-finding, domain-modeling, and completeness requirements, but resolves every engineering decision internally from the locked Product Grill intent instead of asking another round of user questions.

Supporting documents (`context-format`, `adr-format`, `domain-docs`, `agent-brief`, `prototype-logic`, `prototype-ui`, `tdd-mocking`, `tdd-tests`, `tdd-logging`, `preview-browser-qa`) are deduplicated by global ID and back-linked to the skills that carry them.

At runtime, prompt rendering includes only document metadata in an `available-workflow-docs` block. Registered workflow sessions receive the existing `workflow-artifacts` MCP capability and can call the read-only `workflow_doc_get` tool to retrieve a built-in document by ID. Document content is static server data and contains no project or user state.

## Artifacts and directives

Specs, planning tickets, Wayfinder Maps, and dev reviews are durable artifacts in the server's event-sourced projection — not repository files or external tracker issues. This is a deliberate deviation from the upstream skills, which publish to an issue tracker or `.scratch/` files.

Workflow stages hand results to the orchestration by ending a message with exactly one fenced JSON directive, parsed in `apps/server/src/orchestration/workflowDirectives.ts`:

- `product-intent-locked` — Product Grill finished with the intent kind fixed by its workflow preset.
- `planning-grill-complete` — Engineering Grill finished.
- `planning-spec-artifact` / `wayfinder-map-artifact` — write the durable Spec or Wayfinder Map.
- `planning-tickets-artifact` — store the drafted ticket set against a Spec or map.
- `planning-reviewer-verdict` — the ticket reviewer's per-cycle verdict, including a `ticketEdits` array (update / create / delete / update-dependencies) through which the reviewer edits tickets directly.
- `implementation-worker-result`, `implementation-merge-gate-result`, `implementation-fix-result`, `implementation-code-review-result` — implementation stage results.
- `workflow-subagent-create`, `workflow-subagents-create`, `workflow-subagent-result`, `workflow-agent-message` — sub-thread lifecycle and messaging.

Workflow threads read canonical artifacts through the read-only `workflow-artifacts` MCP toolkit: `workflow_context_get`, `workflow_spec_get`, `workflow_wayfinder_map_get`, `workflow_tickets_list`, `workflow_ticket_get`, `workflow_dev_reviews_list`, `workflow_dev_review_get`, and `workflow_doc_get`.

## The six workflows

Workflows appear in catalog order: Fix, Fast Feature, Full Feature, Wayfinder, Planning, Implementation. The Spec is the node that binds tickets and dev reviews into one package.

### Fix

Product Grill (intent kind fixed to `fix`) → the same thread switches to CLI Plan mode → the proposed plan launches one CLI Build child thread on the same worktree and branch the workflow started on. No dedicated worktree, app dev stack, Dev Review, or Code Review.

### Fast Feature

Product Grill (intent kind fixed to `feature`) → same-thread CLI Plan mode → the proposed plan launches a Build child thread in a dedicated worktree branched from the starting branch, starting the app dev stack in parallel → up to ten shared AppDevStack/Dev Review QA cycles, with every failure repaired by a fresh TDD child and every review performed by a fresh reviewer → Code Review sub-thread (single pass) → the change request is published into the starting branch. Exhausted QA continues best-effort and is flagged in the change request.

### Full Feature

Product Grill is the only user-interactive gate. After the user confirms the product intent, the same thread enters the complete Planning workflow at the automatic Engineering Grill, where the model resolves the engineering and domain design tree from the locked intent and codebase without asking the user. Spec authoring, tickets, ticket review, and the complete Implementation workflow then continue automatically. Implementation runs in its own sub-thread and worktree branched from the branch the user selected, with the app dev stack created in parallel when absent.

### Wayfinder

For efforts too large or uncertain to specify in one pass. Wayfinder replaces the normal Engineering Grill at the head of the planning flow: name the destination → grill breadth-first with the same engineering/domain discipline → write the durable Wayfinder Map (`wayfinder-map-artifact`) → resolve research and prototype decision tickets (stored as normal planning tickets linked to the map, with dependency edges) → advance the decision frontier → hand off to Spec authoring, then tickets, ticket review, and implementation.

Wayfinder reuses the Planning Workflow projection. `wayfinder-map-artifact` writes a separate durable map on the planning workflow, while `planning-tickets-artifact` targets the map ID to store decision tickets through the existing ticket schema and dependency graph. `workflow_wayfinder_map_get` exposes the canonical map to focused workflow turns. A later Spec and its implementation tickets coexist with the map and its decision tickets; the client groups each ticket set by its parent artifact.

### Planning

Engineering Grill is the only user-interactive stage: it works the engineering and domain frontier in rounds, while domain modeling writes `CONTEXT.md`, ADRs, and — in multi-context repos — a `CONTEXT-MAP.md` as decisions crystallize. Once the user confirms shared understanding, Spec authoring in the same thread (`planning-spec-artifact`), ticket drafting (`planning-tickets-artifact`), and ticket review continue automatically without another user gate. Ticket review runs in sub-threads for up to `PLANNING_REVIEW_MAX_CYCLES` (3), with each reviewer editing tickets directly through `ticketEdits`; a clean verdict automatically finalizes the set.

### Implementation

Loads the Spec and tickets via the MCP tools, then:

1. Creates a dedicated worktree and branch from the branch the user selected; the finished change request is filed back into that branch.
2. Starts the app dev stack for that worktree in parallel with implementation (`AppDevStackManager`).
3. Runs dependency-aware TDD workers, each a sub-thread with its own worktree and branch. A dependent ticket's worker branches from its blocker's worker branch, so chained tickets build on each other; every worker commits to its own branch.
4. Merges worker branches programmatically back into the orchestrator worktree; the Merge Gate stage runs only when programmatic integration stops on a real conflict.
5. Runs up to `IMPLEMENTATION_RUN_MAX_QA_CYCLES` (10) shared QA cycles. Each cycle ensures and probes AppDevStack, then launches a fresh Browser Dev Review when the stack is healthy. Any stack failure or failed/blocked review launches a fresh TDD repair thread before the next cycle. After the cap the run proceeds best-effort and flags the unresolved gate in the change request.
6. Runs Code Review as a single review-and-fix pass (Standards and Spec axes) that commits its own corrections, then publishes the change request into the original branch.

## Orchestration

`ProductWorkflowReactor.ts` drives Fix, Fast Feature, and Full Feature from the locked intent; `ImplementationWorkflowReactor.ts` owns worktrees, the merge pipeline, app dev stack provisioning, QA cycles, and change-request publication. Cycle caps live in `packages/contracts/src/orchestration.ts` (`PLANNING_REVIEW_MAX_CYCLES`, `IMPLEMENTATION_RUN_MAX_QA_CYCLES`). Shared sub-agent conventions (stage IDs, MCP tools, directives) are in `apps/server/src/provider/WorkflowSubagentInstructions.ts`.
