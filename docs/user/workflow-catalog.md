# Workflows, skills, and docs

The Settings catalog separates workflow automation into three layers:

- **Workflows** are complete orchestration paths such as Fix, Fast Feature, Full Feature, Wayfinder, Planning, and Implementation.
- **Skills** are the focused instructions used for individual workflow steps, such as Spec authoring, TDD implementation, or Code Review.
- **Docs** are supporting references used by those skills, such as ADR, context, testing, and browser-QA formats.

All three catalogs are read-only and versioned with the T3 Code server. Project and user skills discovered by a provider are separate from these built-in workflow skills.

## Choosing a workflow

- **Fix** — a defect or small correction. Fastest path: plan, then build, no reviews.
- **Fast Feature** — a feature small enough to skip the Spec-and-tickets pipeline but big enough to deserve a worktree and reviews.
- **Full Feature** — the complete pipeline with one conversation: Product Grill, then automatic Engineering Grill, planning, and implementation.
- **Planning** — just the planning half: an interactive Engineering Grill, followed by automatic Spec, tickets, and ticket review. Pair it with Implementation when you want a checkpoint between the two.
- **Wayfinder** — the effort is too large or foggy to specify in one pass; chart the decisions first.
- **Implementation** — you already have a Spec and reviewed tickets; execute them.

Every product-routed workflow starts with a **Product Grill**. Before asking anything, the agent grounds itself in the codebase and existing product context, resolves discoverable facts, and answers what is already clear. It maps the remaining product decisions as a dependency tree, then asks the complete currently unblocked product-alignment frontier when that frontier contains one through seven questions — the problem, the outcome, the audience, how it should feel, success criteria, scope, and non-goals. Seven is the maximum for a round, not a target; smaller frontiers keep their natural size, while larger frontiers continue in stable order after the first seven answers. Your answers unlock the next round. Product Grill never asks implementation, architecture, or testing questions; Full Feature delegates those decisions to an automatic Engineering Grill, while Fix and Fast Feature resolve them during their lighter planning paths.

Interactive Product and Engineering Grills present questions as structured cards above the composer on web, desktop, and mobile. Choices stay in their natural order, and each option keeps a neutral impact or tradeoff description. A separate callout names the recommended option and explains why it is preferred without changing the option label or description. You can use the composer field on the card for a custom answer. The final “lock it in or keep grilling” confirmation uses one question in the same structured card.

## What each workflow does

**Fix** — grill, then the same thread switches to the CLI's plan mode. The proposed plan launches one Build child thread on the same worktree and branch you started from.

**Fast Feature** — grill, then same-thread planning. The plan launches a Build child in a fresh worktree branched from your starting branch and starts its app dev stack in parallel. AppDevStack probes and Browser Dev Reviews are separate from the global limit of ten fresh automated QA repair agents. Every failed gate gets a fresh TDD repair, and replacing a malformed, failed, blocked, or interrupted repair consumes another slot. Code Review then makes its own corrections, and the change request lands back in your starting branch. If QA exhausts all ten repairs, a clean validated HEAD continues best-effort and the change request carries a warning. A clean legacy HEAD missing validation is revalidated automatically; dirty or wrong-branch worktrees require human attention.

**Full Feature** — Product Grill is the only stage that asks you questions. Once you confirm what the product should do, the same thread enters an automatic Engineering Grill. The model grounds itself in the codebase, resolves the engineering and domain decision tree on its own without reopening product questions, and then continues automatically through Spec authoring, tickets, ticket review, and the full Implementation workflow.

**Planning** — Engineering Grill is the user-interactive stage. It works through the currently unblocked engineering-decision frontier in structured batches while maintaining your project's domain docs: glossary terms land in `CONTEXT.md` and durable decisions in ADRs as they crystallize. Once you confirm shared understanding, the rest is automatic: the Spec is written as a durable artifact in the app — not a file in your repository — tickets are drafted in the same thread, and ticket review runs for up to three cycles in reviewer sub-threads. A clean review finalizes the tickets without another approval prompt.

**Implementation** — loads the Spec, creates a worktree from your chosen branch, and starts the app dev stack alongside the implementation. Tickets are implemented dependency-aware by TDD workers, each in its own sub-thread and worktree — a ticket that depends on another branches from that ticket's branch. Worker branches are merged back, then AppDevStack probes and Browser Dev Reviews run without consuming the global ten-repair budget. A stack problem or failed/blocked review gets a fresh TDD repair; replacing a repair consumes another slot. After ten repairs, a clean merge-gate-validated HEAD proceeds through best-effort Code Review with the unresolved gate flagged. A clean, correct-branch legacy HEAD without a validation receipt reruns the merge gate first; dirty or wrong-branch worktrees require human attention. Code Review is a single pass that commits its own corrections, and the change request is filed into the branch you started from.

A Browser Dev Review's live browser tab is temporary. It closes when the review or workflow child reaches a terminal state. Screenshots, recordings, findings, checks, and the verdict remain available as durable Dev Review evidence after the tab closes.

**Wayfinder** — for efforts too large or uncertain to specify in one pass. Its durable Wayfinder Map appears above the Spec in the Planning side panel. Research, prototype, grilling, and task decisions are stored as normal Planning Tickets linked to the map, including their dependency edges. It uses the Engineering Grill's interview and domain-modeling discipline while updating glossary and ADR documents as decisions crystallize. When the decision frontier is resolved, the map becomes the input to Spec authoring, and the flow continues through tickets, ticket review, and implementation.

## Navigating workflow threads

On web and desktop, a workflow keeps one sidebar entry: its top-level thread. Planning, build, review, repair, and other workflow-created child threads do not appear as separate sidebar rows.

Open **Workflows** in the right panel to see every run and created child thread, including nested and completed work. Selecting a child opens its conversation while keeping the complete workflow overview open. Select the workflow title to return to the top-level conversation. Provider-native subagents remain in the separate **Agents** surface.

## Stopping a workflow

Right-click the top-level workflow thread on desktop or long-press it on a touch device, then choose **Delete**. Confirming the deletion cancels active work and permanently removes the workflow thread together with all of its child threads and conversation history.

## Skills and docs

Supporting docs are not placed in a skill's context automatically. The skill receives the available document names and loads a document only when it is relevant. This keeps routine workflow turns focused while preserving access to detailed guidance.

The built-in grills share one Grilling primitive. Product Grill adds only codebase grounding and product-question scope. Engineering Grill adds the complete domain-modeling discipline used by Planning; Full Feature applies an automatic adapter to that same composition after Product Grill locks the intent. The question presentation follows Matt Pocock's useful separation of options, recommendation, and rationale, while T3 intentionally retains dependency-frontier batching instead of adopting an exactly-one-question-at-a-time rule. The remaining skills are closely based on [Matt Pocock's engineering skills](https://github.com/mattpocock/skills/tree/main/skills/engineering), adapted to T3 Code: specs and tickets are durable app artifacts instead of tracker issues, prototypes are built full-fidelity on worktrees of the real application with app dev stacks instead of low-fidelity stand-ins, and Dev Review and the app dev stack are T3 additions. In Settings, each workflow step links to its skill, and each skill links to the docs it can load.

For Codex, fresh interactive grill threads use T3's own `workflow_request_user_input` dynamic tool. Provider threads created before that tool was registered temporarily fall back to native Plan transport and its three-question `request_user_input` limit. The visible Product or Planning workflow and its grill behavior do not become ordinary CLI Plan Mode. Full Feature's automatic Engineering Grill remains non-interactive and uses neither interactive transport.
