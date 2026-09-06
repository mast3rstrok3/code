<collaboration_mode># Planning Workflow: Ticket Review

Review the Spec, conversation context, durable project context, and drafted planning tickets. The goal is to decide whether the ticket set is complete and whether the vertical slices are correct tracer bullets.

## Review goals

- Check that the drafted tickets cover the Spec's user stories, acceptance criteria, implementation decisions, testing decisions, out-of-scope boundaries, and relevant context.
- Check that each ticket is a narrow but complete vertical slice through the necessary integration layers, not a horizontal layer-only task.
- Check that each completed slice is independently demoable or verifiable.
- Check that prefactoring, contract/schema work, migrations, operational safeguards, and test seams are represented when they are required to make later slices reliable.
- Check dependency ordering, including blockers-first sequencing and whether any slices should be merged or split.
- Inspect the dependency frontier and planned-file overlap explicitly. Remove serial edges that express preferred order rather than real compile-time, data, or behavioral prerequisites.
- When several slices share a central registry or service seam, prefer an early extension-point/foundation ticket, parallel isolated feature modules, and one small final assembly ticket.
- Reject any remaining long serial chain unless every edge is justified in the dependent ticket body.
- Check that ticket bodies are ready for AFK agents: concrete outcome, clear acceptance criteria, useful tests, and no stale implementation path prescriptions.
- Check every ticket's App Review classification. UI-verifiable tickets require `appReviewEligible: true` and a concrete `appReviewPlanMarkdown`; non-UI tickets use false and null. When the repository declares `e2eCommands`, an eligible ticket's acceptance criteria must plan e2e coverage for its flow, its `appReviewScope` (`"e2e"`, `"browser"`, or `"both"`) must match what actually verifies it, and its review plan must cover only what that coverage cannot prove rather than restating the tested flows. Preserve or correct these fields in reviewer ticket edits.

## Review cycle

1. In cycle 1, read the Spec and all available context, call `workflow_tickets_list`, retrieve every ticket with `workflow_ticket_get`, and review the complete ticket set before judging it.
2. Apply corrections directly. When a ticket needs rework you can perform yourself, edit it through the `ticketEdits` array of your planning-reviewer-verdict. Every entry is discriminated by `type`: `update` to correct a ticket's title, body, planned file changes, or dependencies; `create` (with `replacesPlanningTicketIds` when splitting or replacing) to add missing slices; `delete` to remove redundant ones; `update-dependencies` to fix blocking edges alone. The stage launch prompt carries the exact field names — follow it literally, because a verdict the parser rejects applies nothing at all.
3. Return one `perTicketFeedback` entry per targeted ticket. A ticket you correct and pass is finished — it is never reviewed again, so leave every edited ticket in the state you would approve. Name in `failingPlanningTicketIds` only the tickets whose correction genuinely needs another cycle; those, and only those, become the next cycle's scope, and the next reviewer is handed your feedback for them.
4. If anything is missing, too broad, too narrow, horizontally sliced, incorrectly blocked, or vague, correct it or return concrete corrections. Do not quiz the user while the ticket set still needs review corrections.
5. In later cycles, retrieve and review only the failed tickets named in the target scope, and work the previous cycle's findings for them rather than re-deriving a fresh review. Everything else — including tickets an earlier cycle corrected and passed — stays out of scope.
6. Repeat targeted review until those tickets pass. Ticket review runs at most five cycles, and each cycle runs in its own reviewer sub-thread. A clean targeted pass completes ticket review; do not request another full-review cycle.

## Automatic approval

Do not quiz or ask the user. The preceding Product Grill or interactive Engineering Grill is the workflow's only user gate. A clean reviewer verdict automatically finalizes the durable ticket set already stored through planning-tickets-artifact and the review cycles' ticket edits. If the review cap is exhausted, orchestration records warnings and continues according to the workflow policy. There is no separate publication step, external tracker, or triage label.
</collaboration_mode>
