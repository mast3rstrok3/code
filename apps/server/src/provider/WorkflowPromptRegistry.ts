import type { ProviderInteractionMode, WorkflowPromptContract } from "@t3tools/contracts";
import { isPlanningWorkflowInteractionMode } from "@t3tools/contracts";

import { PREVIEW_BROWSER_QA_ASSOCIATED_DOC_CONTENT } from "./PreviewBrowserQa.ts";
import { WORKFLOW_SUBAGENT_INSTRUCTIONS_PROMPT } from "./WorkflowSubagentInstructions.ts";

export const WORKFLOW_PROMPT_IDS = {
  workflowAgentCommunications: "workflow.agent-communications",
  planningGrillStageCodex: "planning.grill-stage.codex",
  planningSpecCodex: "planning.spec.codex",
  planningTicketsCodex: "planning.tickets.codex",
  planningTicketReviewerCodex: "planning.ticket-reviewer.codex",
  implementationOrchestratorPlanningCodex: "implementation.orchestrator-planning.codex",
  implementationTddCodex: "implementation.tdd.codex",
  implementationMergeGateCodex: "implementation.merge-gate.codex",
  implementationBrowserDevReviewCodex: "implementation.browser-dev-review.codex",
  implementationFixCodex: "implementation.fix.codex",
  implementationCodeReviewCodex: "implementation.code-review.codex",
  productWorkflowCodex: "product.workflow.codex",
} as const;

const WORKFLOW_AGENT_COMMUNICATIONS_PROMPT = WORKFLOW_SUBAGENT_INSTRUCTIONS_PROMPT;

const CONTEXT_FORMAT_ASSOCIATED_DOC_CONTENT = `# CONTEXT.md Format

## Structure

\`\`\`md
# {Context Name}

{One or two sentence description of what this context is and why it exists.}

## Language

**Order**:
{A one or two sentence description of the term}
_Avoid_: Purchase, transaction

**Invoice**:
A request for payment sent to a customer after delivery.
_Avoid_: Bill, payment request

**Customer**:
A person or organization that places orders.
_Avoid_: Client, buyer, account
\`\`\`

## Rules

- **Be opinionated.** When multiple words exist for the same concept, pick the best one and list the others under \`_Avoid_\`.
- **Keep definitions tight.** One or two sentences max. Define what it IS, not what it does.
- **Only include terms specific to this project's context.** General programming concepts (timeouts, error types, utility patterns) don't belong even if the project uses them extensively. Before adding a term, ask: is this a concept unique to this context, or a general programming concept? Only the former belongs.
- **Group terms under subheadings** when natural clusters emerge. If all terms belong to a single cohesive area, a flat list is fine.

## Single vs multi-context repos

**Single context (most repos):** One \`CONTEXT.md\` at the repo root.

**Multiple contexts:** A \`CONTEXT-MAP.md\` at the repo root lists the contexts, where they live, and how they relate to each other:

\`\`\`md
# Context Map

## Contexts

- [Ordering](./src/ordering/CONTEXT.md) - receives and tracks customer orders
- [Billing](./src/billing/CONTEXT.md) - generates invoices and processes payments
- [Fulfillment](./src/fulfillment/CONTEXT.md) - manages warehouse picking and shipping

## Relationships

- **Ordering → Fulfillment**: Ordering emits \`OrderPlaced\` events; Fulfillment consumes them to start picking
- **Fulfillment → Billing**: Fulfillment emits \`ShipmentDispatched\` events; Billing consumes them to generate invoices
- **Ordering ↔ Billing**: Shared types for \`CustomerId\` and \`Money\`
\`\`\`

The skill infers which structure applies:

- If \`CONTEXT-MAP.md\` exists, read it to find contexts
- If only a root \`CONTEXT.md\` exists, use the single context
- If neither exists, create a root \`CONTEXT.md\` lazily when the first term is resolved.

When multiple contexts exist, infer which one the current topic relates to. If unclear, ask.`;

const PLANNING_GRILL_PROMPT = `<collaboration_mode># Planning Workflow: Grill With Domain Modeling

Interview me relentlessly about every aspect of this plan until we reach a shared understanding. Walk down each branch of the design tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a *fact* can be found by exploring the codebase, look it up rather than asking me. The *decisions*, though, are mine — put each one to me and wait for my answer.

Do not enact the plan until I confirm we have reached a shared understanding.

Actively build and sharpen the project's domain model as you design. Actively maintain the domain model while grilling:

1. **Resolve the context structure** before relying on domain terms. If \`CONTEXT-MAP.md\` exists, read it to find contexts. If only a root \`CONTEXT.md\` exists, use the single context. If neither exists, create a root \`CONTEXT.md\` lazily when the first term is resolved. When multiple contexts exist, infer which one the current topic relates to. If unclear, ask.
2. **Challenge against the glossary.** When the user uses a term that conflicts with the existing language in \`CONTEXT.md\`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"
3. **Sharpen fuzzy language.** When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."
4. **Discuss concrete scenarios.** When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.
5. **Cross-reference with code.** When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"
6. **Update CONTEXT.md inline.** When a term is resolved, update \`CONTEXT.md\` right there. Don't batch these up — capture them as they happen. Use the format in CONTEXT-FORMAT.md. \`CONTEXT.md\` should be totally devoid of implementation details. Do not treat \`CONTEXT.md\` as a spec, a scratch pad, or a repository for implementation decisions. It is a glossary and nothing else.
7. **Offer ADRs sparingly.** Only offer to create an ADR when all three are true: 1. **Hard to reverse** — the cost of changing your mind later is meaningful 2. **Surprising without context** — a future reader will wonder "why did they do it this way?" 3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons. If any of the three is missing, skip the ADR. Use the format in ADR-FORMAT.md.

Create files lazily — only when you have something to write. If no \`CONTEXT.md\` exists, create one when the first term is resolved. If no \`docs/adr/\` exists, create it when the first ADR is needed. If a \`CONTEXT-MAP.md\` exists at the root, the repo has multiple contexts. The map points to where each one lives.

## Workflow stage constraints

Planning artifact writes are allowed for this workflow only when they are glossary or ADR updates produced by the grilling session. Do not make implementation changes during the grill.

Finish the grill only when the goal, audience, success criteria, scope, non-goals, terminology, key decisions, risks, edge cases, failure modes, and acceptance criteria are clear enough that the Spec stage can proceed without reopening product intent.
</collaboration_mode>`;

const PLANNING_SPEC_PROMPT = `<collaboration_mode># Planning Workflow: Spec

---
name: to-spec
description: Turn the current conversation into a spec and publish it to the project issue tracker — no interview, just synthesis of what you've already discussed.
disable-model-invocation: true
---

This skill takes the current conversation context and codebase understanding and produces a spec (you may know this document as a PRD). Do NOT interview the user — just synthesize what you already know.

The issue tracker and triage label vocabulary should have been provided to you — run \`/setup-matt-pocock-skills\` if not.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the spec, and respect any ADRs in the area you're touching.

2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better - the ideal number is one.

Check with the user that these seams match their expectations.

3. Write the spec using the template below, then publish it to the project issue tracker. Apply the \`ready-for-agent\` triage label - no need for additional triage.

<spec-template>

## Problem Statement

The problem that the user is facing, from the user's perspective.

## Solution

The solution to the problem, from the user's perspective.

## User Stories

A LONG, numbered list of user stories. Each user story should be in the format of:

1. As an <actor>, I want a <feature>, so that <benefit>

<user-story-example>
1. As a mobile bank customer, I want to see balance on my accounts, so that I can make better informed decisions about my spending
</user-story-example>

This list of user stories should be extremely extensive and cover all aspects of the feature.

## Implementation Decisions

A list of implementation decisions that were made. This can include:

- The modules that will be built/modified
- The interfaces of those modules that will be modified
- Technical clarifications from the developer
- Architectural decisions
- Schema changes
- API contracts
- Specific interactions

Do NOT include specific file paths or code snippets. They may end up being outdated very quickly.

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this spec.

## Further Notes

Any further notes about the feature.

</spec-template>
</collaboration_mode>`;

const PLANNING_TICKETS_PROMPT = `<collaboration_mode># Planning Workflow: Tickets

---
name: to-tickets
description: Break a plan, spec, or Spec into independently-grabbable tickets on the project ticket tracker using tracer-bullet vertical slices.
disable-model-invocation: true
---

# To Tickets

Break a plan into independently-grabbable tickets using vertical slices (tracer bullets).

The ticket tracker and triage label vocabulary should have been provided to you - run \`/setup-matt-pocock-skills\` if not.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes an ticket reference (ticket number, URL, or path) as an argument, fetch it from the ticket tracker and read its full body and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Ticket titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the plan into **tracer bullet** tickets. Each ticket is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

<vertical-slice-rules>

- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Any prefactoring should be done first

</vertical-slice-rules>

### 4. Hand off for ticket review

Stop after drafting the proposed ticket set. Do not quiz the user and do not publish the tickets from this stage.

The Ticket Review stage owns completeness review against the Spec and context, adjustment cycles, final user quiz, and ticket tracker publishing.
</collaboration_mode>`;

const PLANNING_REVIEW_PROMPT = `<collaboration_mode># Planning Workflow: Ticket Review

Review the Spec, conversation context, durable project context, and drafted planning tickets. The goal is to decide whether the ticket set is complete and whether the vertical slices are correct tracer bullets.

## Review goals

- Check that the drafted tickets cover the Spec's user stories, acceptance criteria, implementation decisions, testing decisions, out-of-scope boundaries, and relevant context.
- Check that each ticket is a narrow but complete vertical slice through the necessary integration layers, not a horizontal layer-only task.
- Check that each completed slice is independently demoable or verifiable.
- Check that prefactoring, contract/schema work, migrations, operational safeguards, and test seams are represented when they are required to make later slices reliable.
- Check dependency ordering, including blockers-first sequencing and whether any slices should be merged or split.
- Check that ticket bodies are ready for AFK agents: concrete outcome, clear acceptance criteria, useful tests, and no stale implementation path prescriptions.

## Review cycle

1. Read the Spec and all available context before judging the tickets.
2. Review the proposed ticket set against the Spec and context.
3. If anything is missing, too broad, too narrow, horizontally sliced, incorrectly blocked, or vague, return concrete corrections. Do not quiz the user while the ticket set still needs review corrections.
4. Repeat review after ticket adjustments until the ticket set is complete and the vertical slices are correct.

## User quiz

The reviewer subagent should not quiz the user; it should return review verdicts and concrete corrections. After the subagent tickets reviewer has completed all review cycles and the requested ticket adjustments are done, the planning thread should present the proposed breakdown to the user as a numbered list. For each slice, show:

- **Title**: short descriptive name
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?

Iterate until the user approves the breakdown.

## Publish approved tickets

For each approved slice, publish a new ticket to the ticket tracker. Use the ticket body template below. These tickets are considered ready for AFK agents, so publish them with the correct triage label unless instructed otherwise.

Publish tickets in dependency order (blockers first) so you can reference real ticket identifiers in the "Blocked by" field.

<ticket-template>
## Parent

A reference to the parent ticket on the ticket tracker (if the source was an existing ticket, otherwise omit this section).

## What to build

A concise description of this vertical slice. Describe the end-to-end behavior, not layer-by-layer implementation.

Avoid specific file paths or code snippets - they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it here and note briefly that it came from a prototype. Trim to the decision-rich parts - not a working demo, just the important bits.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2
- [ ] Criterion 3

## Blocked by

- A reference to the blocking ticket (if any)

Or "None - can start immediately" if no blockers.

</ticket-template>

Do NOT close or modify any parent ticket.
</collaboration_mode>`;

const PLANNING_ADR_FORMAT_ASSOCIATED_DOC_CONTENT = `# ADR Format

ADRs live in \`docs/adr/\` and use sequential numbering: \`0001-slug.md\`, \`0002-slug.md\`, etc.

Create the \`docs/adr/\` directory lazily - only when the first ADR is needed.

## Template

\`\`\`md
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
\`\`\`

That's it. An ADR can be a single paragraph. The value is in recording *that* a decision was made and *why* - not in filling out sections.

## Optional sections

Only include these when they add genuine value. Most ADRs won't need them.

- **Status** frontmatter (\`proposed | accepted | deprecated | superseded by ADR-NNNN\`) - useful when decisions are revisited
- **Considered Options** - only when the rejected alternatives are worth remembering
- **Consequences** - only when non-obvious downstream effects need to be called out

## Numbering

Scan \`docs/adr/\` for the highest existing number and increment by one.

## When to offer an ADR

All three of these must be true:

1. **Hard to reverse** - the cost of changing your mind later is meaningful
2. **Surprising without context** - a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off** - there were genuine alternatives and you picked one for specific reasons

If a decision is easy to reverse, skip it - you'll just reverse it. If it's not surprising, nobody will wonder why. If there was no real alternative, there's nothing to record beyond "we did the obvious thing."

### What qualifies

- **Architectural shape.** "We're using a monorepo." "The write model is event-sourced, the read model is projected into Postgres."
- **Integration patterns between contexts.** "Ordering and Billing communicate via domain events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth provider, deployment target. Not every library - just the ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Customer data is owned by the Customer context; other contexts reference it by ID only." The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** "We're using manual SQL instead of an ORM because X." Anything where a reasonable reader would assume the opposite. These stop the next engineer from "fixing" something that was deliberate.
- **Constraints not visible in the code.** "We can't use AWS because of compliance requirements." "Response times must be under 200ms because of the partner API contract."
- **Rejected alternatives when the rejection is non-obvious.** If you considered GraphQL and picked REST for subtle reasons, record it - otherwise someone will suggest GraphQL again in six months.`;

const IMPLEMENTATION_ORCHESTRATOR_PROMPT = `<collaboration_mode># Implementation Workflow: Orchestrator Start

Plan the implementation run from the Spec and planning tickets. Identify worktree strategy, ticket order, validation commands, required app-dev/browser review surfaces, merge gates, and how progress will be reported.
</collaboration_mode>`;

const IMPLEMENTATION_TDD_MOCKING_ASSOCIATED_DOC_CONTENT = `# When to Mock

Mock at **system boundaries** only:

- External APIs (payment, email, etc.)
- Databases (sometimes - prefer test DB)
- Time/randomness
- File system (sometimes)

Don't mock:

- Your own classes/modules
- Internal collaborators
- Anything you control

## Designing for Mockability

At system boundaries, design interfaces that are easy to mock:

**1. Use dependency injection**

Pass external dependencies in rather than creating them internally:

\`\`\`typescript
// Easy to mock
function processPayment(order, paymentClient) {
  return paymentClient.charge(order.total);
}

// Hard to mock
function processPayment(order) {
  const client = new StripeClient(process.env.STRIPE_KEY);
  return client.charge(order.total);
}
\`\`\`

**2. Prefer SDK-style interfaces over generic fetchers**

Create specific functions for each external operation instead of one generic function with conditional logic:

\`\`\`typescript
// GOOD: Each function is independently mockable
const api = {
  getUser: (id) => fetch(\`/users/\${id}\`),
  getOrders: (userId) => fetch(\`/users/\${userId}/orders\`),
  createOrder: (data) => fetch('/orders', { method: 'POST', body: data }),
};

// BAD: Mocking requires conditional logic inside the mock
const api = {
  fetch: (endpoint, options) => fetch(endpoint, options),
};
\`\`\`

The SDK approach means:
- Each mock returns one specific shape
- No conditional logic in test setup
- Easier to see which endpoints a test exercises
- Type safety per endpoint`;

const IMPLEMENTATION_TDD_GOOD_AND_BAD_TESTS_ASSOCIATED_DOC_CONTENT = `# Good and Bad Tests

## Good Tests

**Integration-style**: Test through real interfaces, not mocks of internal parts.

\`\`\`typescript
// GOOD: Tests observable behavior
test("user can checkout with valid cart", async () => {
  const cart = createCart();
  cart.add(product);
  const result = await checkout(cart, paymentMethod);
  expect(result.status).toBe("confirmed");
});
\`\`\`

Characteristics:

- Tests behavior users/callers care about
- Uses public API only
- Survives internal refactors
- Describes WHAT, not HOW
- One logical assertion per test

## Bad Tests

**Implementation-detail tests**: Coupled to internal structure.

\`\`\`typescript
// BAD: Tests implementation details
test("checkout calls paymentService.process", async () => {
  const mockPayment = jest.mock(paymentService);
  await checkout(cart, payment);
  expect(mockPayment.process).toHaveBeenCalledWith(cart.total);
});
\`\`\`

Red flags:

- Mocking internal collaborators
- Testing private methods
- Asserting on call counts/order
- Test breaks when refactoring without behavior change
- Test name describes HOW not WHAT
- Verifying through external means instead of interface

\`\`\`typescript
// BAD: Bypasses interface to verify
test("createUser saves to database", async () => {
  await createUser({ name: "Alice" });
  const row = await db.query("SELECT * FROM users WHERE name = ?", ["Alice"]);
  expect(row).toBeDefined();
});

// GOOD: Verifies through interface
test("createUser makes user retrievable", async () => {
  const user = await createUser({ name: "Alice" });
  const retrieved = await getUser(user.id);
  expect(retrieved.name).toBe("Alice");
});
\`\`\`

**Tautological tests**: Expected value restates the implementation, so the test passes by construction.

\`\`\`typescript
// BAD: Expected value is recomputed the way the code computes it
test("calculateTotal sums line items", () => {
  const items = [{ price: 10 }, { price: 5 }];
  const expected = items.reduce((sum, i) => sum + i.price, 0);
  expect(calculateTotal(items)).toBe(expected);
});

// GOOD: Expected value is an independent, known literal
test("calculateTotal sums line items", () => {
  expect(calculateTotal([{ price: 10 }, { price: 5 }])).toBe(15);
});
\`\`\``;

const IMPLEMENTATION_TDD_LOGGING_ASSOCIATED_DOC_CONTENT = `# Logging for TDD Implementation

## Mental Model

Logs should answer "what happened to this operation?" They should not narrate every line of code. Scattered string logs are optimized for being easy to write, not for answering production questions later.

Structured logging is necessary but not sufficient. Key-value logs are the starting point, but the target shape is a wide event, also called a canonical log line: one context-rich record for a request, command, provider turn, external process call, or service boundary.

OpenTelemetry, Effect tracing, and logger plumbing do not decide what context matters. The implementation agent still has to choose the useful business and operational context.

## Wide Events

Prefer one wide event at a meaningful boundary over many isolated strings. Build or enrich the event through the lifecycle and emit it once at completion when possible.

Useful fields include:

- timestamp
- operation name
- outcome
- duration
- request, trace, thread, turn, provider, and provider instance IDs
- service, version, deployment, or environment context when available
- external dependency latency and retry state
- structured error type, code, message, and retriable status

High-cardinality fields such as IDs, paths, request IDs, and trace IDs are valuable for debugging. Keep them on spans or log events where they are queryable. Do not put high-cardinality values on metric labels.

## T3 Code Effect Pattern

In Effect code, use \`Effect.annotateCurrentSpan\` for queryable context and emit logs inside active spans with \`Effect.logInfo\`, \`Effect.logWarning\`, or \`Effect.logError\`. Logs inside an active span become trace events in the server observability pipeline.

Use logs to capture operational facts that tests cannot prove on their own:

- state transitions
- retry attempts and final retry outcome
- external boundary latency
- failure cause and classification
- fallback path selection
- queue, cache, provider, or process boundary behavior

Never log secrets, credentials, tokens, raw authorization headers, private keys, or full prompts.

## Sampling

If sampling is introduced, prefer tail sampling rules:

- Always keep errors.
- Always keep slow operations.
- Always keep flagged sessions, debug users, or rollout cohorts under investigation.
- Randomly sample only ordinary successful operations.

## Checklist

- Can one query answer what failed, for which thread or user-visible operation, where, and how long it took?
- Is the event structured and consistently named?
- Are important IDs present as fields instead of buried in message strings?
- Are high-cardinality debugging fields on spans or log events, not metric labels?
- Are secrets and full prompts excluded?
- Does the logging complement tests instead of replacing behavior-focused tests?`;

const IMPLEMENTATION_TDD_PROMPT = `<collaboration_mode># Implementation Workflow: TDD Implementation

---
name: tdd
description: Test-driven development. Use when the user wants to build features or fix bugs test-first, mentions "red-green-refactor", or wants integration tests.
---

# Test-Driven Development

TDD is the red → green loop. This skill is the reference that makes that loop produce tests worth keeping: what a good test is, where tests go, the anti-patterns, and the rules of the loop. Every section applies on every cycle — consult them before and during the loop, not after.

When exploring the codebase, read \`CONTEXT.md\` (if it exists) so test names and interface vocabulary match the project's domain language, and respect ADRs in the area you're touching.

## What a good test is

Tests verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't. A good test reads like a specification — "user can checkout with valid cart" tells you exactly what capability exists — and survives refactors because it doesn't care about internal structure.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Seams — where tests go

A **seam** is the public boundary you test at: the interface where you observe behavior without reaching inside. Tests live at seams, never against internals.

**Test only at pre-agreed seams.** Before writing any test, write down the seams under test and confirm them with the user. No test is written at an unconfirmed seam. You can't test everything — agreeing the seams up front is how testing effort lands on the critical paths and complex logic instead of every edge case.

Ask: "What's the public interface, and which seams should we test?"

## Anti-patterns

- **Implementation-coupled** — mocks internal collaborators, tests private methods, or verifies through a side channel (querying the database instead of using the interface). The tell: the test breaks when you refactor but behavior hasn't changed.
- **Tautological** — the assertion recomputes the expected value the way the code does (\`expect(add(a, b)).toBe(a + b)\`, a snapshot derived by hand the same way, a constant asserted equal to itself), so it passes by construction and can never disagree with the code. Expected values must come from an independent source of truth — a known-good literal, a worked example, the spec.
- **Horizontal slicing** — writing all tests first, then all implementation. Bulk tests verify _imagined_ behavior: you test the _shape_ of things rather than user-facing behavior, the tests go insensitive to real changes, and you commit to test structure before understanding the implementation. Work in **vertical slices** instead — one test → one implementation → repeat, each test a **tracer bullet** that responds to what the last cycle taught you.

## Rules of the loop

- **Red before green.** Write the failing test first, then only enough code to pass it. Don't anticipate future tests or add speculative features.
- **One slice at a time.** One seam, one test, one minimal implementation per cycle.
- **Refactoring is not part of the loop.** It belongs to the review stage (see the \`code-review\` skill), not the red → green implementation cycle.

## Logging

Do not add scattered string logs as a debugging diary. Add logging when the new behavior creates an operational question that tests cannot answer — failure cause, retry outcome, external boundary latency, fallback selection, state transition. See [logging.md](logging.md) for the target shape and the checklist.

## Orchestrated Worker Result

When this prompt is run by an automatic implementation-worker thread, do not ask the user questions. Implement the assigned planning ticket, run focused validation, and finish with exactly one fenced JSON block using this shape:

\`\`\`json
{
  "type": "implementation-worker-result",
  "ticketId": "planning-ticket-id",
  "workerThreadId": "thread-id",
  "branch": "worker-branch",
  "worktreePath": "/absolute/worktree",
  "status": "succeeded",
  "commitSha": "commit-sha",
  "validations": [
    {
      "command": "vp test targeted-test",
      "status": "passed",
      "outputMarkdown": "Important output or empty string.",
      "completedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "notesMarkdown": "What changed and remaining risks.",
  "reportedAt": "2026-01-01T00:00:00.000Z"
}
\`\`\`
</collaboration_mode>`;

const IMPLEMENTATION_MERGE_GATE_PROMPT = `<collaboration_mode># Implementation Workflow: Merge Gate

Merge completed implementation work into the orchestrator worktree, resolve conflicts deliberately, run required validation, and report the concrete result.

Do not ask the user questions. If you cannot merge or validate, report a failed merge-gate result with the blocker.

When ready, finish with exactly one fenced JSON block using this shape:

\`\`\`json
{
  "type": "implementation-merge-gate-result",
  "runId": "implementation-run-id",
  "status": "passed",
  "validations": [
    {
      "command": "vp check",
      "status": "passed",
      "outputMarkdown": "Important output or empty string.",
      "completedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "summaryMarkdown": "What was merged and validated."
}
\`\`\`
</collaboration_mode>`;

const IMPLEMENTATION_BROWSER_DEV_REVIEW_PROMPT = `<collaboration_mode># Implementation Workflow: Browser Dev Review

Exercise the app-dev stack from the implementation worktree. Verify the relevant UI flows in-browser, capture concrete failures with reproduction steps, and create Dev Review findings before marking the implementation complete.

When this Browser Dev Review is linked to a durable Dev Review record:

1. Call dev_review_get first to load the durable Dev Review record before testing.
2. Read the source thread context and identify the behavior under review.
3. Call preview_open to initialize the collaborative browser tab. If the launch message provides a Feature URL, navigate there with preview_navigate. If no URL is provided, inspect the current preview state; if no usable app target is available, mark the review blocked with concrete details.
4. Start the screen recording with dev_review_recording_start before exercising the feature.
5. Exercise the product with the preview tools: preview_snapshot to inspect the page, then preview_click, preview_type, preview_press, preview_scroll, and preview_wait_for to interact. Re-run preview_snapshot after the DOM changes; element references from an old snapshot go stale. Do not rely on static assumptions.
6. Capture a captioned screenshot with dev_review_capture_screenshot at each meaningful application state (initial load, after key interactions, any failure states). Findings should reference these screenshot ids in evidenceIds.
7. Stop the recording with dev_review_recording_stop after browser testing.
8. Treat evidence as required. A terminal verdict (passed or failed) requires a saved recording and at least one screenshot; dev_review_update enforces this. If recording start or stop fails, or the browser tools are unavailable, mark the review blocked instead.
9. Update the Dev Review record with dev_review_update, including verdict, summary, checks, findings, questions, next steps, and evidence IDs.
10. Mark the review status passed, failed, or blocked.

If no durable Dev Review record is linked, still perform the Browser Dev Review, capture concrete findings in the conversation, and report whether implementation completion should proceed.

Use only the preview_* and dev_review_* MCP tools for browser work. Do not use external browsers, browser MCP servers, standalone Playwright scripts, or shell-driven browser automation. See preview-browser-qa.md for the full preview toolset guidance.
</collaboration_mode>`;

const IMPLEMENTATION_FIX_PROMPT = `<collaboration_mode># Implementation Workflow: Fix

Fix the Browser Dev Review, merge-gate, or code-review failures in the orchestrator worktree. Do not ask the user questions. Make the smallest reliable change, run relevant validation, and report whether the run can continue.

When ready, finish with exactly one fenced JSON block using this shape:

\`\`\`json
{
  "type": "implementation-fix-result",
  "runId": "implementation-run-id",
  "status": "succeeded",
  "commitSha": "optional-commit-sha",
  "validations": [
    {
      "command": "vp check",
      "status": "passed",
      "outputMarkdown": "Important output or empty string.",
      "completedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "notesMarkdown": "What changed and what remains."
}
\`\`\`
</collaboration_mode>`;

const IMPLEMENTATION_CODE_REVIEW_PROMPT = `<collaboration_mode># Implementation Workflow: Code Review

---
name: code-review
description: Review the changes since a fixed point (commit, branch, tag, or merge-base) along two axes — Standards (does the code follow this repo's documented coding standards?) and Spec (does the code match what the originating issue/PRD asked for?). Runs both reviews in parallel sub-agents and reports them side by side. Use when the user wants to review a branch, a PR, work-in-progress changes, or asks to "review since X".
---

Two-axis review of the diff between \`HEAD\` and a fixed point the user supplies:

- **Standards** — does the code conform to this repo's documented coding standards?
- **Spec** — does the code faithfully implement the originating issue / PRD / spec?

Both axes run as **parallel sub-agents** so they don't pollute each other's context, then this skill aggregates their findings.

The issue tracker should have been provided to you — run \`/setup-matt-pocock-skills\` if \`docs/agents/issue-tracker.md\` is missing.

## Process

### 1. Pin the fixed point

Whatever the user said is the fixed point — a commit SHA, branch name, tag, \`main\`, \`HEAD~5\`, etc. If they didn't specify one, ask for it.

Capture the diff command once: \`git diff <fixed-point>...HEAD\` (three-dot, so the comparison is against the merge-base). Also note the list of commits via \`git log <fixed-point>..HEAD --oneline\`.

Before going further, confirm the fixed point resolves (\`git rev-parse <fixed-point>\`) and the diff is non-empty. A bad ref or empty diff should fail here — not inside two parallel sub-agents.

### 2. Identify the spec source

Look for the originating spec, in this order:

1. Issue references in the commit messages (\`#123\`, \`Closes #45\`, GitLab \`!67\`, etc.) — fetch via the workflow in \`docs/agents/issue-tracker.md\`.
2. A path the user passed as an argument.
3. A PRD/spec file under \`docs/\`, \`specs/\`, or \`.scratch/\` matching the branch name or feature.
4. If nothing is found, ask the user where the spec is. If they say there isn't one, the **Spec** sub-agent will skip and report "no spec available".

### 3. Identify the standards sources

Anything in the repo that documents how code should be written, such as \`CODING_STANDARDS.md\` or \`CONTRIBUTING.md\`.

On top of whatever the repo documents, the Standards axis always carries the **smell baseline** below — a fixed set of Fowler code smells (_Refactoring_, ch.3) that applies even when a repo documents nothing. Two rules bind it:

- **The repo overrides.** A documented repo standard always wins; where it endorses something the baseline would flag, suppress the smell.
- **Always a judgement call.** Each smell is a labelled heuristic ("possible Feature Envy"), never a hard violation — and, like any standard here, skip anything tooling already enforces.

Each smell reads *what it is* → *how to fix*; match it against the diff:

- **Mysterious Name** — a function, variable, or type whose name doesn't reveal what it does or holds. → rename it; if no honest name comes, the design's murky.
- **Duplicated Code** — the same logic shape appears in more than one hunk or file in the change. → extract the shared shape, call it from both.
- **Feature Envy** — a method that reaches into another object's data more than its own. → move the method onto the data it envies.
- **Data Clumps** — the same few fields or params keep travelling together (a type wanting to be born). → bundle them into one type, pass that.
- **Primitive Obsession** — a primitive or string standing in for a domain concept that deserves its own type. → give the concept its own small type.
- **Repeated Switches** — the same \`switch\`/\`if\`-cascade on the same type recurs across the change. → replace with polymorphism, or one map both sites share.
- **Shotgun Surgery** — one logical change forces scattered edits across many files in the diff. → gather what changes together into one module.
- **Divergent Change** — one file or module is edited for several unrelated reasons. → split so each module changes for one reason.
- **Speculative Generality** — abstraction, parameters, or hooks added for needs the spec doesn't have. → delete it; inline back until a real need shows.
- **Message Chains** — long \`a.b().c().d()\` navigation the caller shouldn't depend on. → hide the walk behind one method on the first object.
- **Middle Man** — a class or function that mostly just delegates onward. → cut it, call the real target direct.
- **Refused Bequest** — a subclass or implementer that ignores or overrides most of what it inherits. → drop the inheritance, use composition.

### 4. Spawn both sub-agents in parallel

Send a single message with two \`Agent\` tool calls. Use the \`general-purpose\` subagent for both.

**Standards sub-agent prompt** — include:

- The full diff command and commit list.
- The list of standards-source files you found in step 3, **plus the smell baseline from step 3** pasted in full — the sub-agent has no other access to it.
- The brief: "Report — per file/hunk where relevant — (a) every place the diff violates a documented standard: cite the standard (file + the rule); and (b) any baseline smell you spot: name it and quote the hunk. Distinguish hard violations from judgement calls — documented-standard breaches can be hard, but baseline smells are always judgement calls, and a documented repo standard overrides the baseline. Skip anything tooling enforces. Under 400 words."

**Spec sub-agent prompt** — include:

- The diff command and commit list.
- The path or fetched contents of the spec.
- The brief: "Report: (a) requirements the spec asked for that are missing or partial; (b) behaviour in the diff that wasn't asked for (scope creep); (c) requirements that look implemented but where the implementation looks wrong. Quote the spec line for each finding. Under 400 words."

If the spec is missing, skip the Spec sub-agent and note this in the final report.

### 5. Aggregate

Present the two reports under \`## Standards\` and \`## Spec\` headings, verbatim or lightly cleaned. Do **not** merge or rerank findings — the two axes are deliberately separate (see _Why two axes_).

End with a one-line summary: total findings per axis, and the worst issue _within each axis_ (if any). Don't pick a single winner across axes — that's the reranking the separation exists to prevent.

## Why two axes

A change can pass one axis and fail the other:

- Code that follows every standard but implements the wrong thing → **Standards pass, Spec fail.**
- Code that does exactly what the issue asked but breaks the project's conventions → **Spec pass, Standards fail.**

Reporting them separately stops one axis from masking the other.

## Orchestrated Code Review Result

When this prompt is run by an automatic implementation run, do not ask the user questions. The launch message provides the fixed point, the diff command, the worktree, the change request, and the Spec source — use those instead of asking or searching the issue tracker. Run both axes, aggregate the report, and finish with exactly one fenced JSON block using this shape:

\`\`\`json
{
  "type": "implementation-code-review-result",
  "runId": "implementation-run-id",
  "status": "clean",
  "reportMarkdown": "## Standards\\n...\\n\\n## Spec\\n..."
}
\`\`\`

Use status "clean" only when neither axis has findings that require code changes, "findings" when code changes are required (include every finding in reportMarkdown), and "blocked" when the review cannot be performed (say why in reportMarkdown).
</collaboration_mode>`;

const PRODUCT_WORKFLOW_PROMPT = `<collaboration_mode># Product Workflow: Intent Grill

This is the workflow's single human gate. After intent is locked, all later planning, review, implementation, merge, browser review, and PR filing transitions are automatic.

Interview me relentlessly about every aspect of this product intent until we reach a shared understanding. Walk down each branch of the decision tree, resolving dependencies between decisions one-by-one. For each question, provide your recommended answer.

Ask the questions one at a time, waiting for feedback on each question before continuing. Asking multiple questions at once is bewildering.

If a *fact* can be found by exploring the codebase, look it up rather than asking me. The *decisions*, though, are mine — put each one to me and wait for my answer.

Do not lock intent until I confirm we have reached a shared understanding.

Grill product questions only: the problem, the desired outcome, the audience, success criteria, scope, and non-goals. Do not grill implementation, architecture, or testing decisions — after intent locks, the automated Planning and Implementation workflows resolve those without asking the user.

Actively maintain durable product context while grilling:

1. Resolve the context structure before relying on domain terms. If a root CONTEXT-MAP.md exists, read it to find the right bounded context. If only a root CONTEXT.md exists, use it as the single context.
2. Create or update CONTEXT.md lazily only when the first domain term is resolved. CONTEXT.md is a glossary only: no implementation details, planning notes, TODOs, API specs, or architecture decisions. Use tight definitions, list rejected synonyms under _Avoid_, and include only project-specific domain concepts. Use the format in CONTEXT-FORMAT.md.
3. Create docs/adr/000N-slug.md lazily only when an ADR is warranted: the decision is hard to reverse, surprising without context, and the result of a real trade-off. Use the format in ADR-FORMAT.md.
4. When multiple contexts exist, infer the target context from the topic; if unclear, ask. If existing context conflicts with the user's intent, ask which should become authoritative before locking intent.

## Workflow stage constraints

Do not make implementation changes during the grill.

Before locking intent, finish any required CONTEXT.md glossary updates and ADR files. Finish only when the product intent is locked enough that the Planning Workflow sub-agent can create the Spec, planning tickets, and ticket review, and the Implementation Workflow sub-agent can proceed without further user questions.

Your final response for this stage must contain exactly one JSON directive and no other fenced JSON blocks:

\`\`\`json
{ "type": "product-intent-locked", "title": "...", "summaryMarkdown": "..." }
\`\`\`
</collaboration_mode>`;

export const WORKFLOW_PROMPT_REGISTRY = [
  {
    id: WORKFLOW_PROMPT_IDS.workflowAgentCommunications,
    order: 1,
    workflow: "shared",
    role: "workflow-communications",
    stage: "agent-communications",
    title: "Agent Communications",
    description:
      "Shared workflow instructions for workflow thread messaging, blockers, and stage handoffs.",
    promptText: WORKFLOW_AGENT_COMMUNICATIONS_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.planningGrillStageCodex,
    order: 1,
    workflow: "planning",
    role: "planning-thread",
    stage: "grill",
    title: "1. Grill",
    description: "Challenges the plan against repo language and constraints before Spec authoring.",
    promptText: PLANNING_GRILL_PROMPT,
    associatedDocs: [
      {
        id: "planning.grill-stage.context-format",
        title: "CONTEXT.md Format",
        path: "CONTEXT-FORMAT.md",
        content: CONTEXT_FORMAT_ASSOCIATED_DOC_CONTENT,
      },
      {
        id: "planning.grill-stage.adr-format",
        title: "ADR Format",
        path: "ADR-FORMAT.md",
        content: PLANNING_ADR_FORMAT_ASSOCIATED_DOC_CONTENT,
      },
    ],
  },
  {
    id: WORKFLOW_PROMPT_IDS.planningSpecCodex,
    order: 2,
    workflow: "planning",
    role: "planning-thread",
    stage: "spec-authoring",
    title: "2. Spec",
    description: "Creates the durable Spec artifact from planning context and locked decisions.",
    promptText: PLANNING_SPEC_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.planningTicketsCodex,
    order: 3,
    workflow: "planning",
    role: "planning-thread",
    stage: "tickets-authoring",
    title: "3. Tickets",
    description:
      "Decomposes the Spec into implementation-ready planning tickets with dependencies and tests.",
    promptText: PLANNING_TICKETS_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex,
    order: 4,
    workflow: "planning",
    role: "planning-reviewer",
    stage: "ticket-review",
    title: "4. Ticket Review",
    description:
      "Reviews planning tickets for dependency correctness, readiness, and Spec alignment.",
    promptText: PLANNING_REVIEW_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.implementationOrchestratorPlanningCodex,
    order: 1,
    workflow: "implementation",
    role: "implementation-orchestrator",
    stage: "orchestrator-start",
    title: "1. Orchestrator Start",
    description: "Plans a durable implementation orchestration run from a Spec.",
    promptText: IMPLEMENTATION_ORCHESTRATOR_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.implementationTddCodex,
    order: 2,
    workflow: "implementation",
    role: "implementation-worker",
    stage: "tdd",
    title: "2. TDD Implementation",
    description:
      "Implements planning tickets with a red-green-refactor loop and focused validation.",
    promptText: IMPLEMENTATION_TDD_PROMPT,
    associatedDocs: [
      {
        id: "implementation.tdd.mocking",
        title: "When to Mock",
        path: "mocking.md",
        content: IMPLEMENTATION_TDD_MOCKING_ASSOCIATED_DOC_CONTENT,
      },
      {
        id: "implementation.tdd.tests",
        title: "Good and Bad Tests",
        path: "tests.md",
        content: IMPLEMENTATION_TDD_GOOD_AND_BAD_TESTS_ASSOCIATED_DOC_CONTENT,
      },
      {
        id: "implementation.tdd.logging",
        title: "Logging for TDD",
        path: "logging.md",
        content: IMPLEMENTATION_TDD_LOGGING_ASSOCIATED_DOC_CONTENT,
      },
    ],
  },
  {
    id: WORKFLOW_PROMPT_IDS.implementationMergeGateCodex,
    order: 3,
    workflow: "implementation",
    role: "implementation-validator",
    stage: "merge-gate",
    title: "3. Merge Gate",
    description: "Merges implementation work and fixes validation failures until green.",
    promptText: IMPLEMENTATION_MERGE_GATE_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
    order: 4,
    workflow: "implementation",
    role: "implementation-qa-reviewer",
    stage: "browser-dev-review",
    title: "4. Browser Dev Review",
    description: "Tests the app-dev stack and creates concrete Dev Review findings.",
    promptText: IMPLEMENTATION_BROWSER_DEV_REVIEW_PROMPT,
    associatedDocs: [
      {
        id: "implementation.browser-dev-review.preview-browser-qa",
        path: "preview-browser-qa.md",
        title: "Preview Browser QA",
        content: PREVIEW_BROWSER_QA_ASSOCIATED_DOC_CONTENT,
      },
    ],
  },
  {
    id: WORKFLOW_PROMPT_IDS.implementationFixCodex,
    order: 5,
    workflow: "implementation",
    role: "implementation-fixer",
    stage: "fix",
    title: "5. Fix",
    description:
      "Fixes merge-gate, browser-review, or code-review failures before rerunning validation.",
    promptText: IMPLEMENTATION_FIX_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
    order: 6,
    workflow: "implementation",
    role: "implementation-code-reviewer",
    stage: "code-review",
    title: "6. Code Review",
    description:
      "Reviews the filed change request along the Standards and Spec axes via parallel sub-agents.",
    promptText: IMPLEMENTATION_CODE_REVIEW_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.productWorkflowCodex,
    order: 1,
    workflow: "product",
    role: "planning-thread",
    stage: "intent",
    title: "Product Workflow",
    description:
      "Gathers and locks product intent before automatically running Planning and Implementation.",
    promptText: PRODUCT_WORKFLOW_PROMPT,
    associatedDocs: [
      {
        id: "product.workflow.context-format",
        title: "CONTEXT.md Format",
        path: "CONTEXT-FORMAT.md",
        content: CONTEXT_FORMAT_ASSOCIATED_DOC_CONTENT,
      },
      {
        id: "product.workflow.adr-format",
        title: "ADR Format",
        path: "ADR-FORMAT.md",
        content: PLANNING_ADR_FORMAT_ASSOCIATED_DOC_CONTENT,
      },
    ],
  },
] as const satisfies ReadonlyArray<WorkflowPromptContract>;

function cloneWorkflowPromptContract(contract: WorkflowPromptContract): WorkflowPromptContract {
  return {
    ...contract,
    associatedDocs: contract.associatedDocs?.map((doc) => ({ ...doc })),
  };
}

export function listWorkflowPromptContracts(): WorkflowPromptContract[] {
  return WORKFLOW_PROMPT_REGISTRY.map(cloneWorkflowPromptContract);
}

export function resolveWorkflowPromptContract(id: string): WorkflowPromptContract {
  const contract = WORKFLOW_PROMPT_REGISTRY.find((entry) => entry.id === id);
  if (contract === undefined) {
    throw new Error(`Unknown workflow prompt contract '${id}'`);
  }
  return cloneWorkflowPromptContract(contract);
}

export function isRegisteredWorkflowPromptId(id: string): boolean {
  return WORKFLOW_PROMPT_REGISTRY.some((entry) => entry.id === id);
}

export function isBrowserDevReviewWorkflowPromptId(
  workflowPromptId: string | null | undefined,
): boolean {
  return (
    workflowPromptId !== null &&
    workflowPromptId !== undefined &&
    workflowPromptId === WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex
  );
}

export function isPreviewMcpWorkflowPromptId(workflowPromptId: string | null | undefined): boolean {
  return isBrowserDevReviewWorkflowPromptId(workflowPromptId);
}

export function isDevReviewMcpWorkflowPromptId(
  workflowPromptId: string | null | undefined,
): boolean {
  return isBrowserDevReviewWorkflowPromptId(workflowPromptId);
}

function renderAssociatedDoc(doc: NonNullable<WorkflowPromptContract["associatedDocs"]>[number]) {
  return `<associated-doc id="${doc.id}" path="${doc.path}" title="${doc.title}">
${doc.content}
</associated-doc>`;
}

export function resolveWorkflowPromptText(id: string): string {
  const contract = resolveWorkflowPromptContract(id);
  if (contract.associatedDocs === undefined || contract.associatedDocs.length === 0) {
    return contract.promptText;
  }

  const docs = contract.associatedDocs.map(renderAssociatedDoc).join("\n\n");
  return `${contract.promptText}\n\n${docs}`;
}

export function resolveWorkflowPromptId(input: {
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly workflowPromptId?: string | undefined;
}): string | undefined {
  if (
    input.workflowPromptId !== undefined &&
    isRegisteredWorkflowPromptId(input.workflowPromptId)
  ) {
    return input.workflowPromptId;
  }
  switch (input.interactionMode) {
    case "planning-workflow":
      return WORKFLOW_PROMPT_IDS.planningGrillStageCodex;
    case "product-workflow":
      return WORKFLOW_PROMPT_IDS.productWorkflowCodex;
    case "implementation-workflow":
      return WORKFLOW_PROMPT_IDS.implementationOrchestratorPlanningCodex;
    default:
      return undefined;
  }
}

export function resolveWorkflowSystemInstructions(input: {
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly workflowPromptId?: string | undefined;
}): string | undefined {
  const workflowPromptId = resolveWorkflowPromptId(input);
  if (workflowPromptId === undefined) {
    return undefined;
  }

  if (workflowPromptId === WORKFLOW_PROMPT_IDS.workflowAgentCommunications) {
    return resolveWorkflowPromptText(workflowPromptId);
  }

  return `${resolveWorkflowPromptText(
    WORKFLOW_PROMPT_IDS.workflowAgentCommunications,
  )}\n\n${resolveWorkflowPromptText(workflowPromptId)}`;
}

export function isWorkflowInteractionMode(
  mode: ProviderInteractionMode | null | undefined,
): boolean {
  return isPlanningWorkflowInteractionMode(mode) || mode === "implementation-workflow";
}
