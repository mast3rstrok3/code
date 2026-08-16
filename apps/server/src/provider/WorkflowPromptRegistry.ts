import type {
  ProviderInteractionMode,
  WorkflowCatalog,
  WorkflowDocContract,
  WorkflowPromptContract,
  WorkflowSkillContract,
} from "@t3tools/contracts";
import { isPlanningWorkflowInteractionMode } from "@t3tools/contracts";
import { WORKFLOW_PRESET_DEFINITIONS } from "@t3tools/shared/workflowPresets";

import { PREVIEW_BROWSER_QA_ASSOCIATED_DOC_CONTENT } from "./PreviewBrowserQa.ts";
import { WORKFLOW_SUBAGENT_INSTRUCTIONS_PROMPT } from "./WorkflowSubagentInstructions.ts";
import mattPocockEngineeringSkills from "./mattPocockEngineeringSkills.generated.json" with { type: "json" };

export const WORKFLOW_PROMPT_IDS = {
  workflowAgentCommunications: "workflow.agent-communications",
  sharedGrillingCodex: "shared.grilling.codex",
  planningGrillStageCodex: "planning.grill-stage.codex",
  planningAutomaticEngineeringGrillCodex: "planning.engineering-grill-automatic.codex",
  planningSpecCodex: "planning.spec.codex",
  planningTicketsCodex: "planning.tickets.codex",
  planningTicketReviewerCodex: "planning.ticket-reviewer.codex",
  implementationOrchestratorPlanningCodex: "implementation.orchestrator-planning.codex",
  implementationTddCodex: "implementation.tdd.codex",
  implementationMergeGateCodex: "implementation.merge-gate.codex",
  implementationBrowserAppReviewCodex: "implementation.browser-app-review.codex",
  implementationFixCodex: "implementation.fix.codex",
  implementationCodeReviewCodex: "implementation.code-review.codex",
  productFixCodex: "product.fix.codex",
  productFastFeatureCodex: "product.fast-feature.codex",
  productFullFeatureCodex: "product.full-feature.codex",
  planningDomainModelingCodex: "planning.domain-modeling.codex",
  planningPrototypeCodex: "planning.prototype.codex",
  planningWayfinderCodex: "planning.wayfinder.codex",
  planningResearchCodex: "planning.research.codex",
} as const;

const WORKFLOW_AGENT_COMMUNICATIONS_PROMPT = WORKFLOW_SUBAGENT_INSTRUCTIONS_PROMPT;

const APP_DEV_STACK_ASSOCIATED_DOC_CONTENT = `# AppDevStack

An AppDevStack is T3's Kubernetes-backed development environment for one workflow worktree: service pods mount that worktree at \`/app\`, while dependency paths such as \`node_modules\` can be separate pod volumes. Planning, Full Feature, and Fast Feature create their shared worktree before the first model turn, run its repository-declared dependency setup, and start AppDevStack immediately after that setup succeeds. The workflow thread itself starts immediately while this happens. Every later Planning, Build, Implementation, and App Review stage reuses that exact worktree, branch, and stack. Treat the injected stack status, id, and Feature URL as authoritative; do not use another worktree's runtime, start a competing dev server, or replace dependency paths in the shared worktree while its stack is active. Implementation TDD workers branch downward into child worktrees and may perform repository-declared setup needed for focused tests, but must not start a competing app server.`;

const APP_DEV_STACK_ASSOCIATED_DOC = {
  id: "app-dev-stack",
  title: "AppDevStack",
  path: "app-dev-stack.md",
  content: APP_DEV_STACK_ASSOCIATED_DOC_CONTENT,
} as const;

// Keep this shared block verbatim; workflow-specific behavior belongs in trailing adapters.
const GRILLING_BLUEPRINT = `---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled — the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Each question should be formatted like so:

\`\`\`
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
\`\`\`

Each round the user answers reshapes the tree — settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it — don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report — ask the rest of the frontier now. The _decisions_ are the user's — put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.`;

export const WORKFLOW_REQUEST_USER_INPUT_CODE_MODE_FORWARDING =
  "When Code Mode calls workflow_request_user_input, keep its returned answers visible to the model by passing the complete result to the outer text(result) helper, for example: const result = await tools.workflow_request_user_input(...); text(result). Dynamic tool results use contentItems, not result.content; never discard or selectively read the returned value.";

const STRUCTURED_GRILL_QUESTION_ADAPTER = `## T3 structured-question adapter

Use T3's \`workflow_request_user_input\` tool for every interview round and for the final shared-understanding confirmation. Do not duplicate or summarize structured questions, choices, or recommendations in Markdown before or after the tool call.

${WORKFLOW_REQUEST_USER_INPUT_CODE_MODE_FORWARDING}

Recompute the currently unblocked frontier before every round. When it contains one through seven questions, submit the entire frontier at its natural size. Seven is a maximum, never a target: do not aim for three, seven, or any other fixed batch size, and do not pad a round. If more than seven questions are independently ready, send the first seven in stable design-tree order and continue with the remainder after those answers resolve. Never put questions in the same call when one answer depends on another question in that call.

Treat every answer returned by \`workflow_request_user_input\` as settled. Never repeat its question or the previously answered frontier unless the user explicitly reopens or contradicts that decision. When a custom answer needs clarification, ask only the narrower unresolved clarification instead of replaying the original question batch.

Each question must have:

- A compact header.
- Two or three meaningful, mutually exclusive choices.
- A neutral, useful impact or tradeoff description for every choice.
- Exactly one separate recommendation object naming one option by its unchanged label and explaining why it is preferred.
- A custom-answer path through T3's existing composer input; do not add a synthetic custom choice.
- Choices in their natural A/B/C order. Never move the recommendation to the first position.

Put recommendation data only in the separate \`{ optionLabel, rationale }\` object. Do not append \`(Recommended)\` to an option label, do not replace or prefix an option description with \`Why that?\`, and do not reorder options to surface the recommendation.

When the frontier is empty, use one \`workflow_request_user_input\` question for the final shared-understanding confirmation. Offer two choices equivalent to \`Lock it in\` and \`Keep grilling\`, recommend \`Lock it in\` in the separate recommendation object, and follow every rule above. Only that structured response may lock or continue the grill.

Compatibility fallback: if and only if \`workflow_request_user_input\` is unavailable on this provider thread, use native \`request_user_input\` in chunks of at most three questions. Keep its option labels and descriptions neutral and unchanged. This fallback exists only for threads created before T3 registered the workflow tool.`;

const DOMAIN_MODELING_PROMPT = `<collaboration_mode># Domain Modeling

Actively build and sharpen the project's domain model as you design. This is the *active* discipline — challenging terms, inventing edge-case scenarios, and writing the glossary and decisions down the moment they crystallise. (Merely *reading* \`CONTEXT.md\` for vocabulary is not this skill — that's a one-line habit any skill can do. This skill is for when you're changing the model, not just consuming it.)

## File structure

Most repos have a single context:

\`\`\`
/
├── CONTEXT.md
├── docs/
│   └── adr/
│       ├── 0001-event-sourced-orders.md
│       └── 0002-postgres-for-write-model.md
└── src/
\`\`\`

If a \`CONTEXT-MAP.md\` exists at the root, the repo has multiple contexts. The map points to where each one lives:

\`\`\`
/
├── CONTEXT-MAP.md
├── docs/
│   └── adr/                          ← system-wide decisions
├── src/
│   ├── ordering/
│   │   ├── CONTEXT.md
│   │   └── docs/adr/                 ← context-specific decisions
│   └── billing/
│       ├── CONTEXT.md
│       └── docs/adr/
\`\`\`

Create files lazily — only when you have something to write. If no \`CONTEXT.md\` exists, create one when the first term is resolved. If no \`docs/adr/\` exists, create it when the first ADR is needed.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in \`CONTEXT.md\`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Update CONTEXT.md inline

When a term is resolved, update \`CONTEXT.md\` right there. Don't batch these up — capture them as they happen. Use the format in the CONTEXT.md Format document, loaded with workflow_doc_get immediately before writing.

\`CONTEXT.md\` should be totally devoid of implementation details. Do not treat \`CONTEXT.md\` as a spec, a scratch pad, or a repository for implementation decisions. It is a glossary and nothing else.

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. Use the format in the ADR Format document, loaded with workflow_doc_get immediately before writing.
</collaboration_mode>`;

const PROTOTYPE_PROMPT = `<collaboration_mode># Prototype

A prototype is **throwaway code that answers a question**. The question decides the shape.

## Full fidelity on the real application

T3 prototypes are built on the real application, not as low-fidelity stand-ins. Work in a dedicated prototype worktree and branch created from the current branch, and start the app dev stack for that worktree when none is running — the running app on the prototype branch *is* the prototype. Do not build toy terminal apps, mock pages, or sandboxes outside the repository: a branch of the real application answers the same question with more truth, and the app dev stack makes it just as easy to run and share.

Load \`app-dev-stack.md\` before creating or diagnosing the prototype stack.

## Pick a branch

Identify which question is being answered — from the user's prompt, the surrounding code, or by asking if the user is around:

- **"Does this logic / state model feel right?"** → the Logic Prototype document loaded with workflow_doc_get. Implement the candidate state model as a portable module in the real codebase and drive it through the application's real seams on the prototype branch.
- **"What should this look like?"** → the UI Prototype document loaded with workflow_doc_get. Generate several radically different UI variations on the real route, switchable via a URL search param and a floating bottom bar, viewed through the app dev stack.

The two branches produce very different artifacts — getting this wrong wastes the whole prototype. If the question is genuinely ambiguous and the user isn't reachable, default to whichever branch better matches the surrounding code (a backend module → logic; a page or component → UI) and state the assumption at the top of the prototype.

## Rules that apply to both

1. **Throwaway from day one, and clearly marked as such.** The prototype lives on its own worktree and branch, named so a casual reader can see it is a prototype (e.g. \`prototype/<question-slug>\`), and never merges to main. Within the branch, locate prototype code close to where it will actually be used and obey the project's existing conventions; don't invent a new top-level structure.
2. **One step to run.** The app dev stack for the prototype worktree is the run command. Start it when none is running and hand over the preview URL; the user must be able to open the prototype without thinking.
3. **No persistence changes by default.** The dev stack's state is isolated to the prototype worktree — keep it wipe-able. Don't run destructive migrations or touch shared state unless persistence is the thing the prototype is _checking_.
4. **Skip the polish.** No tests, no error handling beyond what makes the prototype _runnable_, no abstractions. The point is to learn something fast.
5. **Surface the state.** After every action (logic) or on every variant switch (UI), render or log the full relevant state so the user can see what changed.
6. **Capture it when done.** Fold any validated decision into the real code, then capture the prototype itself as a **primary source**: keep it committed on the prototype branch, out of main, and leave a context pointer to that branch on the implementation issue. Capture the answer too — the verdict and the question it settled — in the issue or a commit. The main branch keeps only the validated decision.

## T3 workflow adapter

There is no external issue tracker. The "implementation issue" that captures the answer is T3's durable planning record: report the verdict, the question it settled, and the prototype-branch pointer in your final workflow-subagent-result so the parent thread can store them on the relevant decision ticket or Spec.

These rules override upstream issue-tracker mechanics and upstream's low-fidelity prototype shapes (standalone terminal apps, isolated throwaway pages): T3 prototypes full-fidelity on worktrees of the real application with app dev stacks. The question-first discipline and capture rules remain authoritative.
</collaboration_mode>`;

const PROTOTYPE_LOGIC_DOC_CONTENT = `# Logic Prototype

Drive a candidate state model through the real application by hand. Use this when the question is about **business logic, state transitions, or data shape** — the kind of thing that looks reasonable on paper but only feels wrong once you push it through real cases.

## When this is the right shape

- "I'm not sure if this state machine handles the edge case where X then Y."
- "Does this data model actually let me represent the case where..."
- "I want to feel out what the API should look like before writing it."
- Anything where the user wants to **press buttons and watch state change**.

If the question is "what should this look like" — wrong branch. Use the UI Prototype document.

## Process

### 1. State the question

Before writing code, write down what state model and what question you're prototyping. One paragraph, in a comment at the top of the module. A logic prototype that answers the wrong question is pure waste — make the question explicit so it can be checked later, whether the user is watching now or returning to it AFK.

### 2. Work on the prototype branch

The prototype lives in the dedicated prototype worktree and branch of the real application. Use the host project's language, tooling, and conventions — never add a new package manager or runtime for a prototype.

### 3. Isolate the logic in a portable module

Put the actual logic — the bit that's answering the question — behind a small, pure interface that can stay in place when the prototype graduates. The wiring around it is throwaway; the logic module shouldn't be.

The right shape depends on the question:

- **A pure reducer** — \`(state, action) => state\`. Good when actions are discrete events and state is a single value.
- **A state machine** — explicit states and transitions. Good when "which actions are even legal right now" is part of the question.
- **A small set of pure functions** over a plain data type. Good when there's no implicit current state — just transformations.
- **A class or module with a clear method surface** when the logic genuinely owns ongoing internal state.

Pick whichever shape best fits the question being asked, *not* whichever is easiest to wire up. Keep it pure: no I/O, no rendering, no \`console.log\` for control flow. The application wiring imports it and calls into it; nothing flows the other direction.

This is what makes the prototype useful past its own lifetime: when the question's been answered, the validated reducer / machine / function set can be lifted into the real module on its own.

### 4. Wire it into the real application

Mount the module at the real seam it would eventually serve on the prototype branch — the actual route, command handler, reducer slot, or service the real feature would use. Start the app dev stack for the prototype worktree when none is running, and drive the model through the running application.

Surface the full relevant state after every action so each transition is visible: a debug panel on the affected page, structured logs in the dev-stack console, or the app's existing state inspector — whichever the project already supports. The user should always see one stable, current view of the state, never have to reconstruct it from scattered output.

When the logic genuinely has no reachable surface in the app yet, add the smallest driver the repository already supports — a dev-only route, a scratch command, a focused script registered with the project's task runner — on the prototype branch. The driver is throwaway; the portable module is not. Do not build a standalone toy app outside the application to host the logic.

### 5. Make it reachable in one step

The app dev stack is the run command. Hand over the preview URL and say exactly where to look — the route, the panel, the log stream. If a script driver was needed instead, register it with the project's existing task runner so one command starts it.

### 6. Hand it over

The user drives it themselves; the interesting moments are when they say "wait, that shouldn't be possible" or "huh, I assumed X would be different" — those are the bugs in the _idea_, which is the whole point. If they want new actions added, add them. Prototypes evolve.

### 7. Capture the answer and the prototype

Once the prototype has answered its question, capture the answer, then capture the prototype the way the skill describes. The logic-specific mapping: the validated reducer / machine / function set lifts into the real module (the decision, absorbed); the throwaway wiring and drivers stay on the prototype branch that keeps the prototype as a primary source.

## Anti-patterns

- **Don't add tests.** A prototype that needs tests is no longer a prototype.
- **Don't touch shared or production state.** The dev stack's state is isolated to the prototype worktree — keep it wipe-able. Persistence only becomes real when persistence is the question.
- **Don't generalise.** No "what if we wanted to support X later." The prototype answers one question.
- **Don't blur the logic and the wiring together.** If the reducer / state machine references rendering, transport, or logging concerns, it's no longer portable. Keep the application wiring as a thin shell over a pure module.
- **Don't ship the prototype wiring into production.** The debug panels, scratch drivers, and dev-only routes were written under prototype constraints. The logic module behind them is the bit worth keeping.
- **Don't downgrade to a toy.** A standalone terminal app or sandbox outside the repository answers a paper version of the question; the real application on the prototype branch answers the real one.`;

const PROTOTYPE_UI_DOC_CONTENT = `# UI Prototype

Generate **several radically different UI variations** on a single route of the real application, switchable from a floating bottom bar. The variants live on the prototype branch and are viewed through the app dev stack for the prototype worktree — real header, real data, real density. The user flips between variants in the browser, picks one (or steals bits from each), then throws the rest away.

If the question is about logic/state rather than what something looks like — wrong branch. Use the Logic Prototype document.

## When this is the right shape

- "What should this page look like?"
- "I want to see a few options for this dashboard before committing."
- "Try a different layout for the settings screen."
- Any time the user would otherwise spend a day picking between three vague mockups in their head.

## Two sub-shapes — strongly prefer sub-shape A

A UI prototype is much easier to judge when it's **butting up against the rest of the app** — real header, real sidebar, real data, real density. A throwaway route on its own is a vacuum: every variant looks fine in isolation. Default to sub-shape A whenever there's a plausible existing page to host the variants. Only reach for sub-shape B if the prototype genuinely has no nearby home.

### Sub-shape A — adjustment to an existing page (preferred)

The route already exists. Variants are rendered **on the same route**, gated by a \`?variant=\` URL search param. The existing data fetching, params, and auth all stay — only the rendering swaps. This is the default; pick it unless there's a specific reason not to.

If the prototype is for something that doesn't yet have a page but *would naturally live inside one* (a new section of the dashboard, a new card on the settings screen, a new step in an existing flow) — that's still sub-shape A. Mount the variants inside the host page.

### Sub-shape B — a new page (last resort)

Only use this when the thing being prototyped genuinely has no existing page to live inside — e.g. an entirely new top-level surface, or a flow that can't be embedded anywhere sensible.

Create a **throwaway route** following whatever routing convention the project already uses — don't invent a new top-level structure. Name it so it's obviously a prototype (e.g. include the word \`prototype\` in the path or filename). Same \`?variant=\` pattern.

Before committing to sub-shape B, sanity-check: is there really no existing page this could be embedded in? An empty route hides design problems that a populated one would expose.

In both sub-shapes the floating bottom bar is identical.

## Process

### 1. State the question and pick N

Default to **3 variants**. More than 5 stops being radically different and starts being noise — cap there.

Write down the plan in one line, in the prototype's location or a top-of-file comment:

> "Three variants of the settings page, switchable via \`?variant=\`, on the existing \`/settings\` route."

This works whether the user is here to push back or not.

### 2. Generate radically different variants

Draft each variant. Hold each one to:

- The page's purpose and the data it has access to.
- The project's component library / styling system (TailwindCSS, shadcn, MUI, plain CSS, whatever).
- A clear exported component name, e.g. \`VariantA\`, \`VariantB\`, \`VariantC\`.

Variants must be **structurally different** — different layout, different information hierarchy, different primary affordance, not just different colours. Three slightly-tweaked card grids isn't a UI prototype, it's wallpaper. If two drafts come out too similar, redo one with explicit "do not use a card grid" guidance.

### 3. Wire them together

Create a single switcher component on the route:

\`\`\`tsx
// pseudo-code — adapt to the project's framework
const variant = searchParams.get('variant') ?? 'A';
return (
  <>
    {variant === 'A' && <VariantA {...data} />}
    {variant === 'B' && <VariantB {...data} />}
    {variant === 'C' && <VariantC {...data} />}
    <PrototypeSwitcher variants={['A','B','C']} current={variant} />
  </>
);
\`\`\`

For sub-shape A (existing page): keep all the existing data fetching above the switcher; only the rendered subtree changes per variant.

For sub-shape B (new page): the throwaway route under \`/prototype/<name>\` mounts the same switcher.

### 4. Build the floating switcher

A small fixed-position bar at the bottom-centre of the screen with three pieces:

- **Left arrow** — cycles to the previous variant (wraps around).
- **Variant label** — shows the current variant key and, if the variant exports a name, that name too. e.g. \`B — Sidebar layout\`.
- **Right arrow** — cycles forward (wraps around).

Behaviour:

- Clicking an arrow updates the URL search param (use the framework's router — \`router.replace\` on Next, \`navigate\` on React Router, etc) so the variant is shareable and reload-stable.
- Keyboard: \`←\` and \`→\` arrow keys also cycle. Don't intercept arrow keys when an \`<input>\`, \`<textarea>\`, or \`[contenteditable]\` is focused.
- Visually distinct from the page (e.g. high-contrast pill, subtle shadow) so it's obviously not part of the design being evaluated.
- Hidden in production builds — gate on \`process.env.NODE_ENV !== 'production'\` or an equivalent check, so a stray prototype merge can't ship the bar to users.

Put the switcher in a single shared component so both sub-shapes can reuse it. Locate it wherever shared UI lives in the project.

### 5. Hand it over

Start the app dev stack for the prototype worktree when none is running, and surface the preview URL (and the \`?variant=\` keys). The user will flip through whenever they get to it. The interesting feedback is usually **"I want the header from B with the sidebar from C"** — that's the actual design they want.

### 6. Capture the answer and clean up

Once a variant has won, capture the answer — which variant and why — then capture the prototype the way the skill describes. Fold the winner into the real code and leave the rest on the prototype branch, not in main:

- **Sub-shape A** — fold the winner into the existing page; drop the losing variants and the switcher from main.
- **Sub-shape B** — promote the winning variant to a real route; drop the throwaway route and the switcher from main.

The full set of variants is the primary source, so it stays on the prototype branch, not the bin — variant components and the switcher left in the main branch rot fast and confuse the next reader.

## Anti-patterns

- **Variants that differ only in colour or copy.** That's a tweak, not a prototype. Real variants disagree about structure.
- **Sharing too much code between variants.** A shared \`<Header>\` is fine; a shared \`<Layout>\` defeats the point. Each variant should be free to throw out the layout.
- **Wiring variants to real mutations.** Read-only prototypes are fine. If a variant needs to mutate, point it at a stub — the question is "what should this look like", not "does the backend work".
- **Promoting the prototype directly to production.** The variant code was written under prototype constraints (no tests, minimal error handling). Rewrite it properly when you fold it in.`;

const WAYFINDER_PROMPT = `<collaboration_mode>A loose idea has arrived — too big for one agent session, and wrapped in fog: the way from here to the **destination** isn't visible yet. Wayfinding is about finding that way, not charging at the destination. This skill charts the way as a **shared map** on the repo's issue tracker, then works its **decision tickets** — questions whose resolution is a decision, not slices of a build to execute — one at a time until the route is clear.

The destination varies per effort, and naming it is the first act of charting — it shapes every ticket. It might be a spec to hand off and iterate on, a decision to lock before planning starts, or a change made in place like a data-structure migration. The map is domain-agnostic — engineering work, course content, whatever fits the shape.

## Plan, don't do

Wayfinder is **planning** by default: each ticket resolves a decision, and the map is done when the way is clear — nothing left to decide before someone goes and does the thing. The pull to just do the work is usually the signal you've reached the edge of the map and it's time to hand off. An effort can override this in its **Notes** — carrying execution into the map itself — but absent that, produce decisions, not deliverables.

## Refer by name

Every map and ticket is an issue, so it has a **name** — its title. In everything the human reads — narration, the map's Decisions-so-far — refer to it by that name, never by a bare id, number, or slug. A wall of \`#42, #43, #44\` is illegible; names read at a glance. The id and URL don't vanish — a name wraps its link — but they ride *inside* the name, never stand in for it.

## The Map

The map is a single issue on this repo's issue tracker, labelled \`wayfinder:map\` — the canonical artifact. Its tickets are child issues of the map.

The map is an **index**, not a store. It lists the decisions made and points at the tickets that hold their detail; a decision lives in exactly one place — its ticket — so the map never restates it, only gists it and links.

**Where the map, its child tickets, blocking, and frontier queries physically live is tracker-specific.** The issue tracker should have been provided to you — run \`/setup-matt-pocock-skills\` if not. Consult the tracker doc's "Wayfinding operations" section for how _this_ repo expresses them. If no tracker has been provided, default to the local-markdown tracker.

### The map body

The whole map at low resolution, loaded once per session. Open tickets are **not** listed — they are open child issues, found by query.

\`\`\`markdown
## Destination

<what reaching the end of this map looks like — the spec, decision, or change this effort is finding its way to. One or two lines; every session orients to it before choosing a ticket.>

## Notes

<domain; skills every session should consult; standing preferences for this effort>

## Decisions so far

<!-- the index — one line per closed ticket: enough to judge relevance, then zoom the link for the detail the ticket holds -->

- [<closed ticket title>](link) — <one-line gist of the answer>

## Not yet specified

<!-- see "Fog of war": in-scope fog you can't ticket yet; graduates as the frontier advances -->

## Out of scope

<!-- see "Out of scope": work ruled beyond the destination; closed, never graduates -->
\`\`\`

### Tickets

Each ticket is a **child issue** of the map; the tracker's issue id is its identity. Its body is the question, sized to one 100K token agent session:

\`\`\`markdown
## Question

<the decision or investigation this ticket resolves>
\`\`\`

Each ticket carries a \`wayfinder:<type>\` label — one of \`research\`, \`prototype\`, \`grilling\`, \`task\` (see [Ticket Types](#ticket-types)).

A session **claims** a ticket by assigning it to the dev driving the map, **first**, before any work, so concurrent sessions skip it. That assignee _is_ the claim: an open, unassigned ticket is unclaimed.

Blocking uses the tracker's **native** dependency relationship — essential because it renders the frontier _visually_ in the tracker's own UI, so the human sees what's takeable without opening the map. Only a tracker that lacks native blocking falls back to a body convention. A ticket is **unblocked** when every ticket blocking it is closed; the **frontier** is the open, unblocked, unclaimed children — the edge of the known.

The answer isn't part of the body — it's recorded on resolution (see [Work through the map](#work-through-the-map)). Assets created while resolving a ticket are linked from the issue, not pasted in.

## Ticket Types

Every ticket is either **HITL** — human in the loop, worked *with* a human who speaks for themselves — or **AFK**, driven by the agent alone. A HITL ticket only resolves through that live exchange; the agent never stands in for the human's side of it (a grilling agent that answers its own questions has broken this).

- **Research** (AFK): Reading documentation, third-party APIs, or local resources like knowledge bases to surface a fact a decision waits on. Resolved by a \`/research\` **subagent**. Use when knowledge outside the current working directory is required.
- **Prototype** (HITL): Raise the fidelity of the discussion by making a cheap, rough, concrete artifact to react to — an outline, a rough take, a stub, or UI/logic code via the /prototype skill. Links the prototype as an asset. Use when "how should it look" or "how should it behave" is the key question.
- **Grilling** (HITL): Conversation via the /grilling and /domain-modeling skills, one question at a time. The default case.
- **Task** (HITL or AFK): Manual work that must happen before a *decision* can be made — nothing to decide, prototype, or research, but the discussion is blocked until it's done. Signing up for a service so its API can be judged, provisioning access, moving data so its shape can be seen. This is the one type that *does* rather than decides — and it earns its place by unblocking a decision, not by delivering the destination. The agent drives it alone where it can (AFK); otherwise it hands the human a precise checklist (HITL). Resolved when the work is done; the answer records what was done and any resulting facts (credentials location, new URLs, row counts) later tickets depend on.

## Fog of war

The map is _deliberately_ incomplete: don't chart what you can't yet see. Beyond the live tickets lies the **fog of war** — the dim view of decisions and investigations you can tell are coming but can't yet pin down, because they hang on questions still open. Resolving a ticket clears the fog ahead of it, graduating whatever's now specifiable into fresh tickets — one at a time, until the way to the destination is clear and no tickets remain.

The map's **Not yet specified** section is where that dim view is written down: the suspected question, the area to revisit later. It's the undiscovered frontier _toward_ the destination — everything here is in scope, just not sharp enough to ticket. Write as loosely or as fully as the view allows; it doubles as a signpost for collaborators reading where the effort is headed.

**Fog or ticket?** The test is whether you can state the question precisely now — _not_ whether you can answer it now.

- **Ticket when** the question is already sharp — even if it's blocked and you can't act on it yet.
- **Not yet specified when** you can't yet phrase it that sharply. Don't pre-slice the fog into ticket-sized pieces: it's coarser than a ticket, and one patch may graduate into several tickets, or none, once the frontier reaches it.

**Not yet specified** excludes what's already decided (Decisions so far), what's already a live ticket, and what's out of scope (the next section).

## Out of scope

Fog only ever gathers _toward_ the destination. The destination fixes the scope, so work beyond it is **out of scope** — it isn't fog, and it doesn't belong in **Not yet specified**. It gets its own **Out of scope** section on the map: work you've consciously ruled out of _this_ effort. Scope, not sharpness, lands it here.

Out-of-scope work never graduates — the frontier stops at the destination — so it returns only if the destination is redrawn, and then as a fresh effort, not a resumption.

Ruling something out of scope is a scoping act, not a step on the route. When a ticket that already exists turns out to sit past the destination — mis-scoped in while charting, or exposed by a resolution — **close it** (a closed ticket is unambiguously off the frontier) and leave one line in the **Out of scope** section: the gist plus why it's out of scope, linking the closed ticket. It stays out of **Decisions so far**, which records the route actually walked — a scope boundary isn't a step on it.

## Invocation

Two modes. Either way, **never resolve more than one ticket per session** — with the exception of research tickets.

### Chart the map

User invokes with a loose idea.

1. **Name the destination.** Run a \`/grilling\` and \`/domain-modeling\` session to pin down what this map is finding its way to — the spec, decision, or change. The destination fixes the scope, so it's settled first.
2. **Map the frontier.** Grill again, **breadth-first** this time: fan out across the whole space rather than deep on any one thread, surfacing the open decisions and the first steps takeable now. **If this surfaces no fog** — the way to the destination is already clear, the whole journey small enough for one session — you don't need a map. Stop and ask the user how they'd like to proceed.
3. **Create the map** (label \`wayfinder:map\`): Destination and Notes filled in, Decisions-so-far empty, the fog sketched into **Not yet specified**.
4. **Create the tickets you can specify now** as child issues of the map — then wire blocking edges in a **second pass** (issues need ids before they can reference each other). Wiring sorts them into the frontier and the blocked; everything you can't yet specify stays in the fog — the **Not yet specified** section.
5. **Fire the research subagents.** For each \`research\` ticket you just created, spin up a \`/research\` subagent to resolve it in parallel, capturing its findings on a throwaway \`research/<name>\` branch with a context pointer from the ticket.
6. Stop — charting is one session's work; it hand-resolves nothing.

### Work through the map

User invokes with a map (URL or number). A ticket is **optional** — without one, you pick the next decision, not the user.

1. Load the **map** — the low-res view, not every ticket body.
2. Choose the ticket. If the user named one, use it. Otherwise take the first frontier ticket in order. **Claim it**: assign it to yourself before any work.
3. Resolve it — **zoom as needed**: fetch the full body of any related or closed ticket on demand; invoke the skills the \`## Notes\` block names. If in doubt, use \`/grilling\` and \`/domain-modeling\`.
4. Record the resolution: post the answer as a **resolution comment**, **close** the issue, and **append a context pointer** to the map's Decisions-so-far.
5. Add newly-surfaced tickets (create-then-wire); graduate any fog the answer has made specifiable, clearing each graduated patch from **Not yet specified** so it lives only as its new ticket. If the answer reveals a ticket — this one or another — sits beyond the destination, **rule it out of scope** rather than resolving it on the route. If the decision invalidates other parts of the map, update or delete those tickets.

The user may run unblocked tickets in parallel, so expect other sessions to be editing the tracker concurrently.

## T3 workflow adapter

T3 replaces the upstream issue-tracker storage operations while preserving the map and ticket semantics:

- The durable Wayfinder Map is stored in the Planning side panel above Spec, not as an issue.
- Decision tickets use T3 Planning Tickets. The map id is their specId, and native ticket dependencies represent blocking edges.
- Use the Engineering Grill wherever the upstream text invokes /grilling plus /domain-modeling.
- Load the canonical map with workflow_wayfinder_map_get. Use only workflow-subagent-create and workflow-subagent-result for focused child handoffs; do not use conversational agent messaging.
- A map write ends with one wayfinder-map-artifact JSON directive containing title and summaryMarkdown. A decision-ticket write uses planning-tickets-artifact with the map id as specId.

These storage and handoff mappings override only the upstream tracker-specific mechanics; its destination, map, frontier, fog, ticket-type, claiming, one-ticket-per-session, and resolution rules remain authoritative.
</collaboration_mode>`;

const RESEARCH_PROMPT = `<collaboration_mode>Spin up a **background agent** to do the research, so you keep working while it reads.

Its job:

1. Investigate the question against **primary sources** — official docs, source code, specs, first-party APIs — not a secondary write-up of them. Follow every claim back to the source that owns it.
2. Write the findings to a single Markdown file, citing each claim's source.
3. Save it where the repo already keeps such notes; match the existing convention, and if there is none, put it somewhere sensible and say where.

## T3 workflow adapter

When this prompt is already running in a focused Research child thread, the current thread is the upstream background agent: do not create another nested researcher. Return the result through the small workflow-subagent-result handoff API. Do not use conversational agent messaging.
</collaboration_mode>`;

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

- [Ordering](./src/ordering/CONTEXT.md) — receives and tracks customer orders
- [Billing](./src/billing/CONTEXT.md) — generates invoices and processes payments
- [Fulfillment](./src/fulfillment/CONTEXT.md) — manages warehouse picking and shipping

## Relationships

- **Ordering → Fulfillment**: Ordering emits \`OrderPlaced\` events; Fulfillment consumes them to start picking
- **Fulfillment → Billing**: Fulfillment emits \`ShipmentDispatched\` events; Billing consumes them to generate invoices
- **Ordering ↔ Billing**: Shared types for \`CustomerId\` and \`Money\`
\`\`\`

The skill infers which structure applies:

- If \`CONTEXT-MAP.md\` exists, read it to find contexts
- If only a root \`CONTEXT.md\` exists, single context
- If neither exists, create a root \`CONTEXT.md\` lazily when the first term is resolved

When multiple contexts exist, infer which one the current topic relates to. If unclear, ask.`;

const buildEngineeringGrillPrompt = (input: {
  readonly automatic: boolean;
}) => `<collaboration_mode># Engineering Grill${input.automatic ? " (Automatic)" : ""}

${GRILLING_BLUEPRINT}

${input.automatic ? "" : STRUCTURED_GRILL_QUESTION_ADAPTER}

# Domain Modeling

Actively build and sharpen the project's domain model as you design. This is the *active* discipline — challenging terms, inventing edge-case scenarios, and writing the glossary and decisions down the moment they crystallise. (Merely *reading* \`CONTEXT.md\` for vocabulary is not this skill — that's a one-line habit any skill can do. This skill is for when you're changing the model, not just consuming it.)

## File structure

Most repos have a single context:

\`\`\`
/
├── CONTEXT.md
├── docs/
│   └── adr/
│       ├── 0001-event-sourced-orders.md
│       └── 0002-postgres-for-write-model.md
└── src/
\`\`\`

If a \`CONTEXT-MAP.md\` exists at the root, the repo has multiple contexts. The map points to where each one lives:

\`\`\`
/
├── CONTEXT-MAP.md
├── docs/
│   └── adr/                          ← system-wide decisions
├── src/
│   ├── ordering/
│   │   ├── CONTEXT.md
│   │   └── docs/adr/                 ← context-specific decisions
│   └── billing/
│       ├── CONTEXT.md
│       └── docs/adr/
\`\`\`

Create files lazily — only when you have something to write. If no \`CONTEXT.md\` exists, create one when the first term is resolved. If no \`docs/adr/\` exists, create it when the first ADR is needed.

## During the session

### Challenge against the glossary

When the user uses a term that conflicts with the existing language in \`CONTEXT.md\`, call it out immediately. "Your glossary defines 'cancellation' as X, but you seem to mean Y — which is it?"

### Sharpen fuzzy language

When the user uses vague or overloaded terms, propose a precise canonical term. "You're saying 'account' — do you mean the Customer or the User? Those are different things."

### Discuss concrete scenarios

When domain relationships are being discussed, stress-test them with specific scenarios. Invent scenarios that probe edge cases and force the user to be precise about the boundaries between concepts.

### Cross-reference with code

When the user states how something works, check whether the code agrees. If you find a contradiction, surface it: "Your code cancels entire Orders, but you just said partial cancellation is possible — which is right?"

### Update CONTEXT.md inline

When a term is resolved, update \`CONTEXT.md\` right there. Don't batch these up — capture them as they happen. Use the format in [CONTEXT-FORMAT.md](./CONTEXT-FORMAT.md).

\`CONTEXT.md\` should be totally devoid of implementation details. Do not treat \`CONTEXT.md\` as a spec, a scratch pad, or a repository for implementation decisions. It is a glossary and nothing else.

### Offer ADRs sparingly

Only offer to create an ADR when all three are true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will wonder "why did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If any of the three is missing, skip the ADR. Use the format in [ADR-FORMAT.md](./ADR-FORMAT.md).

## T3 workflow adapter

The Engineering Grill is represented above by the complete Grilling and Domain Modeling instructions. Load CONTEXT-FORMAT.md or ADR-FORMAT.md with workflow_doc_get only immediately before writing that artifact.

This Planning workflow already owns the current worktree and AppDevStack. Treat them as the shared runtime workspace for every later Planning and Implementation stage. The stack starts programmatically as soon as repository-declared workspace setup succeeds; do not start a competing development server or use another worktree's stack.

Planning artifact writes during this stage are limited to glossary and ADR updates. Do not make implementation changes. Finish only when the goal, audience, success criteria, scope, non-goals, terminology, decisions, risks, edge cases, failure modes, and acceptance criteria are clear enough for Spec authoring.

Updating domain documentation as decisions crystallize is the only exception to the Grilling blueprint's instruction not to act before confirmation. The frontier-round mechanics remain authoritative.

${
  input.automatic
    ? `## Full Feature automation adapter

The Product Grill is the Full Feature workflow's only user gate. Treat its locked product intent as the authoritative user decision set.

Do not ask the user questions, emit interview rounds, wait for answers, or request confirmation. Walk the engineering and domain design tree internally: resolve discoverable facts from the codebase and project context, choose the recommended answer for every engineering decision, recompute the frontier until it is empty, and update domain documentation as decisions crystallize. Do not reopen product decisions.

Finish in this turn with exactly one fenced JSON block containing { "type": "planning-grill-complete" }. Do not write the Spec in this stage.

This automation adapter overrides the Grilling blueprint's user-question, user-decision, waiting, and confirmation mechanics. The design tree, dependency frontier, fact-finding, domain-modeling, and completeness requirements remain authoritative.`
    : `After the user explicitly confirms shared understanding, end with exactly one fenced JSON block containing { "type": "planning-grill-complete" }. Do not write the Spec in this stage.`
}
</collaboration_mode>`;

const ENGINEERING_GRILL_PROMPT = buildEngineeringGrillPrompt({ automatic: false });
const AUTOMATIC_ENGINEERING_GRILL_PROMPT = buildEngineeringGrillPrompt({ automatic: true });

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

## Domain model maintenance

Maintain the project's domain model as part of Spec authoring. When the Spec resolves terminology, capture it in the CONTEXT.md glossary (format in CONTEXT-FORMAT.md): tight definitions, rejected synonyms under _Avoid_, project-specific domain concepts only, no implementation details. Record an ADR in docs/adr/ (format in ADR-FORMAT.md) only when a decision is hard to reverse, surprising without context, and the result of a real trade-off. Create these files lazily — only when you have something to write.

## T3 workflow adapter

The Spec is a durable artifact in T3's application state, not a repository file or tracker issue — a deliberate deviation from upstream. Do not write the Spec to the repository, \`.scratch/\` files, or an external tracker, and ignore \`/setup-matt-pocock-skills\` and triage labels. Publish the Spec through the planning-spec-artifact directive requested by the stage launch prompt, finishing with exactly one fenced JSON block.

When a Wayfinder Map exists for this workflow, load it with workflow_wayfinder_map_get and treat the map's linked decisions as the conversation context to synthesize from.

The Engineering Grill is Planning's only user-interactive stage. Do not ask the user to confirm seams during Spec authoring. Resolve seams, glossary updates, and ADR updates yourself from the confirmed Engineering Grill, locked Product Grill intent when present, and the codebase.

These rules override upstream tracker publication and interview mechanics; the spec template and synthesis process remain authoritative.
</collaboration_mode>`;

const PLANNING_TICKETS_PROMPT = `<collaboration_mode># To Tickets

Break a plan, spec, or conversation into a set of **tickets** — tracer-bullet vertical slices, each declaring the tickets that **block** it.

The issue tracker and triage label vocabulary should have been provided to you — run \`/setup-matt-pocock-skills\` if not.

## Process

### 1. Gather context

Work from whatever is already in the conversation context. If the user passes a reference (a spec path, an issue number or URL) as an argument, fetch it and read its full body and comments.

### 2. Explore the codebase (optional)

If you have not already explored the codebase, do so to understand the current state of the code. Ticket titles and descriptions should use the project's domain glossary vocabulary, and respect ADRs in the area you're touching.

Look for opportunities to prefactor the code to make the implementation easier. "Make the change easy, then make the easy change."

### 3. Draft vertical slices

Break the work into **tracer bullet** tickets.

<vertical-slice-rules>

- Each slice cuts a narrow but COMPLETE path through every layer (schema, API, UI, tests) — vertical, NOT a horizontal slice of one layer
- A completed slice is demoable or verifiable on its own
- Each slice is sized to fit in a single fresh context window
- Any prefactoring should be done first

</vertical-slice-rules>

Give each ticket its **blocking edges** — the other tickets that must complete before it can start. A ticket with no blockers can start immediately.

Dependencies represent actual compile-time, data, or behavioral prerequisites, never preferred implementation order. Keep the dependency frontier as wide as correctness allows. When several slices would otherwise edit the same central registry or service file, prefer an early extension-point/foundation ticket, parallel feature-module tickets with isolated tests, and one small final assembly ticket. If a long serial chain remains, justify every edge in the dependent ticket body with the concrete prerequisite it represents.

**Wide refactors are the exception to vertical slicing.** A **wide refactor** is one mechanical change — rename a column, retype a shared symbol — whose **blast radius** fans across the whole codebase, so a single edit breaks thousands of call sites at once and no vertical slice can land green. Don't force it into a tracer bullet; sequence it as **expand–contract**. First expand: add the new form beside the old so nothing breaks. Then migrate the call sites over in batches sized by blast radius (per package, per directory), each batch its own ticket blocked by the expand, keeping CI green batch to batch because the old form still exists. Finally contract: delete the old form once no caller remains, in a ticket blocked by every migrate batch. When even the batches can't stay green alone, keep the sequence but let them share an integration branch that all block a final integrate-and-verify ticket — green is promised only there.

### 4. Quiz the user

Present the proposed breakdown as a numbered list. For each ticket, show:

- **Title**: short descriptive name
- **Blocked by**: which other tickets (if any) must complete first
- **What it delivers**: the end-to-end behaviour this ticket makes work

Ask the user:

- Does the granularity feel right? (too coarse / too fine)
- Are the blocking edges correct — does each ticket only depend on tickets that genuinely gate it?
- Should any tickets be merged or split further?

Iterate until the user approves the breakdown.

### 5. Publish the tickets to the configured tracker

Publish the approved tickets. **How** depends on the tracker \`/setup-matt-pocock-skills\` configured — the tickets are the same either way, only the shape of the blocking edges changes:

- **Local files** → write one file per ticket under \`.scratch/<feature-slug>/issues/<NN>-<slug>.md\`, numbered from \`01\` in dependency order (blockers first). Each file's "Blocked by" lists the numbers/titles it depends on. Use the per-ticket file template below — one ticket per file, never a single combined file.
- **A real issue tracker (GitHub, Linear, …)** → publish one issue per ticket in dependency order (blockers first) so each ticket's blocking edges can reference real identifiers. Use the platform's native blocking / sub-issue relationship where it has one; otherwise set each ticket's "Blocked by" to the blocking issues. Apply the \`ready-for-agent\` triage label unless instructed otherwise — the tickets are agent-grabbable by construction.

Work the **frontier**: any ticket whose blockers are all done. For a purely linear chain that means top to bottom.

Do NOT close or modify any parent issue.

<local-ticket-template>

# <NN> — <Ticket title>

**What to build:** the end-to-end behaviour this ticket makes work, from the user's perspective — not a layer-by-layer implementation list.

**Blocked by:** the numbers/titles of the tickets that gate this one, or "None — can start immediately".

**Status:** ready-for-agent

- [ ] Acceptance criterion 1
- [ ] Acceptance criterion 2

</local-ticket-template>

<issue-template>

## Parent

A reference to the parent issue on the tracker (if the source was an existing issue, otherwise omit this section).

## What to build

The end-to-end behaviour this ticket makes work, from the user's perspective — not layer-by-layer implementation.

## Acceptance criteria

- [ ] Criterion 1
- [ ] Criterion 2

## Blocked by

- A reference to each blocking ticket, or "None — can start immediately".

</issue-template>

In either form, avoid specific file paths or code snippets — they go stale fast. Exception: if a prototype produced a snippet that encodes a decision more precisely than prose can (state machine, reducer, schema, type shape), inline it and note briefly that it came from a prototype. Trim to the decision-rich parts — not a working demo, just the important bits.

## T3 workflow adapter

T3's Planning workflow owns publication and approval:

- Treat the current durable Spec as the upstream source reference.
- Draft the complete tracer-bullet set and blocking graph using the upstream process and templates.
- Store tickets through the planning-tickets-artifact requested by the stage launch prompt; do not create local files or external tracker issues.
- Stop after drafting. The separate automatic Ticket Review stage owns completeness review, adjustment cycles, and final approval.
- Do not quiz or ask the user. The preceding Product Grill or interactive Engineering Grill is the workflow's only user gate.
- Use the repository glossary and ADRs, loading supporting documents through workflow_doc_get only when needed.

These rules override only upstream tracker publication and quiz ownership. Vertical slicing, blocker edges, wide-refactor expand–contract sequencing, frontier ordering, ticket sizing, and ticket content remain authoritative.
</collaboration_mode>`;

const PLANNING_REVIEW_PROMPT = `<collaboration_mode># Planning Workflow: Ticket Review

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

## Review cycle

1. In cycle 1, read the Spec and all available context, call \`workflow_tickets_list\`, retrieve every ticket with \`workflow_ticket_get\`, and review the complete ticket set before judging it.
2. Apply corrections directly. When a ticket needs rework you can perform yourself, edit it through the \`ticketEdits\` array of your planning-reviewer-verdict: \`update\` to correct a ticket's title, body, planned file changes, or dependencies; \`create\` (with \`replacesPlanningTicketIds\` when splitting or replacing) to add missing slices; \`delete\` to remove redundant ones; \`update-dependencies\` to fix blocking edges alone.
3. Return one \`perTicketFeedback\` entry per targeted ticket, and name every ticket that still needs authoring-thread rework in \`failingPlanningTicketIds\`. Prefer direct ticket edits over bouncing feedback; reserve failures for corrections that genuinely need the authoring thread.
4. If anything is missing, too broad, too narrow, horizontally sliced, incorrectly blocked, or vague, correct it or return concrete corrections. Do not quiz the user while the ticket set still needs review corrections.
5. In later cycles, retrieve and review only the failed, reworked, or replacement tickets named in the target scope. Previously passed tickets stay out of scope.
6. Repeat targeted review until those tickets pass. Ticket review runs at most three cycles, and each cycle runs in its own reviewer sub-thread. A clean targeted pass completes ticket review; do not request another full-review cycle.

## Automatic approval

Do not quiz or ask the user. The preceding Product Grill or interactive Engineering Grill is the workflow's only user gate. A clean reviewer verdict automatically finalizes the durable ticket set already stored through planning-tickets-artifact and the review cycles' ticket edits. If the review cap is exhausted, orchestration records warnings and continues according to the workflow policy. There is no separate publication step, external tracker, or triage label.
</collaboration_mode>`;

const PLANNING_ADR_FORMAT_ASSOCIATED_DOC_CONTENT = `# ADR Format

ADRs live in \`docs/adr/\` and use sequential numbering: \`0001-slug.md\`, \`0002-slug.md\`, etc.

Create the \`docs/adr/\` directory lazily — only when the first ADR is needed.

## Template

\`\`\`md
# {Short title of the decision}

{1-3 sentences: what's the context, what did we decide, and why.}
\`\`\`

That's it. An ADR can be a single paragraph. The value is in recording *that* a decision was made and *why* — not in filling out sections.

## Optional sections

Only include these when they add genuine value. Most ADRs won't need them.

- **Status** frontmatter (\`proposed | accepted | deprecated | superseded by ADR-NNNN\`) — useful when decisions are revisited
- **Considered Options** — only when the rejected alternatives are worth remembering
- **Consequences** — only when non-obvious downstream effects need to be called out

## Numbering

Scan \`docs/adr/\` for the highest existing number and increment by one.

## When to offer an ADR

All three of these must be true:

1. **Hard to reverse** — the cost of changing your mind later is meaningful
2. **Surprising without context** — a future reader will look at the code and wonder "why on earth did they do it this way?"
3. **The result of a real trade-off** — there were genuine alternatives and you picked one for specific reasons

If a decision is easy to reverse, skip it — you'll just reverse it. If it's not surprising, nobody will wonder why. If there was no real alternative, there's nothing to record beyond "we did the obvious thing."

### What qualifies

- **Architectural shape.** "We're using a monorepo." "The write model is event-sourced, the read model is projected into Postgres."
- **Integration patterns between contexts.** "Ordering and Billing communicate via domain events, not synchronous HTTP."
- **Technology choices that carry lock-in.** Database, message bus, auth provider, deployment target. Not every library — just the ones that would take a quarter to swap out.
- **Boundary and scope decisions.** "Customer data is owned by the Customer context; other contexts reference it by ID only." The explicit no-s are as valuable as the yes-s.
- **Deliberate deviations from the obvious path.** "We're using manual SQL instead of an ORM because X." Anything where a reasonable reader would assume the opposite. These stop the next engineer from "fixing" something that was deliberate.
- **Constraints not visible in the code.** "We can't use AWS because of compliance requirements." "Response times must be under 200ms because of the partner API contract."
- **Rejected alternatives when the rejection is non-obvious.** If you considered GraphQL and picked REST for subtle reasons, record it — otherwise someone will suggest GraphQL again in six months.`;

const DOMAIN_DOCS_ASSOCIATED_DOC_CONTENT = `# Domain Docs

How the engineering skills should consume this repo's domain documentation when exploring the codebase.

## Before exploring, read these

- **\`CONTEXT.md\`** at the repo root, or
- **\`CONTEXT-MAP.md\`** at the repo root if it exists — it points at one \`CONTEXT.md\` per context. Read each one relevant to the topic.
- **\`docs/adr/\`** — read ADRs that touch the area you're about to work in. In multi-context repos, also check \`src/<context>/docs/adr/\` for context-scoped decisions.

If any of these files don't exist, **proceed silently**. Don't flag their absence; don't suggest creating them upfront. The Domain Modeling discipline (run inside the Engineering Grill) creates them lazily when terms or decisions actually get resolved.

## File structure

Single-context repo (most repos):

\`\`\`
/
├── CONTEXT.md
├── docs/adr/
│   ├── 0001-event-sourced-orders.md
│   └── 0002-postgres-for-write-model.md
└── src/
\`\`\`

Multi-context repo (presence of \`CONTEXT-MAP.md\` at the root):

\`\`\`
/
├── CONTEXT-MAP.md
├── docs/adr/                          ← system-wide decisions
└── src/
    ├── ordering/
    │   ├── CONTEXT.md
    │   └── docs/adr/                  ← context-specific decisions
    └── billing/
        ├── CONTEXT.md
        └── docs/adr/
\`\`\`

## Use the glossary's vocabulary

When your output names a domain concept (in a ticket title, a refactor proposal, a hypothesis, a test name), use the term as defined in \`CONTEXT.md\`. Don't drift to synonyms the glossary explicitly avoids.

If the concept you need isn't in the glossary yet, that's a signal — either you're inventing language the project doesn't use (reconsider) or there's a real gap (note it for Domain Modeling).

## Flag ADR conflicts

If your output contradicts an existing ADR, surface it explicitly rather than silently overriding:

> _Contradicts ADR-0007 (event-sourced orders) — but worth reopening because…_`;

const AGENT_BRIEF_ASSOCIATED_DOC_CONTENT = `# Writing Agent Briefs

> **T3 adaptation:** In T3's workflows this document describes the body of a durable planning ticket, not a comment on a GitHub issue or PR. Tickets produced by the Tickets and Ticket Review stages are agent-ready by construction — the \`ready-for-agent\` state is implicit and there are no tracker labels.

An agent brief is a structured comment posted on a GitHub issue or PR when it moves to \`ready-for-agent\`. It is the authoritative specification that an AFK agent will work from. The original body and discussion are context — the agent brief is the contract.

The brief states **what the agent should do**, which stretches to both surfaces: for an issue, that's building the change from nothing; for a PR, it's what's left to do *to the existing diff* — finish it, close gaps, address review points. Same principles either way.

## Principles

### Durability over precision

The ticket may sit ready for days or weeks. The codebase will change in the meantime. Write the brief so it stays useful even as files are renamed, moved, or refactored.

- **Do** describe interfaces, types, and behavioral contracts
- **Do** name specific types, function signatures, or config shapes that the agent should look for or modify
- **Don't** reference file paths — they go stale
- **Don't** reference line numbers
- **Don't** assume the current implementation structure will remain the same

### Behavioral, not procedural

Describe **what** the system should do, not **how** to implement it. The agent will explore the codebase fresh and make its own implementation decisions.

- **Good:** "The \`SkillConfig\` type should accept an optional \`schedule\` field of type \`CronExpression\`"
- **Bad:** "Open src/types/skill.ts and add a schedule field on line 42"
- **Good:** "When a user runs \`/triage\` with no arguments, they should see a summary of issues needing attention"
- **Bad:** "Add a switch statement in the main handler function"

### Complete acceptance criteria

The agent needs to know when it's done. Every agent brief must have concrete, testable acceptance criteria. Each criterion should be independently verifiable.

- **Good:** "Running \`gh issue list --label needs-triage\` returns issues that have been through initial classification"
- **Bad:** "Triage should work correctly"

### Explicit scope boundaries

State what is out of scope. This prevents the agent from gold-plating or making assumptions about adjacent features.

## Template

\`\`\`markdown
## Agent Brief

**Category:** bug / enhancement
**Summary:** one-line description of what needs to happen

**Current behavior:**
Describe what happens now. For bugs, this is the broken behavior.
For enhancements, this is the status quo the feature builds on.

**Desired behavior:**
Describe what should happen after the agent's work is complete.
Be specific about edge cases and error conditions.

**Key interfaces:**
- \`TypeName\` — what needs to change and why
- \`functionName()\` return type — what it currently returns vs what it should return
- Config shape — any new configuration options needed

**Acceptance criteria:**
- [ ] Specific, testable criterion 1
- [ ] Specific, testable criterion 2
- [ ] Specific, testable criterion 3

**Out of scope:**
- Thing that should NOT be changed or addressed in this issue
- Adjacent feature that might seem related but is separate
\`\`\`

## Example: good agent brief

\`\`\`markdown
## Agent Brief

**Category:** bug
**Summary:** Skill description truncation drops mid-word, producing broken output

**Current behavior:**
When a skill description exceeds 1024 characters, it is truncated at exactly
1024 characters regardless of word boundaries. This produces descriptions
that end mid-word (e.g. "Use when the user wants to confi").

**Desired behavior:**
Truncation should break at the last word boundary before 1024 characters
and append "..." to indicate truncation.

**Key interfaces:**
- The \`SkillMetadata\` type's \`description\` field — no type change needed,
  but the validation/processing logic that populates it needs to respect
  word boundaries
- Any function that reads SKILL.md frontmatter and extracts the description

**Acceptance criteria:**
- [ ] Descriptions under 1024 chars are unchanged
- [ ] Descriptions over 1024 chars are truncated at the last word boundary
      before 1024 chars
- [ ] Truncated descriptions end with "..."
- [ ] The total length including "..." does not exceed 1024 chars

**Out of scope:**
- Changing the 1024 char limit itself
- Multi-line description support
\`\`\`

## Example: bad agent brief

\`\`\`markdown
## Agent Brief

**Summary:** Fix the triage bug

**What to do:**
The triage thing is broken. Look at the main file and fix it.
The function around line 150 has the issue.

**Files to change:**
- src/triage/handler.ts (line 150)
- src/types.ts (line 42)
\`\`\`

This is bad because:
- No category
- Vague description ("the triage thing is broken")
- References file paths and line numbers that will go stale
- No acceptance criteria
- No scope boundaries
- No description of current vs desired behavior`;
const IMPLEMENTATION_ORCHESTRATOR_PROMPT = `<collaboration_mode># Implementation Workflow: Orchestrator Start

---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run focused tests and scoped static checks during implementation. Documented sub-minute fast checks such as \`pnpm check\` are allowed. The final gate after Code Review owns complete repository validation.

Once done, use /code-review to review the work.

Commit your work to the current branch.

## T3 workflow adapter

This stage orchestrates the upstream implement loop across sub-threads instead of doing the work inline:

- Load the durable Spec with workflow_spec_get and the tickets with workflow_tickets_list and workflow_ticket_get. The Spec is the node that binds the tickets and later app reviews together.
- The run reuses the Planning workflow's dedicated worktree and branch, which were created from the branch the user selected before Planning began. The finished change request is filed back into that original branch.
- Reuse the AppDevStack created for the Planning worktree during workspace bootstrap. Implementation must not create a replacement stack. Load \`app-dev-stack.md\` before diagnosing it; do not start another server.
- Tickets are implemented dependency-aware by TDD worker sub-threads (the TDD Implementation skill), each in its own worktree and branch. A dependent ticket's worker branches from its blocker's worker branch so chained tickets build on each other, and every worker commits to its own branch.
- Worker branches are merged programmatically back into the orchestrator worktree; the Merge Gate stage always runs once for the integrated HEAD, whether integration was clean or required conflict resolution.
- A Browser App Review finding launches a fresh TDD repair thread on the already-integrated orchestrator worktree. After that repair commits and passes focused checks, start the next Browser App Review directly; do not rerun the Merge Gate between review cycles.
- Automated QA has one global budget of ten fresh AppDevStack/App Review repair agents after integration. Initial stack probes and Browser App Review launches do not consume repair slots; replacing a malformed, failed, blocked, or interrupted repair does. After the cap, a clean integration-gated HEAD proceeds through best-effort Code Review with the unresolved gate flagged in the change request.
- Code Review starts with one comprehensive review-and-fix pass. If complete final validation needs a repair, the next pass reviews only that repair delta. Review/final-validation cycles are capped at three; exhaustion publishes the clean branch with an explicit work-in-progress warning instead of looping indefinitely.
- Ticket workers never run launch-level complete validation commands or full test suites, but may run documented sub-minute fast checks. After each bounded Code Review pass, the final gate runs each launch validation command once on the reviewed HEAD before publication.

Plan the implementation run from the Spec and planning tickets. Identify worktree strategy, ticket order, validation commands, required app-dev/browser review surfaces, merge gates, and how progress will be reported. These rules override only upstream single-thread mechanics; TDD at pre-agreed seams, regular typechecking, review before publication, and committed work remain authoritative.
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

When this prompt is run by an automatic implementation-worker thread, do not ask the user questions. In an orchestrated worker thread the Spec's Testing Decisions and the assigned ticket's acceptance criteria *are* the pre-agreed seams — never ask the user to confirm them. Implement the assigned planning ticket, run focused validation, and finish with exactly one fenced JSON block using this shape:

- Run one focused failing test before implementation.
- After each behavioral slice, run the relevant focused test.
- At completion, run only affected-file formatting, linting, typing, and focused tests.
- Do not run launch-level complete validation commands or full test suites. A documented sub-minute fast check such as \`pnpm check\` is allowed. The final gate after Code Review owns complete validation.
- Do not rerun an unchanged passing command unless a code change could affect its result.

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

## Orchestrated QA Repair Result

When the launch message identifies an AppDevStack or Browser App Review failure, this is a QA repair thread rather than a planning-ticket worker. Load \`app-dev-stack.md\` before changing dependency or runtime setup. The programmatic diagnostics, original Spec/tickets or proposed plan, and the failed review are the pre-agreed seams. Do not ask the user to confirm them. Work red then green in the orchestrator worktree, run focused validation or a documented sub-minute fast check, commit the repair, leave the worktree clean, and finish with exactly one fenced JSON block using this shape. The final gate after Code Review owns complete validation on the new HEAD; do not run launch-level complete validation commands here.

\`\`\`json
{
  "type": "implementation-fix-result",
  "runId": "implementation-run-id",
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
  "notesMarkdown": "What failed, the red-green repair, and remaining risks."
}
\`\`\`
</collaboration_mode>`;

const IMPLEMENTATION_MERGE_GATE_PROMPT = `<collaboration_mode># Implementation Workflow: Merge Gate

Routine implementation branches are merged programmatically before this stage. The launch message names this as either an integration gate or the final gate. The integration gate always runs for the integrated HEAD, including conflict-free integration, and uses focused or documented sub-minute fast checks. The final gate runs only after Code Review and runs each configured complete command exactly once before publication. Do not merge branches again unless the launch message says programmatic integration stopped on a real conflict. Never repeat a successful complete gate on an unchanged commit.

Do not ask the user questions. If you cannot merge or validate, report a failed merge-gate result with the blocker.

When ready, finish with exactly one fenced JSON block using this shape:

\`\`\`json
{
  "type": "implementation-merge-gate-result",
  "runId": "implementation-run-id",
  "status": "passed",
  "validations": [
    {
      "command": "vp test focused-test",
      "status": "passed",
      "outputMarkdown": "Important output or empty string.",
      "completedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "summaryMarkdown": "What was merged and validated."
}
\`\`\`
</collaboration_mode>`;

const IMPLEMENTATION_BROWSER_APP_REVIEW_PROMPT = `<collaboration_mode># Browser App Review

Exercise the supplied preview target from the selected worktree. Verify the relevant UI flows in-browser, capture concrete failures with reproduction steps, and create durable App Review findings against the launch brief. This review may run standalone or as a nested stage of Implementation.

If the preview is unavailable, stuck on startup recovery, or has dependency/runtime failures, load \`app-dev-stack.md\` before diagnosing it.

This thread is already the Browser App Review agent. Use the linked preview_* and app_review_* tools directly. Never delegate to or launch another Browser App Review.

When this Browser App Review is linked to a durable App Review record:

1. Call app_review_get first to load the durable App Review record before testing.
2. Read the source thread context and identify the behavior under review.
3. Call preview_open to initialize the collaborative browser tab. If the launch message provides a Feature URL, navigate there with preview_navigate. If no URL is provided, inspect the current preview state; if no usable app target is available, mark the review blocked with concrete details.
4. Start the screen recording with app_review_recording_start before exercising the feature.
5. Exercise the product with the preview tools: preview_snapshot to inspect the page, then preview_click, preview_type, preview_press, preview_scroll, and preview_wait_for to interact. Re-run preview_snapshot after the DOM changes; element references from an old snapshot go stale. Do not rely on static assumptions.
6. Capture a captioned screenshot with app_review_capture_screenshot at each meaningful application state (initial load, after key interactions, any failure states). Findings should reference these screenshot ids in evidenceIds.
7. Stop the recording with app_review_recording_stop after browser testing.
8. Treat evidence as required. Passed requires a saved recording and at least one screenshot. Failed normally uses the same evidence, but if recording finalization fails after product testing, keep a failed verdict when at least one check failed and every actionable finding references a captured screenshot. Do not turn evidenced product defects into blocked solely because video saving failed. Use blocked only when trustworthy product evidence could not be captured.
9. Update the App Review record with app_review_update, including verdict, summary, checks, findings, questions, next steps, and evidence IDs.
10. Mark the review status passed, failed, or blocked.

If no durable App Review record is linked, this is focused feedback mode. Use preview_* tools only, call preview_open with show: false, do not call app_review_* tools, and do not record or capture evidence unless the focused question itself requires a screenshot. Finish with exactly one workflow-subagent-result directive containing concise observations, reproduction steps, blockers, and recommendations.

Use only the preview_* tools in feedback mode and preview_* plus app_review_* tools in full mode. Do not use external browsers, browser MCP servers, standalone Playwright scripts, or shell-driven browser automation. See preview-browser-qa.md for the full preview toolset guidance.
</collaboration_mode>`;

const IMPLEMENTATION_FIX_PROMPT = `<collaboration_mode># Implementation Workflow: Fix

Fix the Browser App Review, integration-gate, final-gate, or code-review failures in the orchestrator worktree. Do not ask the user questions. Make the smallest reliable change, run focused validation or a documented sub-minute fast check, commit the repair, and report whether the run can continue. Do not run launch-level complete validation commands. The final gate after Code Review owns complete validation on the new HEAD.

When the failure involves an AppDevStack, Feature URL, or preview runtime, load \`app-dev-stack.md\` before changing dependency or runtime setup.

When ready, finish with exactly one fenced JSON block using this shape:

\`\`\`json
{
  "type": "implementation-fix-result",
  "runId": "implementation-run-id",
  "status": "succeeded",
  "commitSha": "optional-commit-sha",
  "validations": [
    {
      "command": "vp test focused-test",
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

When this prompt is run by an automatic implementation run, do not ask the user questions. The launch message provides the fixed point, the diff command, the worktree, the change request, and the Spec source — use those instead of asking or searching the issue tracker.

Run the two axes as parallel feedback sub-agents by emitting one workflow-subagents-create directive with two children that return workflow-subagent-result, instead of upstream's \`Agent\` tool calls. If child creation is unavailable in this thread, run the two axis briefs sequentially yourself. Aggregation, fixes, validation, the commit, and the final result directive always stay in this thread.

**The launch message defines the complete review scope.** Review only its supplied diff and fixed point. A later bounded pass may intentionally cover only the repair delta, so do not reopen unchanged code before that fixed point. You are the last automated reviewer for the supplied scope: aggregate both axes, then act on their findings yourself:

1. Run both axes and aggregate the two-axis report.
2. If either axis produced findings that require code changes, fix them in the orchestrator worktree with the smallest reliable changes. Do not delegate the fixes and do not defer them to a follow-up.
3. If you made changes, run focused tests or a documented sub-minute fast check and report the results. Do not run launch-level complete validation commands. If the review is clean, do not rerun validation.
4. Commit your fixes on the orchestrator branch and leave the worktree clean.
5. Report the commit you produced.

Finish with exactly one fenced JSON block using this shape:

\`\`\`json
{
  "type": "implementation-code-review-result",
  "runId": "implementation-run-id",
  "status": "findings",
  "commitSha": "HEAD commit SHA after your fixes",
  "validations": [
    {
      "command": "vp test focused-test",
      "status": "passed",
      "outputMarkdown": "summary",
      "completedAt": "ISO timestamp"
    }
  ],
  "reportMarkdown": "## Standards\\n...\\n\\n## Spec\\n..."
}
\`\`\`

Use status "clean" when neither axis has findings that require code changes — omit \`commitSha\` and leave HEAD untouched. Use "findings" when code changes were required: include every finding in reportMarkdown, set \`commitSha\` to the HEAD you committed, and report each required validation in \`validations\`. Use "blocked" when the review cannot be performed at all (say why in reportMarkdown); do not use it to hand unfixed findings back.
</collaboration_mode>`;

const buildPresetProductWorkflowPrompt = (input: {
  readonly intentKind: "feature" | "fix";
  readonly workspacePrepared: boolean;
}) => `<collaboration_mode># Product Grill

${GRILLING_BLUEPRINT}

${STRUCTURED_GRILL_QUESTION_ADAPTER}

## Product-only adapter

Before asking questions, ground yourself in the codebase and existing product context. Use that knowledge to resolve facts and answer anything already clear; ask the user only where product clarity, preference, or alignment is needed.

${
  input.workspacePrepared
    ? "This workflow already owns the current worktree. Every later Plan, Build, Implementation, and App Review stage reuses that shared workspace and its AppDevStack. The stack starts programmatically as soon as repository-declared dependency setup succeeds; do not start a competing development server or use another worktree's runtime."
    : ""
}

The selected product workflow is authoritative even when the user's wording sounds like a direct implementation, investigation, or verification request. Do not perform that work during Product Grill. If grounding resolves every product decision, go straight to the structured final shared-understanding confirmation; never silently treat apparent clarity as confirmation or end the turn without either a structured Product Grill question or the final intent-lock directive.

Cover product direction only: the problem, audience, desired outcome, user-visible behavior and experience, success criteria, scope, and non-goals. Do not ask about implementation, architecture, testing, workflow sequencing, or operations.

Restricting the design tree to product decisions is the product-scope adaptation to the Grilling blueprint. Its dependency-frontier mechanics remain authoritative, subject to the structured-question adapter's seven-question maximum.

The session is done when every product branch has been visited and nothing remains silently assumed. Do not lock the intent until the user confirms you have reached a shared understanding.

The intent kind is fixed as "${input.intentKind}". Do not ask the user to classify it.

After confirmation, finish with exactly one fenced JSON directive and no other fenced JSON blocks:

\`\`\`json
{ "type": "product-intent-locked", "intentKind": "${input.intentKind}", "title": "...", "summaryMarkdown": "..." }
\`\`\`

</collaboration_mode>`;

const PRODUCT_FIX_WORKFLOW_PROMPT = buildPresetProductWorkflowPrompt({
  intentKind: "fix",
  workspacePrepared: false,
});
const PRODUCT_FAST_FEATURE_WORKFLOW_PROMPT = buildPresetProductWorkflowPrompt({
  intentKind: "feature",
  workspacePrepared: true,
});
const PRODUCT_FULL_FEATURE_WORKFLOW_PROMPT = buildPresetProductWorkflowPrompt({
  intentKind: "feature",
  workspacePrepared: true,
});

const mattPocockDomainModelingSkill = mattPocockEngineeringSkills.skills.find(
  (skill) => skill.id === "matt-pocock.domain-modeling",
);
if (mattPocockDomainModelingSkill === undefined) {
  throw new Error("The Matt Pocock engineering skill snapshot is missing domain-modeling");
}

const MATT_POCOCK_ENGINEERING_SKILL_PROMPTS: ReadonlyArray<WorkflowPromptContract> =
  mattPocockEngineeringSkills.skills.map((skill, index) => ({
    id: skill.id,
    order: 100 + index,
    workflow: "shared",
    role: "implementation-worker",
    stage: "build",
    title: skill.title,
    description: skill.description,
    promptText:
      skill.id === "matt-pocock.grill-with-docs"
        ? `${skill.promptText}

## T3 direct Build adapter

This invocation runs through T3's provider-independent skill catalog, so do not call a provider-local Skill tool. Apply both the Grilling and Domain Modeling instructions below directly.

<grilling-skill>
${GRILLING_BLUEPRINT}
</grilling-skill>

<domain-modeling-skill>
${mattPocockDomainModelingSkill.promptText}
</domain-modeling-skill>`
        : skill.promptText,
    associatedDocs: (skill.id === "matt-pocock.grill-with-docs"
      ? [skill, mattPocockDomainModelingSkill]
      : [skill]
    ).flatMap((referencedSkill) =>
      referencedSkill.docs.map((doc) => ({
        id: doc.id,
        title: doc.title,
        path: `${referencedSkill.name}/${doc.path}`,
        content: doc.content,
      })),
    ),
  }));

export const WORKFLOW_PROMPT_REGISTRY = [
  ...MATT_POCOCK_ENGINEERING_SKILL_PROMPTS,
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
    id: WORKFLOW_PROMPT_IDS.sharedGrillingCodex,
    order: 2,
    workflow: "shared",
    role: "workflow-communications",
    stage: "grilling",
    title: "Grilling",
    description: "The shared design-tree and frontier-round interview primitive.",
    promptText: GRILLING_BLUEPRINT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.planningGrillStageCodex,
    order: 1,
    workflow: "planning",
    role: "planning-thread",
    stage: "grill",
    title: "1. Engineering Grill",
    description:
      "Grills engineering decisions while maintaining the domain glossary and qualifying ADRs.",
    promptText: ENGINEERING_GRILL_PROMPT,
    associatedDocs: [
      APP_DEV_STACK_ASSOCIATED_DOC,
      {
        id: "context-format",
        title: "CONTEXT.md Format",
        path: "CONTEXT-FORMAT.md",
        content: CONTEXT_FORMAT_ASSOCIATED_DOC_CONTENT,
      },
      {
        id: "adr-format",
        title: "ADR Format",
        path: "ADR-FORMAT.md",
        content: PLANNING_ADR_FORMAT_ASSOCIATED_DOC_CONTENT,
      },
    ],
  },
  {
    id: WORKFLOW_PROMPT_IDS.planningDomainModelingCodex,
    order: 2,
    workflow: "planning",
    role: "planning-thread",
    stage: "domain-modeling",
    title: "Domain Modeling",
    description: "Sharpens repository language, contexts, scenarios, and durable decisions.",
    promptText: DOMAIN_MODELING_PROMPT,
    associatedDocs: [
      APP_DEV_STACK_ASSOCIATED_DOC,
      {
        id: "context-format",
        title: "CONTEXT.md Format",
        path: "CONTEXT-FORMAT.md",
        content: CONTEXT_FORMAT_ASSOCIATED_DOC_CONTENT,
      },
      {
        id: "adr-format",
        title: "ADR Format",
        path: "ADR-FORMAT.md",
        content: PLANNING_ADR_FORMAT_ASSOCIATED_DOC_CONTENT,
      },
    ],
  },
  {
    id: WORKFLOW_PROMPT_IDS.planningAutomaticEngineeringGrillCodex,
    order: 2,
    workflow: "planning",
    role: "planning-thread",
    stage: "grill",
    title: "Engineering Grill (Automatic)",
    description:
      "Resolves engineering and domain decisions autonomously from locked Product Grill intent.",
    promptText: AUTOMATIC_ENGINEERING_GRILL_PROMPT,
    associatedDocs: [
      APP_DEV_STACK_ASSOCIATED_DOC,
      {
        id: "context-format",
        title: "CONTEXT.md Format",
        path: "CONTEXT-FORMAT.md",
        content: CONTEXT_FORMAT_ASSOCIATED_DOC_CONTENT,
      },
      {
        id: "adr-format",
        title: "ADR Format",
        path: "ADR-FORMAT.md",
        content: PLANNING_ADR_FORMAT_ASSOCIATED_DOC_CONTENT,
      },
    ],
  },
  {
    id: WORKFLOW_PROMPT_IDS.planningPrototypeCodex,
    order: 3,
    workflow: "planning",
    role: "planning-thread",
    stage: "prototype",
    title: "Prototype",
    description: "Builds throwaway logic or UI artifacts to answer one design question.",
    promptText: PROTOTYPE_PROMPT,
    associatedDocs: [
      APP_DEV_STACK_ASSOCIATED_DOC,
      {
        id: "prototype-logic",
        title: "Logic Prototype",
        path: "LOGIC.md",
        content: PROTOTYPE_LOGIC_DOC_CONTENT,
      },
      {
        id: "prototype-ui",
        title: "UI Prototype",
        path: "UI.md",
        content: PROTOTYPE_UI_DOC_CONTENT,
      },
    ],
  },
  {
    id: WORKFLOW_PROMPT_IDS.planningWayfinderCodex,
    order: 4,
    workflow: "planning",
    role: "planning-thread",
    stage: "wayfinding",
    title: "Wayfinder",
    description: "Maps large, uncertain work into dependency-aware decision tickets.",
    promptText: WAYFINDER_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.planningResearchCodex,
    order: 5,
    workflow: "planning",
    role: "planning-thread",
    stage: "research",
    title: "Research",
    description: "Resolves bounded questions from primary sources into cited repository notes.",
    promptText: RESEARCH_PROMPT,
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
    associatedDocs: [
      APP_DEV_STACK_ASSOCIATED_DOC,
      {
        id: "context-format",
        title: "CONTEXT.md Format",
        path: "CONTEXT-FORMAT.md",
        content: CONTEXT_FORMAT_ASSOCIATED_DOC_CONTENT,
      },
      {
        id: "adr-format",
        title: "ADR Format",
        path: "ADR-FORMAT.md",
        content: PLANNING_ADR_FORMAT_ASSOCIATED_DOC_CONTENT,
      },
      {
        id: "domain-docs",
        title: "Domain Docs",
        path: "domain.md",
        content: DOMAIN_DOCS_ASSOCIATED_DOC_CONTENT,
      },
    ],
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
    associatedDocs: [
      APP_DEV_STACK_ASSOCIATED_DOC,
      {
        id: "domain-docs",
        title: "Domain Docs",
        path: "domain.md",
        content: DOMAIN_DOCS_ASSOCIATED_DOC_CONTENT,
      },
      {
        id: "agent-brief",
        title: "Writing Agent Briefs",
        path: "AGENT-BRIEF.md",
        content: AGENT_BRIEF_ASSOCIATED_DOC_CONTENT,
      },
    ],
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
    associatedDocs: [
      APP_DEV_STACK_ASSOCIATED_DOC,
      {
        id: "agent-brief",
        title: "Writing Agent Briefs",
        path: "AGENT-BRIEF.md",
        content: AGENT_BRIEF_ASSOCIATED_DOC_CONTENT,
      },
    ],
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
    associatedDocs: [APP_DEV_STACK_ASSOCIATED_DOC],
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
      APP_DEV_STACK_ASSOCIATED_DOC,
      {
        id: "tdd-mocking",
        title: "When to Mock",
        path: "mocking.md",
        content: IMPLEMENTATION_TDD_MOCKING_ASSOCIATED_DOC_CONTENT,
      },
      {
        id: "tdd-tests",
        title: "Good and Bad Tests",
        path: "tests.md",
        content: IMPLEMENTATION_TDD_GOOD_AND_BAD_TESTS_ASSOCIATED_DOC_CONTENT,
      },
      {
        id: "tdd-logging",
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
    associatedDocs: [APP_DEV_STACK_ASSOCIATED_DOC],
  },
  {
    id: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
    order: 1,
    workflow: "app-review",
    role: "app-review-reviewer",
    stage: "browser-app-review",
    title: "Browser App Review",
    description: "Tests a preview target and creates concrete durable App Review findings.",
    promptText: IMPLEMENTATION_BROWSER_APP_REVIEW_PROMPT,
    associatedDocs: [
      APP_DEV_STACK_ASSOCIATED_DOC,
      {
        id: "preview-browser-qa",
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
    description: "Fixes merge-gate and code-review failures before rerunning validation.",
    promptText: IMPLEMENTATION_FIX_PROMPT,
    associatedDocs: [APP_DEV_STACK_ASSOCIATED_DOC],
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
    associatedDocs: [APP_DEV_STACK_ASSOCIATED_DOC],
  },
  {
    id: WORKFLOW_PROMPT_IDS.productFixCodex,
    order: 1,
    workflow: "product",
    role: "planning-thread",
    stage: "intent",
    title: "Product Grill — Fix",
    description: "Locks a fix intent before same-thread planning and one Build child.",
    promptText: PRODUCT_FIX_WORKFLOW_PROMPT,
  },
  {
    id: WORKFLOW_PROMPT_IDS.productFastFeatureCodex,
    order: 1,
    workflow: "product",
    role: "planning-thread",
    stage: "intent",
    title: "Product Grill — Fast Feature",
    description: "Locks feature intent before lightweight Plan, Build, and review orchestration.",
    promptText: PRODUCT_FAST_FEATURE_WORKFLOW_PROMPT,
    associatedDocs: [APP_DEV_STACK_ASSOCIATED_DOC],
  },
  {
    id: WORKFLOW_PROMPT_IDS.productFullFeatureCodex,
    order: 1,
    workflow: "product",
    role: "planning-thread",
    stage: "intent",
    title: "Product Grill — Full Feature",
    description: "Locks feature intent before complete Planning and Implementation workflows.",
    promptText: PRODUCT_FULL_FEATURE_WORKFLOW_PROMPT,
    associatedDocs: [APP_DEV_STACK_ASSOCIATED_DOC],
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

const CATALOG_SKILL_ID_BY_PROMPT_ID: Readonly<Record<string, string>> = {
  [WORKFLOW_PROMPT_IDS.planningGrillStageCodex]: "matt-pocock.grill-with-docs",
  [WORKFLOW_PROMPT_IDS.planningAutomaticEngineeringGrillCodex]: "matt-pocock.grill-with-docs",
  [WORKFLOW_PROMPT_IDS.planningDomainModelingCodex]: "matt-pocock.domain-modeling",
  [WORKFLOW_PROMPT_IDS.planningPrototypeCodex]: "matt-pocock.prototype",
  [WORKFLOW_PROMPT_IDS.planningWayfinderCodex]: "matt-pocock.wayfinder",
  [WORKFLOW_PROMPT_IDS.planningResearchCodex]: "matt-pocock.research",
  [WORKFLOW_PROMPT_IDS.planningSpecCodex]: "matt-pocock.to-spec",
  [WORKFLOW_PROMPT_IDS.planningTicketsCodex]: "matt-pocock.to-tickets",
  [WORKFLOW_PROMPT_IDS.implementationOrchestratorPlanningCodex]: "matt-pocock.implement",
  [WORKFLOW_PROMPT_IDS.implementationTddCodex]: "matt-pocock.tdd",
  [WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex]: "matt-pocock.code-review",
};

const VISIBLE_T3_SKILL_IDS = new Set<string>([
  WORKFLOW_PROMPT_IDS.productFastFeatureCodex,
  WORKFLOW_PROMPT_IDS.productFullFeatureCodex,
  WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex,
  WORKFLOW_PROMPT_IDS.implementationMergeGateCodex,
  WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
  WORKFLOW_PROMPT_IDS.implementationFixCodex,
]);

const MATT_POCOCK_SKILL_IDS = new Set(mattPocockEngineeringSkills.skills.map((skill) => skill.id));

function catalogSkillIdForPromptId(promptId: string): string {
  return CATALOG_SKILL_ID_BY_PROMPT_ID[promptId] ?? promptId;
}

function summarizeWorkflowDoc(content: string): string {
  const paragraph = content
    .replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/, "")
    .replace(/```[\s\S]*?```/g, "")
    .split(/\r?\n\s*\r?\n/)
    .filter(
      (candidate) => !candidate.trim().startsWith("```") && !candidate.trim().startsWith("#!"),
    )
    .map((candidate) =>
      candidate
        .replace(/^#+\s+.*$/gm, "")
        .replace(/\s+/g, " ")
        .trim(),
    )
    .find((candidate) => candidate.length >= 20);
  if (paragraph === undefined) {
    return "Supporting instructions loaded by this skill when needed.";
  }
  return paragraph.length > 240 ? `${paragraph.slice(0, 237).trimEnd()}…` : paragraph;
}

function buildWorkflowCatalog(): WorkflowCatalog {
  const promptContracts: ReadonlyArray<WorkflowPromptContract> = WORKFLOW_PROMPT_REGISTRY;
  const promptContractById = new Map(promptContracts.map((contract) => [contract.id, contract]));
  const workflowOrder = ["fast-feature", "full-feature", "wayfinder", "planning", "implementation"];
  const workflows = WORKFLOW_PRESET_DEFINITIONS.toSorted(
    (left, right) => workflowOrder.indexOf(left.id) - workflowOrder.indexOf(right.id),
  ).map((definition, workflowIndex) => ({
    id: definition.id,
    order: workflowIndex + 1,
    title: definition.label,
    description: definition.description,
    interactionMode: definition.interactionMode,
    steps: definition.helpSteps.map((step) => {
      const skillId = step.skillId ? catalogSkillIdForPromptId(step.skillId) : undefined;
      const skillTitle = skillId
        ? promptContractById.get(skillId)?.title.replace(/^\d+\.\s+/, "")
        : undefined;
      const stepContext = skillTitle && skillTitle !== step.label ? step.label : undefined;
      return {
        label: skillTitle ?? step.label,
        ...(skillId ? { skillId } : {}),
        ...(step.threadBoundary ? { threadBoundary: step.threadBoundary } : {}),
        ...(stepContext || step.note
          ? { note: [stepContext, step.note].filter(Boolean).join(" · ") }
          : {}),
      };
    }),
  }));

  const workflowIdsBySkill = new Map<string, string[]>();
  for (const workflow of workflows) {
    for (const step of workflow.steps) {
      if (step.skillId === undefined) continue;
      const ids = workflowIdsBySkill.get(step.skillId) ?? [];
      if (!ids.includes(workflow.id)) ids.push(workflow.id);
      workflowIdsBySkill.set(step.skillId, ids);
    }
  }
  const implicitWorkflowIdsBySkill: Readonly<Record<string, readonly string[]>> = {
    "matt-pocock.grill-with-docs": ["planning"],
    "matt-pocock.domain-modeling": ["full-feature", "wayfinder", "planning"],
    "matt-pocock.implement": ["full-feature", "implementation"],
    [WORKFLOW_PROMPT_IDS.implementationFixCodex]: [
      "fast-feature",
      "full-feature",
      "implementation",
    ],
  };
  for (const [skillId, workflowIds] of Object.entries(implicitWorkflowIdsBySkill)) {
    const ids = workflowIdsBySkill.get(skillId) ?? [];
    for (const workflowId of workflowIds) {
      if (!ids.includes(workflowId)) ids.push(workflowId);
    }
    workflowIdsBySkill.set(skillId, ids);
  }

  type MutableCatalogSkill = Omit<WorkflowSkillContract, "docIds"> & { docIds: string[] };
  const skills: MutableCatalogSkill[] = promptContracts
    .filter(
      (contract) => MATT_POCOCK_SKILL_IDS.has(contract.id) || VISIBLE_T3_SKILL_IDS.has(contract.id),
    )
    .map((contract) => ({
      id: contract.id,
      order: contract.order,
      workflow: contract.workflow,
      role: contract.role,
      stage: contract.stage,
      title: contract.title.replace(/^\d+\.\s+/, ""),
      description: contract.description,
      promptText: contract.promptText,
      docIds: [],
      buildModes: MATT_POCOCK_SKILL_IDS.has(contract.id) ? (["build"] as const) : [],
      workflowIds: workflowIdsBySkill.get(contract.id) ?? [],
      ...(MATT_POCOCK_SKILL_IDS.has(contract.id)
        ? {
            sourceUrl: `${mattPocockEngineeringSkills.source.url.replace("/tree/", "/blob/")}/${mattPocockEngineeringSkills.skills.find((skill) => skill.id === contract.id)?.name}/SKILL.md`,
          }
        : {}),
    }))
    .toSorted(
      (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
    )
    .map((skill, index) => ({ ...skill, order: index + 1 }));

  const docsById = new Map<
    string,
    Omit<WorkflowDocContract, "skillIds"> & { skillIds: string[] }
  >();
  const skillsById = new Map(skills.map((skill) => [skill.id, skill]));
  const generatedDocDescriptionById = new Map(
    mattPocockEngineeringSkills.skills.flatMap((skill) =>
      skill.docs.map((doc) => [doc.id, doc.description] as const),
    ),
  );
  for (const contract of promptContracts) {
    const catalogSkillId = catalogSkillIdForPromptId(contract.id);
    const skill = skillsById.get(catalogSkillId);
    if (skill === undefined) continue;
    for (const doc of contract.associatedDocs ?? []) {
      const existing = docsById.get(doc.id);
      if (existing !== undefined) {
        if (
          existing.title !== doc.title ||
          existing.path !== doc.path ||
          existing.content !== doc.content
        ) {
          throw new Error(`Conflicting workflow doc '${doc.id}'`);
        }
        if (!existing.skillIds.includes(skill.id)) existing.skillIds.push(skill.id);
      } else {
        docsById.set(doc.id, {
          ...doc,
          description: generatedDocDescriptionById.get(doc.id) ?? summarizeWorkflowDoc(doc.content),
          skillIds: [skill.id],
        });
      }
      if (!skill.docIds.includes(doc.id)) skill.docIds.push(doc.id);
    }
  }

  const skillIds = new Set(skills.map((skill) => skill.id));
  for (const workflow of workflows) {
    for (const step of workflow.steps) {
      if (step.skillId !== undefined && !skillIds.has(step.skillId)) {
        throw new Error(`Unknown workflow skill '${step.skillId}' in '${workflow.id}'`);
      }
    }
  }

  const docs = [...docsById.values()].map((doc, _index, allDocs) => {
    const duplicatesAnUpstreamDocForSkill =
      !doc.id.startsWith("matt-pocock.") &&
      doc.skillIds.some((skillId) =>
        allDocs.some(
          (candidate) =>
            candidate.id.startsWith("matt-pocock.") &&
            candidate.title === doc.title &&
            candidate.skillIds.includes(skillId),
        ),
      );
    return duplicatesAnUpstreamDocForSkill ? { ...doc, title: `${doc.title} (T3 workflow)` } : doc;
  });

  return {
    workflows,
    skills,
    docs: docs.toSorted(
      (left, right) => left.title.localeCompare(right.title) || left.id.localeCompare(right.id),
    ),
  };
}

const WORKFLOW_CATALOG = buildWorkflowCatalog();

export function listWorkflowCatalog(): WorkflowCatalog {
  return structuredClone(WORKFLOW_CATALOG);
}

export function resolveWorkflowDoc(docId: string): WorkflowDocContract | undefined {
  const doc = WORKFLOW_CATALOG.docs.find((candidate) => candidate.id === docId);
  return doc === undefined ? undefined : structuredClone(doc);
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

export function isBrowserAppReviewWorkflowPromptId(
  workflowPromptId: string | null | undefined,
): boolean {
  return (
    workflowPromptId !== null &&
    workflowPromptId !== undefined &&
    workflowPromptId === WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex
  );
}

export function isInteractiveStructuredInputWorkflowPromptId(
  workflowPromptId: string | null | undefined,
): boolean {
  return (
    workflowPromptId === WORKFLOW_PROMPT_IDS.planningGrillStageCodex ||
    workflowPromptId === WORKFLOW_PROMPT_IDS.productFixCodex ||
    workflowPromptId === WORKFLOW_PROMPT_IDS.productFastFeatureCodex ||
    workflowPromptId === WORKFLOW_PROMPT_IDS.productFullFeatureCodex
  );
}

export function isInteractiveStructuredInputWorkflow(input: {
  readonly interactionMode?: ProviderInteractionMode | undefined;
  readonly workflowPromptId?: string | undefined;
}): boolean {
  if (input.interactionMode === "planning-workflow") {
    return input.workflowPromptId === WORKFLOW_PROMPT_IDS.planningGrillStageCodex;
  }
  if (input.interactionMode !== "product-workflow") {
    return false;
  }
  return isInteractiveStructuredInputWorkflowPromptId(input.workflowPromptId);
}

export function isPreviewMcpWorkflowPromptId(workflowPromptId: string | null | undefined): boolean {
  return isBrowserAppReviewWorkflowPromptId(workflowPromptId);
}

export function isAppReviewMcpWorkflowPromptId(
  workflowPromptId: string | null | undefined,
): boolean {
  return isBrowserAppReviewWorkflowPromptId(workflowPromptId);
}

function renderAssociatedDocReference(
  doc: NonNullable<WorkflowPromptContract["associatedDocs"]>[number],
) {
  return `<doc id="${doc.id}" path="${doc.path}" title="${doc.title}" />`;
}

export function resolveWorkflowPromptText(id: string): string {
  const contract = resolveWorkflowPromptContract(id);
  if (contract.associatedDocs === undefined || contract.associatedDocs.length === 0) {
    return contract.promptText;
  }

  if (MATT_POCOCK_SKILL_IDS.has(contract.id)) {
    const docs = contract.associatedDocs
      .map(
        (doc) => `<skill-doc id="${doc.id}" path="${doc.path}">
${doc.content}
</skill-doc>`,
      )
      .join("\n\n");
    return `${contract.promptText}\n\n<supporting-skill-docs>\nThe referenced supporting files are bundled below for this Build invocation.\n${docs}\n</supporting-skill-docs>`;
  }

  const docs = contract.associatedDocs.map(renderAssociatedDocReference).join("\n");
  return `${contract.promptText}\n\n<available-workflow-docs>\nLoad a supporting document only when relevant by calling workflow_doc_get with its id.\n${docs}\n</available-workflow-docs>`;
}

/**
 * Renders the resolved workflow prompt as a delimited block for embedding into the persisted user
 * message of a workflow sub-step turn. The body is byte-identical to the text injected via the
 * system channel (`resolveWorkflowSystemInstructions`), so a stale prompt is visible in the thread.
 */
export function buildWorkflowSkillCommandSection(
  workflowPromptId: string | null | undefined,
): string | null {
  if (workflowPromptId == null || !isRegisteredWorkflowPromptId(workflowPromptId)) {
    return null;
  }
  const contract = resolveWorkflowPromptContract(workflowPromptId);
  return `<workflow-skill id="${contract.id}" title="${contract.title}">
${resolveWorkflowPromptText(workflowPromptId)}
</workflow-skill>`;
}

export function appendWorkflowSkillCommandSection(
  promptText: string,
  workflowPromptId: string | null | undefined,
): string {
  const section = buildWorkflowSkillCommandSection(workflowPromptId);
  return section === null ? promptText : `${promptText}\n\n${section}`;
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
    return undefined;
  }
  return resolveWorkflowPromptText(workflowPromptId);
}

export function isWorkflowInteractionMode(
  mode: ProviderInteractionMode | null | undefined,
): boolean {
  return isPlanningWorkflowInteractionMode(mode) || mode === "implementation-workflow";
}
