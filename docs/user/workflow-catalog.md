# Workflows, skills, and docs

The Settings catalog separates workflow automation into three layers:

- **Workflows** are complete orchestration paths such as Fix, Fast Feature, Full Feature, Wayfinder, Planning, and Implementation.
- **Skills** are the focused instructions used for individual workflow steps, such as Spec authoring, TDD implementation, or Code Review.
- **Docs** are supporting references used by those skills, such as ADR, context, testing, and browser-QA formats.

All three catalogs are read-only and versioned with the T3 Code server. Project and user skills discovered by a provider are separate from these built-in workflow skills.

## Choosing a workflow

- **Fix** — a defect or small correction. Fastest path: plan, then build, no reviews.
- **Fast Feature** — a feature small enough to skip the Spec-and-tickets pipeline but big enough to deserve a worktree and reviews.
- **Full Feature** — the complete pipeline. One conversation up front; everything else is automatic.
- **Planning** — just the planning half: interview, Spec, tickets, ticket review. Pair it with Implementation when you want a checkpoint between the two.
- **Wayfinder** — the effort is too large or foggy to specify in one pass; chart the decisions first.
- **Implementation** — you already have a Spec and reviewed tickets; execute them.

Every product-routed workflow starts with a **product grill**. Before asking anything, the agent grounds itself in the codebase and existing product context, resolves discoverable facts, and answers what is already clear. It then asks only the product-alignment questions that remain, one at a time with a recommended answer — the problem, the outcome, the audience, how it should feel, success criteria, scope, and non-goals. Implementation, architecture, and testing questions are resolved later by the automated stages without asking you.

## What each workflow does

**Fix** — grill, then the same thread switches to the CLI's plan mode. The proposed plan launches one Build child thread on the same worktree and branch you started from.

**Fast Feature** — grill, then same-thread planning. The plan launches a Build child in a fresh worktree branched from your starting branch and starts its app dev stack in parallel. AppDevStack health and Browser Dev Review share up to ten QA cycles. Every failure gets a fresh TDD repair thread, and every browser check gets a fresh reviewer. Code Review then makes its own corrections, and the change request lands back in your starting branch. If QA exhausts all ten cycles, the workflow continues best-effort and flags that result in the change request.

**Full Feature** — the grill is the only human gate. Afterwards the full Planning workflow runs, then the full Implementation workflow in its own worktree branched from your selected branch, with the app dev stack created in parallel when absent.

**Planning** — Grill With Docs is a human-in-the-loop interview that also maintains your project's domain docs: glossary terms land in `CONTEXT.md` and durable decisions in ADRs as they crystallize. The Spec is then written as a durable artifact in the app — not a file in your repository — and appears in the Planning side panel. Tickets are drafted in the same thread, then reviewed in up to three cycles, each in its own sub-thread, with the reviewer editing tickets directly.

**Implementation** — loads the Spec, creates a worktree from your chosen branch, and starts the app dev stack alongside the implementation. Tickets are implemented dependency-aware by TDD workers, each in its own sub-thread and worktree — a ticket that depends on another branches from that ticket's branch. Worker branches are merged back, then AppDevStack health and Browser Dev Review run in one shared loop of up to ten cycles. A stack problem or a failed/blocked review gets a fresh TDD repair thread; the next browser review also gets a fresh thread. After the cap the run proceeds best-effort and flags the unresolved gate. Code Review is a single pass that commits its own corrections, and the change request is filed into the branch you started from.

**Wayfinder** — for efforts too large or uncertain to specify in one pass. Its durable Wayfinder Map appears above the Spec in the Planning side panel. Research, prototype, grilling, and task decisions are stored as normal Planning Tickets linked to the map, including their dependency edges. Its Grill With Docs step combines the interview and domain-modeling discipline while updating glossary and ADR documents as decisions crystallize. When the decision frontier is resolved, the map becomes the input to Spec authoring, and the flow continues through tickets, ticket review, and implementation.

## Skills and docs

Supporting docs are not placed in a skill's context automatically. The skill receives the available document names and loads a document only when it is relevant. This keeps routine workflow turns focused while preserving access to detailed guidance.

The built-in skills are closely based on [Matt Pocock's engineering skills](https://github.com/mattpocock/skills/tree/main/skills/engineering), adapted to T3 Code: specs and tickets are durable app artifacts instead of tracker issues, the product grill is the grilling skill restricted to product questions, prototypes are built full-fidelity on worktrees of the real application with app dev stacks instead of low-fidelity stand-ins, and Dev Review and the app dev stack are T3 additions. In Settings, each workflow step links to its skill, and each skill links to the docs it can load.
