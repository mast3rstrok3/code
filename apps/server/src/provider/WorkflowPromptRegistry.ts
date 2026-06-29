import type { ProviderInteractionMode, WorkflowPromptContract } from "@t3tools/contracts";
import { isPlanningWorkflowInteractionMode } from "@t3tools/contracts";

import { CHROME_DEVTOOLS_MCP_ASSOCIATED_DOC_CONTENT } from "./ChromeDevtoolsMcp.ts";

export const WORKFLOW_PROMPT_IDS = {
  workflowAgentCommunications: "workflow.agent-communications",
  planningGrillStageCodex: "planning.grill-stage.codex",
  planningPrdCodex: "planning.prd.codex",
  planningIssuesCodex: "planning.issues.codex",
  planningIssueReviewerCodex: "planning.issue-reviewer.codex",
  implementationOrchestratorPlanningCodex: "implementation.orchestrator-planning.codex",
  implementationTddCodex: "implementation.tdd.codex",
  implementationMergeGateCodex: "implementation.merge-gate.codex",
  implementationBrowserDevReviewCodex: "implementation.browser-dev-review.codex",
  implementationFixCodex: "implementation.fix.codex",
  productGrillStageCodex: "product.grill-stage.codex",
} as const;

const LEGACY_WORKFLOW_PROMPT_ID_ALIASES = {
  "implementation.qna-dev-review.codex": WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
  "yolo.grill-stage.codex": WORKFLOW_PROMPT_IDS.productGrillStageCodex,
} as const satisfies Record<string, string>;

const WORKFLOW_AGENT_COMMUNICATIONS_PROMPT = `## Agent-Only Thread Messaging

When this workflow needs to communicate with another workflow thread, keep the message concise and structured. Report blockers explicitly, name the target workflow stage, and include the next actionable step.`;

const CONTEXT_FORMAT_ASSOCIATED_DOC_CONTENT = `# CONTEXT.md Format

CONTEXT.md is a glossary for domain language only. It must not contain implementation details, planning notes, TODOs, API specs, or architecture decisions.

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

- **Ordering -> Fulfillment**: Ordering emits \`OrderPlaced\` events; Fulfillment consumes them to start picking
- **Fulfillment -> Billing**: Fulfillment emits \`ShipmentDispatched\` events; Billing consumes them to generate invoices
- **Ordering <-> Billing**: Shared types for \`CustomerId\` and \`Money\`
\`\`\`

The skill infers which structure applies:

- If \`CONTEXT-MAP.md\` exists, read it to find contexts.
- If only a root \`CONTEXT.md\` exists, use the single context.
- If neither exists, create a root \`CONTEXT.md\` lazily when the first term is resolved.
- When multiple contexts exist, infer which one the current topic relates to. If unclear, ask.`;

const PLANNING_GRILL_PROMPT = `<collaboration_mode># Planning Workflow: Grill With Domain Modeling

Run a relentless planning interview that also sharpens the project's domain model.

Your job is to stress-test the user's plan or design until there is a shared, decision-complete understanding. Walk down each branch of the design tree, resolving dependencies between decisions one by one. Ask exactly one question at a time and wait for feedback before continuing. For every question, include your recommended answer and the reason for that recommendation.

If a question can be answered by exploring the repository, explore the repository instead of asking. Use the codebase, existing docs, schemas, tests, and configuration as sources of truth. When the user's description conflicts with the code, surface the contradiction directly and ask which should become authoritative.

Actively maintain the domain model while grilling:

1. Resolve the context structure before relying on domain terms. If a root CONTEXT-MAP.md exists, read it to find the right bounded context. If only a root CONTEXT.md exists, use it as the single context. If neither exists, create a root CONTEXT.md lazily when the first term is resolved.
2. Challenge glossary conflicts immediately. If the glossary defines a term one way and the user appears to mean another, ask which meaning should win.
3. Sharpen fuzzy or overloaded language by proposing precise canonical terms and listing rejected synonyms under _Avoid_.
4. Stress-test domain relationships with concrete scenarios and edge cases.
5. When a term is resolved, capture it in the relevant CONTEXT.md immediately with a tight definition. Include only project-specific domain concepts, not general programming concepts.
6. Offer an ADR only when the decision is hard to reverse, surprising without context, and the result of a real trade-off. If any criterion is missing, do not create an ADR.

Create domain-modeling files lazily. If no CONTEXT.md or CONTEXT-MAP.md exists, create a root CONTEXT.md only when the first term is resolved. When multiple contexts exist, infer the target context from the topic; if unclear, ask. If no docs/adr/ directory exists, create it only when the first ADR is accepted.

Planning artifact writes are allowed for this workflow only when they are glossary or ADR updates produced by the grilling session. Do not make implementation changes during the grill.

Finish the grill only when the goal, audience, success criteria, scope, non-goals, terminology, key decisions, risks, edge cases, failure modes, and acceptance criteria are clear enough that the PRD stage can proceed without reopening product intent.
</collaboration_mode>`;

const PLANNING_PRD_PROMPT = `<collaboration_mode># Planning Workflow: PRD

---
name: to-prd
description: Turn the current conversation into a PRD and publish it to the project issue tracker - no interview, just synthesis of what you've already discussed.
disable-model-invocation: true
---

This skill takes the current conversation context and codebase understanding and produces a PRD. Do NOT interview the user - just synthesize what you already know.

The issue tracker and triage label vocabulary should have been provided to you - run \`/setup-matt-pocock-skills\` if not.

## Process

1. Explore the repo to understand the current state of the codebase, if you haven't already. Use the project's domain glossary vocabulary throughout the PRD, and respect any ADRs in the area you're touching.

2. Sketch out the seams at which you're going to test the feature. Existing seams should be preferred to new ones. Use the highest seam possible. If new seams are needed, propose them at the highest point you can. The fewer seams across the codebase, the better - the ideal number is one.

Check with the user that these seams match their expectations.

3. Write the PRD using the template below, then publish it to the project issue tracker. Apply the \`ready-for-agent\` triage label - no need for additional triage.

<prd-template>

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

Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it within the relevant decision and note briefly that it came from a prototype. Trim to the decision-rich parts - not a working demo, just the important bits.

## Testing Decisions

A list of testing decisions that were made. Include:

- A description of what makes a good test (only test external behavior, not implementation details)
- Which modules will be tested
- Prior art for the tests (i.e. similar types of tests in the codebase)

## Out of Scope

A description of the things that are out of scope for this PRD.

## Further Notes

Any further notes about the feature.

</prd-template>
</collaboration_mode>`;

const PLANNING_ISSUES_PROMPT = `<collaboration_mode># Planning Workflow: Issues

---
name: to-issues
description: Break a plan, spec, or PRD into independently-grabbable issues on the project issue tracker using tracer-bullet vertical slices.
disable-model-invocation: true
---

# To Issues

Break a plan into independently-grabbable issues using vertical slices (tracer bullets).

The issue tracker and triage label vocabulary should have been provided to you - run \`/setup-matt-pocock-skills\` if not.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes an issue reference (issue number, URL, or path) as an argument, fetch it from the issue tracker and read its full body and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Issue titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the plan into **tracer bullet** issues. Each issue is a thin vertical slice that cuts through ALL integration layers end-to-end, NOT a horizontal slice of one layer.

<vertical-slice-rules>

- Each slice delivers a narrow but COMPLETE path through every layer (schema, API, UI, tests)
- A completed slice is demoable or verifiable on its own
- Any prefactoring should be done first

</vertical-slice-rules>

### 4. Hand off for issue review

Stop after drafting the proposed issue set. Do not quiz the user and do not publish the issues from this stage.

The Issues Review stage owns completeness review against the PRD and context, adjustment cycles, final user quiz, and issue tracker publishing.
</collaboration_mode>`;

const PLANNING_REVIEW_PROMPT = `<collaboration_mode># Planning Workflow: Issue Review

Review the PRD, conversation context, durable project context, and drafted planning issues. The goal is to decide whether the issue set is complete and whether the vertical slices are correct tracer bullets.

## Review goals

- Check that the drafted issues cover the PRD's user stories, acceptance criteria, implementation decisions, testing decisions, out-of-scope boundaries, and relevant context.
- Check that each issue is a narrow but complete vertical slice through the necessary integration layers, not a horizontal layer-only task.
- Check that each completed slice is independently demoable or verifiable.
- Check that prefactoring, contract/schema work, migrations, operational safeguards, and test seams are represented when they are required to make later slices reliable.
- Check dependency ordering, including blockers-first sequencing and whether any slices should be merged or split.
- Check that issue bodies are ready for AFK agents: concrete outcome, clear acceptance criteria, useful tests, and no stale implementation path prescriptions.

## Review cycle

1. Read the PRD and all available context before judging the issues.
2. Review the proposed issue set against the PRD and context.
3. If anything is missing, too broad, too narrow, horizontally sliced, incorrectly blocked, or vague, return concrete corrections. Do not quiz the user while the issue set still needs review corrections.
4. Repeat review after issue adjustments until the issue set is complete and the vertical slices are correct.

## User quiz

The reviewer subagent should not quiz the user; it should return review verdicts and concrete corrections. After the subagent issues reviewer has completed all review cycles and the requested issue adjustments are done, the planning thread should present the proposed breakdown to the user as a numbered list. For each slice, show:

- **Title**: short descriptive name
- **Blocked by**: which other slices (if any) must complete first
- **User stories covered**: which user stories this addresses (if the source material has them)

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the dependency relationships correct?
- Should any slices be merged or split further?

Iterate until the user approves the breakdown.

## Publish approved issues

For each approved slice, publish a new issue to the issue tracker. Use the issue body template below. These issues are considered ready for AFK agents, so publish them with the correct triage label unless instructed otherwise.

Publish issues in dependency order (blockers first) so you can reference real issue identifiers in the "Blocked by" field.

<issue-template>
## Parent

A reference to the parent issue on the issue tracker (if the source was an existing issue, otherwise omit this section).

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

</issue-template>

Do NOT close or modify any parent issue.
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

Plan the implementation run from the PRD and planning issues. Identify worktree strategy, issue order, validation commands, required app-dev/browser review surfaces, merge gates, and how progress will be reported.
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

const IMPLEMENTATION_TDD_REFACTORING_ASSOCIATED_DOC_CONTENT = `# Refactor Candidates

After TDD cycle, look for:

- **Duplication** -> Extract function/class
- **Long methods** -> Break into private helpers (keep tests on public interface)
- **Shallow modules** -> Combine or deepen
- **Feature envy** -> Move logic to where data lives
- **Primitive obsession** -> Introduce value objects
- **Existing code** the new code reveals as problematic`;

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

## Philosophy

**Core principle**: Tests should verify behavior through public interfaces, not implementation details. Code can change entirely; tests shouldn't.

**Good tests** are integration-style: they exercise real code paths through public APIs. They describe _what_ the system does, not _how_ it does it. A good test reads like a specification - "user can checkout with valid cart" tells you exactly what capability exists. These tests survive refactors because they don't care about internal structure.

**Bad tests** are coupled to implementation. They mock internal collaborators, test private methods, or verify through external means (like querying a database directly instead of using the interface). The warning sign: your test breaks when you refactor, but behavior hasn't changed. If you rename an internal function and tests fail, those tests were testing implementation, not behavior.

See [tests.md](tests.md) for examples and [mocking.md](mocking.md) for mocking guidelines.

## Logging

Do not add scattered string logs as a debugging diary. Add logging when the new behavior creates an operational question that tests cannot answer, such as failure cause, retry outcome, external boundary latency, fallback selection, or state transition.

Prefer context-rich structured logs or span events at meaningful boundaries. Treat wide events / canonical log lines as the target shape: one queryable record for what happened to this request, command, provider turn, external process, or service boundary.

Include high-cardinality debugging context where it is useful: thread IDs, turn IDs, provider IDs, provider instance IDs, request IDs, trace IDs, operation names, outcomes, durations, and error type/code.

In Effect code, prefer \`Effect.annotateCurrentSpan\` plus \`Effect.log...\` inside active spans so the context and logs become part of the trace story. Never log secrets, credentials, tokens, raw authorization headers, private keys, or full prompts.

See [logging.md](logging.md) for the detailed logging checklist.

## Anti-Pattern: Horizontal Slices

**DO NOT write all tests first, then all implementation.** This is "horizontal slicing" - treating RED as "write all tests" and GREEN as "write all code."

This produces **crap tests**:

- Tests written in bulk test _imagined_ behavior, not _actual_ behavior
- You end up testing the _shape_ of things (data structures, function signatures) rather than user-facing behavior
- Tests become insensitive to real changes - they pass when behavior breaks, fail when behavior is fine
- You outrun your headlights, committing to test structure before understanding the implementation

**Correct approach**: Vertical slices via tracer bullets. One test -> one implementation -> repeat. Each test responds to what you learned from the previous cycle. Because you just wrote the code, you know exactly what behavior matters and how to verify it.

\`\`\`
WRONG (horizontal):
  RED:   test1, test2, test3, test4, test5
  GREEN: impl1, impl2, impl3, impl4, impl5

RIGHT (vertical):
  RED->GREEN: test1->impl1
  RED->GREEN: test2->impl2
  RED->GREEN: test3->impl3
  ...
\`\`\`

## Workflow

### 1. Planning

When exploring the codebase, read the relevant \`CONTEXT.md\` before relying on domain terms. If a root \`CONTEXT-MAP.md\` exists, use it to find the right context; otherwise read the root \`CONTEXT.md\` if it exists. Make test names and interface vocabulary match the project's domain language, and respect ADRs in the area you're touching.

Before writing any code:

- [ ] Confirm with user what interface changes are needed
- [ ] Confirm with user which behaviors to test (prioritize)
- [ ] Identify opportunities for deep modules (small interface, deep implementation) - run the \`/codebase-design\` skill for the vocabulary and the testability checks
- [ ] List the behaviors to test (not implementation steps)
- [ ] Get user approval on the plan

Ask: "What should the public interface look like? Which behaviors are most important to test?"

**You can't test everything.** Confirm with the user exactly which behaviors matter most. Focus testing effort on critical paths and complex logic, not every possible edge case.

### 2. Tracer Bullet

Write ONE test that confirms ONE thing about the system:

\`\`\`
RED:   Write test for first behavior -> test fails
GREEN: Write minimal code to pass -> test passes
\`\`\`

This is your tracer bullet - proves the path works end-to-end.

### 3. Incremental Loop

For each remaining behavior:

\`\`\`
RED:   Write next test -> fails
GREEN: Minimal code to pass -> passes
\`\`\`

Rules:

- One test at a time
- Only enough code to pass current test
- Don't anticipate future tests
- Keep tests focused on observable behavior

### 4. Refactor

After all tests pass, look for [refactor candidates](refactoring.md):

- [ ] Extract duplication
- [ ] Deepen modules (move complexity behind simple interfaces)
- [ ] Apply SOLID principles where natural
- [ ] Consider what new code reveals about existing code
- [ ] Run tests after each refactor step

**Never refactor while RED.** Get to GREEN first.

## Orchestrated Worker Result

When this prompt is run by an automatic implementation-worker thread, do not ask the user questions. Implement the assigned planning issue, run focused validation, and finish with exactly one fenced JSON block using this shape:

\`\`\`json
{
  "type": "implementation-worker-result",
  "issueId": "planning-issue-id",
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

## Checklist Per Cycle

\`\`\`
[ ] Test describes behavior, not implementation
[ ] Test uses public interface only
[ ] Test would survive internal refactor
[ ] Code is minimal for this test
[ ] No speculative features added
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

1. Read the source thread context and identify the behavior under review.
2. Call dev_review_get to load the durable Dev Review record before testing.
3. Start RRweb replay capture with dev_review_replay_start before interacting with the browser.
4. Use preview_* tools for actual browser testing. Exercise the product, do not rely on static assumptions.
5. Stop RRweb replay capture with dev_review_replay_stop after browser testing.
6. Update the Dev Review record with dev_review_update, including verdict, summary, checks, findings, questions, next steps, and evidence IDs.
7. Mark the review status passed, failed, or blocked. If no automation-capable preview is attached, complete the review as blocked with explicit evidence.

If no durable Dev Review record is linked, still perform the Browser Dev Review, capture concrete findings in the conversation, and report whether implementation completion should proceed.

If RRweb capture fails, keep testing when useful, record the replay failure, and complete the text review. If browser testing cannot begin, mark the review blocked instead of inventing evidence.
</collaboration_mode>`;

const IMPLEMENTATION_FIX_PROMPT = `<collaboration_mode># Implementation Workflow: Fix

Fix the Browser Dev Review or merge-gate failures in the orchestrator worktree. Do not ask the user questions. Make the smallest reliable change, run relevant validation, and report whether the run can continue.

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

const PRODUCT_GRILL_PROMPT = `<collaboration_mode># Product Grill: Intent Grill

Align with the user on product outcome and intent only. This is the workflow's single human gate. After you lock intent, all later planning, review, implementation, merge, browser review, and PR filing transitions are automatic.

Explore repository facts before asking. Use code, docs, tests, schemas, configuration, and existing vocabulary to answer questions yourself when possible. Ask exactly one product-alignment question at a time only when intent cannot be inferred. Every question must include a recommended answer and the reason for that recommendation.

Actively maintain durable product context while grilling:

1. Resolve the context structure before relying on domain terms. If a root CONTEXT-MAP.md exists, read it to find the right bounded context. If only a root CONTEXT.md exists, use it as the single context.
2. Create or update CONTEXT.md lazily only when the first domain term is resolved. CONTEXT.md is a glossary only: no implementation details, planning notes, TODOs, API specs, or architecture decisions. Use tight definitions, list rejected synonyms under _Avoid_, and include only project-specific domain concepts.
3. Create docs/adr/000N-slug.md lazily only when an ADR is warranted: the decision is hard to reverse, surprising without context, and the result of a real trade-off.
4. When multiple contexts exist, infer the target context from the topic; if unclear, ask. If existing context conflicts with the user's intent, ask which should become authoritative before locking intent.

Do not make implementation changes during the grill.

Before locking intent, finish any required CONTEXT.md glossary updates and ADR files. Finish only when the product intent is locked enough that the Planning Workflow sub-agent can create the PRD, planning issues, and issue review, and the Implementation Workflow sub-agent can proceed without further user questions.

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
    description: "Challenges the plan against repo language and constraints before PRD authoring.",
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
    id: WORKFLOW_PROMPT_IDS.planningPrdCodex,
    order: 2,
    workflow: "planning",
    role: "planning-thread",
    stage: "prd",
    title: "2. PRD",
    description: "Creates the durable PRD artifact from planning context and locked decisions.",
    promptText: PLANNING_PRD_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.planningIssuesCodex,
    order: 3,
    workflow: "planning",
    role: "planning-thread",
    stage: "issues",
    title: "3. Issues",
    description:
      "Decomposes the PRD into implementation-ready planning issues with dependencies and tests.",
    promptText: PLANNING_ISSUES_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.planningIssueReviewerCodex,
    order: 4,
    workflow: "planning",
    role: "planning-reviewer",
    stage: "issue-review",
    title: "4. Issues Review",
    description:
      "Reviews planning issues for dependency correctness, readiness, and PRD alignment.",
    promptText: PLANNING_REVIEW_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.implementationOrchestratorPlanningCodex,
    order: 1,
    workflow: "implementation",
    role: "implementation-orchestrator",
    stage: "orchestrator-start",
    title: "1. Orchestrator Start",
    description: "Plans a durable implementation orchestration run from a PRD.",
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
      "Implements planning issues with a red-green-refactor loop and focused validation.",
    promptText: IMPLEMENTATION_TDD_PROMPT,
    associatedDocs: [
      {
        id: "implementation.tdd.mocking",
        title: "When to Mock",
        path: "mocking.md",
        content: IMPLEMENTATION_TDD_MOCKING_ASSOCIATED_DOC_CONTENT,
      },
      {
        id: "implementation.tdd.refactoring",
        title: "Refactor Candidates",
        path: "refactoring.md",
        content: IMPLEMENTATION_TDD_REFACTORING_ASSOCIATED_DOC_CONTENT,
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
        id: "implementation.browser-dev-review.chrome-devtools-mcp",
        path: "chrome-devtools-mcp.md",
        title: "Chrome DevTools MCP",
        content: CHROME_DEVTOOLS_MCP_ASSOCIATED_DOC_CONTENT,
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
    description: "Fixes merge-gate or browser-review failures before rerunning validation.",
    promptText: IMPLEMENTATION_FIX_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.productGrillStageCodex,
    order: 1,
    workflow: "product",
    role: "planning-thread",
    stage: "grill",
    title: "Product Grill",
    description:
      "Asks product-intent questions, updates durable product context, and locks intent.",
    promptText: PRODUCT_GRILL_PROMPT,
    associatedDocs: [
      {
        id: "product.grill-stage.context-format",
        title: "CONTEXT.md Format",
        path: "CONTEXT-FORMAT.md",
        content: CONTEXT_FORMAT_ASSOCIATED_DOC_CONTENT,
      },
      {
        id: "product.grill-stage.adr-format",
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

export function normalizeWorkflowPromptId(id: string): string {
  return (
    LEGACY_WORKFLOW_PROMPT_ID_ALIASES[id as keyof typeof LEGACY_WORKFLOW_PROMPT_ID_ALIASES] ?? id
  );
}

export function resolveWorkflowPromptContract(id: string): WorkflowPromptContract {
  const normalizedId = normalizeWorkflowPromptId(id);
  const contract = WORKFLOW_PROMPT_REGISTRY.find((entry) => entry.id === normalizedId);
  if (contract === undefined) {
    throw new Error(`Unknown workflow prompt contract '${id}'`);
  }
  return cloneWorkflowPromptContract(contract);
}

export function isRegisteredWorkflowPromptId(id: string): boolean {
  const normalizedId = normalizeWorkflowPromptId(id);
  return WORKFLOW_PROMPT_REGISTRY.some((entry) => entry.id === normalizedId);
}

export function isBrowserDevReviewWorkflowPromptId(
  workflowPromptId: string | null | undefined,
): boolean {
  return (
    workflowPromptId !== null &&
    workflowPromptId !== undefined &&
    normalizeWorkflowPromptId(workflowPromptId) ===
      WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex
  );
}

export function isPreviewMcpWorkflowPromptId(workflowPromptId: string | null | undefined): boolean {
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
    return normalizeWorkflowPromptId(input.workflowPromptId);
  }
  switch (input.interactionMode) {
    case "planning-workflow":
      return WORKFLOW_PROMPT_IDS.planningGrillStageCodex;
    case "product-workflow":
      return WORKFLOW_PROMPT_IDS.productGrillStageCodex;
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
