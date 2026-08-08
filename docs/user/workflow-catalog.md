# Workflows, skills, and docs

The Settings catalog separates workflow automation into three layers:

- **Workflows** are complete orchestration paths such as Fix, Fast Feature, Full Feature, Wayfinder, Planning, and Implementation.
- **Skills** are the focused instructions used for individual workflow steps, such as Spec authoring, TDD implementation, or Code Review.
- **Docs** are supporting references used by those skills, such as ADR, context, testing, and browser-QA formats.

All three catalogs are read-only and versioned with the T3 Code server. Project and user skills discovered by a provider are separate from these built-in workflow skills.

## Choosing a workflow

- **Fix** — a defect or small correction. Fastest path: plan, then build, no reviews.
- **Fast Feature** — a feature small enough to skip the Spec-and-tickets pipeline but big enough to deserve a worktree and reviews.
- **Full Feature** — the complete pipeline: Product Grill, Engineering Grill, then automated planning and implementation.
- **Planning** — just the planning half: interview, Spec, tickets, ticket review. Pair it with Implementation when you want a checkpoint between the two.
- **Wayfinder** — the effort is too large or foggy to specify in one pass; chart the decisions first.
- **Implementation** — you already have a Spec and reviewed tickets; execute them.

Every product-routed workflow starts with a **Product Grill**. Before asking anything, the agent grounds itself in the codebase and existing product context, resolves discoverable facts, and answers what is already clear. It maps the remaining product decisions as a dependency tree, then asks every currently unblocked product-alignment question in a numbered round with a recommended answer for each — the problem, the outcome, the audience, how it should feel, success criteria, scope, and non-goals. Your answers unlock the next round. Product Grill never asks implementation, architecture, or testing questions; Full Feature delegates those decisions to its following Engineering Grill, while Fix and Fast Feature resolve them during their lighter planning paths.

## What each workflow does

**Fix** — grill, then the same thread switches to the CLI's plan mode. The proposed plan launches one Build child thread on the same worktree and branch you started from.

**Fast Feature** — grill, then same-thread planning. The plan launches a Build child in a fresh worktree branched from your starting branch and starts its app dev stack in parallel. AppDevStack health and Browser Dev Review share up to ten QA cycles. Every failure gets a fresh TDD repair thread, and every browser check gets a fresh reviewer. Code Review then makes its own corrections, and the change request lands back in your starting branch. If QA exhausts all ten cycles, the workflow continues best-effort and flags that result in the change request.

**Full Feature** — Product Grill settles what the product should do, then the same thread enters Planning at Engineering Grill to settle engineering and domain decisions without reopening the product questions. Spec authoring, tickets, review, and the full Implementation workflow follow.

**Planning** — Engineering Grill works through the currently unblocked engineering-decision frontier in numbered rounds while maintaining your project's domain docs: glossary terms land in `CONTEXT.md` and durable decisions in ADRs as they crystallize. The Spec is then written as a durable artifact in the app — not a file in your repository — and appears in the Planning side panel. Tickets are drafted in the same thread, then reviewed in up to three cycles, each in its own sub-thread, with the reviewer editing tickets directly.

**Implementation** — loads the Spec, creates a worktree from your chosen branch, and starts the app dev stack alongside the implementation. Tickets are implemented dependency-aware by TDD workers, each in its own sub-thread and worktree — a ticket that depends on another branches from that ticket's branch. Worker branches are merged back, then AppDevStack health and Browser Dev Review run in one shared loop of up to ten cycles. A stack problem or a failed/blocked review gets a fresh TDD repair thread; the next browser review also gets a fresh thread. After the cap the run proceeds best-effort and flags the unresolved gate. Code Review is a single pass that commits its own corrections, and the change request is filed into the branch you started from.

**Wayfinder** — for efforts too large or uncertain to specify in one pass. Its durable Wayfinder Map appears above the Spec in the Planning side panel. Research, prototype, grilling, and task decisions are stored as normal Planning Tickets linked to the map, including their dependency edges. It uses the Engineering Grill's interview and domain-modeling discipline while updating glossary and ADR documents as decisions crystallize. When the decision frontier is resolved, the map becomes the input to Spec authoring, and the flow continues through tickets, ticket review, and implementation.

## Stopping a workflow

In Sidebar V2, right-click a workflow thread on desktop or long-press it on a touch device, then choose **Delete**. Confirming the deletion cancels active work and permanently removes the workflow thread together with all of its sub-threads and conversation history.

## Skills and docs

Supporting docs are not placed in a skill's context automatically. The skill receives the available document names and loads a document only when it is relevant. This keeps routine workflow turns focused while preserving access to detailed guidance.

The built-in grills share one Grilling primitive. Product Grill adds only codebase grounding and product-question scope. Engineering Grill adds the complete domain-modeling discipline used by Planning. The remaining skills are closely based on [Matt Pocock's engineering skills](https://github.com/mattpocock/skills/tree/main/skills/engineering), adapted to T3 Code: specs and tickets are durable app artifacts instead of tracker issues, prototypes are built full-fidelity on worktrees of the real application with app dev stacks instead of low-fidelity stand-ins, and Dev Review and the app dev stack are T3 additions. In Settings, each workflow step links to its skill, and each skill links to the docs it can load.
