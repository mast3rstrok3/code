# Workflow catalog

The server owns a compiled workflow catalog with three linked record types: workflows contain ordered steps, skill-backed steps reference stable workflow prompt IDs, and skills reference deduplicated supporting document IDs. Existing prompt IDs remain the runtime and persistence identity.

`server.getWorkflowCatalog` exposes the read-only catalog to clients. `server.getWorkflowPrompts` remains available for older clients and is derived from the same registry.

The source of truth is `apps/server/src/provider/WorkflowPromptRegistry.ts`. Every skill prompt and supporting document is an inline constant compiled into the server; nothing is read from disk. `buildWorkflowCatalog()` runs once at module load and validates the whole graph: a step referencing an unknown skill ID throws, and two documents sharing an ID with different content throw a conflict error, so a broken catalog fails the server at startup rather than at runtime.

## Skill prompt anatomy

The built-in skills derive from [Matt Pocock's skills repo](https://github.com/mattpocock/skills). Each prompt follows one convention: the upstream SKILL.md body appears near-verbatim first (including upstream frontmatter where present), doc references are swapped inline for `workflow_doc_get` loads, and T3-specific behavior lives in trailing sections — `## T3 workflow adapter` for storage, tool, and handoff mapping, plus purpose-specific directive sections such as `## Orchestrated Worker Result`. Adapter sections end by stating which upstream mechanics they override; everything else in the upstream body remains authoritative.

Provenance of the main skills:

| Skill ID                                                                                                 | Upstream source                                                                                         |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `product.fix.codex`, `product.fast-feature.codex`, `product.full-feature.codex`                          | `productivity/grilling`, restricted to product questions                                                |
| `planning.grill-stage.codex`                                                                             | `engineering/grill-with-docs` = `grilling` + `domain-modeling` fused                                    |
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

The three product prompts contain only the product-direction interview and the minimal `product-intent-locked` handoff. They ground themselves in the codebase before questioning, resolve discoverable facts themselves, and ask one product-alignment question at a time with a recommendation. This is a deliberate one-question adaptation of the upstream Grilling discipline. Downstream sequencing is owned by the reactors and is intentionally absent from these prompts.

Supporting documents (`context-format`, `adr-format`, `domain-docs`, `agent-brief`, `prototype-logic`, `prototype-ui`, `tdd-mocking`, `tdd-tests`, `tdd-logging`, `preview-browser-qa`) are deduplicated by global ID and back-linked to the skills that carry them.

At runtime, prompt rendering includes only document metadata in an `available-workflow-docs` block. Registered workflow sessions receive the existing `workflow-artifacts` MCP capability and can call the read-only `workflow_doc_get` tool to retrieve a built-in document by ID. Document content is static server data and contains no project or user state.

## Artifacts and directives

Specs, planning tickets, Wayfinder Maps, and dev reviews are durable artifacts in the server's event-sourced projection — not repository files or external tracker issues. This is a deliberate deviation from the upstream skills, which publish to an issue tracker or `.scratch/` files.

Workflow stages hand results to the orchestration by ending a message with exactly one fenced JSON directive, parsed in `apps/server/src/orchestration/workflowDirectives.ts`:

- `product-intent-locked` and `product-intent-classification-asked` — the product grill's hard gate.
- `planning-grill-complete` — Grill With Docs finished.
- `planning-spec-artifact` / `wayfinder-map-artifact` — write the durable Spec or Wayfinder Map.
- `planning-tickets-artifact` — store the drafted ticket set against a Spec or map.
- `planning-reviewer-verdict` — the ticket reviewer's per-cycle verdict, including a `ticketEdits` array (update / create / delete / update-dependencies) through which the reviewer edits tickets directly.
- `implementation-worker-result`, `implementation-merge-gate-result`, `implementation-fix-result`, `implementation-code-review-result` — implementation stage results.
- `workflow-subagent-create`, `workflow-subagents-create`, `workflow-subagent-result`, `workflow-agent-message` — sub-thread lifecycle and messaging.

Workflow threads read canonical artifacts through the read-only `workflow-artifacts` MCP toolkit: `workflow_context_get`, `workflow_spec_get`, `workflow_wayfinder_map_get`, `workflow_tickets_list`, `workflow_ticket_get`, `workflow_dev_reviews_list`, `workflow_dev_review_get`, and `workflow_doc_get`.

## The six workflows

Workflows appear in catalog order: Fix, Fast Feature, Full Feature, Wayfinder, Planning, Implementation. The Spec is the node that binds tickets and dev reviews into one package.

### Fix

Product grill (the single human gate, classification fixed to `fix`) → the same thread switches to CLI Plan mode → the proposed plan launches one CLI Build child thread on the same worktree and branch the workflow started on. No dedicated worktree, app dev stack, Dev Review, or Code Review.

### Fast Feature

Product grill (classification fixed to `feature`) → same-thread CLI Plan mode → the proposed plan launches a Build child thread in a dedicated worktree branched from the starting branch, starting the app dev stack in parallel when none exists for that worktree → Dev Review sub-thread (feedback returns to the Build thread, up to five attempts) → Code Review sub-thread (single pass) → the change request is published into the starting branch.

### Full Feature

Product grill (the only human gate) → the complete Planning workflow runs → the complete Implementation workflow runs in its own sub-thread and worktree branched from the branch the user selected, with the app dev stack created in parallel when absent. Everything after the grill is automatic.

### Wayfinder

For efforts too large or uncertain to specify in one pass. Wayfinder replaces Grill With Docs at the head of the planning flow: name the destination → grill breadth-first → write the durable Wayfinder Map (`wayfinder-map-artifact`) → resolve research and prototype decision tickets (stored as normal planning tickets linked to the map, with dependency edges) → advance the decision frontier → hand off to Spec authoring, then tickets, ticket review, and implementation.

Wayfinder reuses the Planning Workflow projection. `wayfinder-map-artifact` writes a separate durable map on the planning workflow, while `planning-tickets-artifact` targets the map ID to store decision tickets through the existing ticket schema and dependency graph. `workflow_wayfinder_map_get` exposes the canonical map to focused workflow turns. A later Spec and its implementation tickets coexist with the map and its decision tickets; the client groups each ticket set by its parent artifact.

### Planning

Grill With Docs (human-in-the-loop; domain modeling writes `CONTEXT.md`, ADRs, and — in multi-context repos — a `CONTEXT-MAP.md` as decisions crystallize) → Spec authoring in the same thread (durable artifact, `planning-spec-artifact`) → ticket drafting in the same thread (`planning-tickets-artifact`) → ticket review in sub-threads: up to `PLANNING_REVIEW_MAX_CYCLES` (3) cycles, each cycle its own reviewer sub-thread, the reviewer editing tickets directly through `ticketEdits`.

### Implementation

Loads the Spec and tickets via the MCP tools, then:

1. Creates a dedicated worktree and branch from the branch the user selected; the finished change request is filed back into that branch.
2. Checks the app dev stack for that worktree at the start and, when absent, starts it in parallel (`implementation.autoStartAppDevStack` setting, `AppDevStackManager`).
3. Runs dependency-aware TDD workers, each a sub-thread with its own worktree and branch. A dependent ticket's worker branches from its blocker's worker branch, so chained tickets build on each other; every worker commits to its own branch.
4. Merges worker branches programmatically back into the orchestrator worktree; the Merge Gate stage runs only when programmatic integration stops on a real conflict.
5. Runs Browser Dev Review for up to `IMPLEMENTATION_RUN_MAX_QA_ATTEMPTS` (5) cycles — each cycle a new thread whose findings are fixed before the next. After the cap the run proceeds with the review still failing, flagged in the change request.
6. Runs Code Review as a single review-and-fix pass (Standards and Spec axes) that commits its own corrections, then publishes the change request into the original branch.

## Orchestration

`ProductWorkflowReactor.ts` drives Fix, Fast Feature, and Full Feature from the locked intent; `ImplementationWorkflowReactor.ts` owns worktrees, the merge pipeline, app dev stack provisioning, dev-review loops, and change-request publication. Cycle caps live in `packages/contracts/src/orchestration.ts` (`PLANNING_REVIEW_MAX_CYCLES`, `IMPLEMENTATION_RUN_MAX_QA_ATTEMPTS`). Shared sub-agent conventions (stage IDs, MCP tools, directives) are in `apps/server/src/provider/WorkflowSubagentInstructions.ts`.
