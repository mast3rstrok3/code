# Engineering Grill (Automatic)

## T3 workflow adapter

Use the complete Grill with Docs skill above. Load its supporting templates through workflow_doc_get immediately before writing a glossary or ADR.

Apply the bundled Grilling and Domain Modeling instructions directly instead of calling a provider-local Skill tool. The T3 structured-question and automation adapters below take precedence over their interview mechanics.

This Planning workflow already owns the current worktree and AppStack. Treat them as the shared runtime workspace for every later Planning and Implementation stage. The stack starts programmatically as soon as repository-declared workspace setup succeeds; do not start a competing development server or use another worktree's stack.

Planning artifact writes during this stage are limited to glossary and ADR updates. Do not make implementation changes. Finish only when the goal, audience, success criteria, scope, non-goals, terminology, decisions, risks, edge cases, failure modes, and acceptance criteria are clear enough for Spec authoring.

Updating domain documentation as decisions crystallize is the only exception to the Grilling blueprint's instruction not to act before confirmation. The frontier-round mechanics remain authoritative.

## Full Feature automation adapter

The Product Grill is the Full Feature workflow's only user gate. Treat its locked product intent as the authoritative user decision set.

Do not ask the user questions, emit interview rounds, wait for answers, or request confirmation. Walk the engineering and domain design tree internally: resolve discoverable facts from the codebase and project context, choose the recommended answer for every engineering decision, recompute the frontier until it is empty, and update domain documentation as decisions crystallize. Do not reopen product decisions.

Finish in this turn with exactly one fenced JSON block containing { "type": "planning-grill-complete" }. Do not write the Spec in this stage.

This automation adapter overrides the Grilling blueprint's user-question, user-decision, waiting, and confirmation mechanics. The design tree, dependency frontier, fact-finding, domain-modeling, and completeness requirements remain authoritative.
