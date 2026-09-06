# Grill with Docs

The user's submitted prompt is the subject of this Grill with Docs session. Start directly with repository grounding and the unresolved design frontier; do not ask the user to choose a grill type first.

Treat scope instructions in the user's prompt as authoritative. For example, if the user asks for product questions only, do not ask engineering questions. If the user supplies a question or round limit, respect that limit, resolve remaining discoverable decisions from the repository, and clearly record any assumptions before continuing. Without an explicit constraint, apply the complete product, engineering, and domain design tree below.

Use the structured question tool only for substantive grill questions and the final shared-understanding confirmation. Do not spend a question on selecting Product Grill versus Engineering Grill.

## T3 structured-question adapter

Use T3's `workflow_request_user_input` tool for every interview round and for the final shared-understanding confirmation. Do not duplicate or summarize structured questions, choices, or recommendations in Markdown before or after the tool call.

The tool is registered on this thread. Providers that reach T3 over MCP see it as `mcp__t3-code__workflow_request_user_input`; load it by name through tool search if it is not already listed. It is the only question tool the grill uses. Never substitute a provider's own smaller question tool while it is available.

When Code Mode calls workflow_request_user_input, keep its returned answers visible to the model by passing the complete result to the outer text(result) helper, for example: const result = await tools.workflow_request_user_input(...); text(result). Dynamic tool results use contentItems, not result.content; never discard or selectively read the returned value.

Recompute the currently unblocked frontier before every round. When it contains one through ten questions, submit the entire frontier at its natural size. Ten is a maximum, never a target: do not aim for three, ten, or any other fixed batch size, and do not pad a round. If more than ten questions are independently ready, send the first ten in stable design-tree order and continue with the remainder after those answers resolve. Never put questions in the same call when one answer depends on another question in that call.

A result of `status: "waiting"` is not an answer and not a refusal: the user is still reading. Call `workflow_request_user_input` again immediately with the same questions and the `resumeRequestId` it returned, and keep doing that for as long as the user takes. Never rephrase the round, open a second card, or move on because a round came back waiting.

Treat every answer returned by `workflow_request_user_input` as settled. Never repeat its question or the previously answered frontier unless the user explicitly reopens or contradicts that decision. When a custom answer needs clarification, ask only the narrower unresolved clarification instead of replaying the original question batch.

Each question must have:

- A compact header.
- Two or three meaningful, mutually exclusive choices.
- A neutral, useful impact or tradeoff description for every choice.
- Exactly one separate recommendation object naming one option by its unchanged label and explaining why it is preferred.
- A custom-answer path through T3's existing composer input; do not add a synthetic custom choice.
- Choices in their natural A/B/C order. Never move the recommendation to the first position.

Put recommendation data only in the separate `{ optionLabel, rationale }` object. Do not append `(Recommended)` to an option label, do not replace or prefix an option description with `Why that?`, and do not reorder options to surface the recommendation.

When the frontier is empty, use one `workflow_request_user_input` question for the final shared-understanding confirmation. Offer two choices equivalent to `Lock it in` and `Keep grilling`, recommend `Lock it in` in the separate recommendation object, and follow every rule above. Only that structured response may lock or continue the grill.

Compatibility fallback: if and only if `workflow_request_user_input` is unavailable on this provider thread, use the provider's native question tool (Codex `request_user_input`, Claude `AskUserQuestion`) in chunks of at most three questions, and put each recommendation in a short Markdown line before the call since those tools carry no recommendation field. Keep option labels and descriptions neutral and unchanged. This fallback exists only for threads that predate T3's workflow tool.

## T3 workflow adapter

Use the complete Grill with Docs skill above. Load its supporting templates through workflow_doc_get immediately before writing a glossary or ADR.

Apply the bundled Grilling and Domain Modeling instructions directly instead of calling a provider-local Skill tool. The T3 structured-question and automation adapters below take precedence over their interview mechanics.

This Planning workflow already owns the current worktree and AppStack. Treat them as the shared runtime workspace for every later Planning and Implementation stage. The stack starts programmatically as soon as repository-declared workspace setup succeeds; do not start a competing development server or use another worktree's stack.

Planning artifact writes during this stage are limited to glossary and ADR updates. Do not make implementation changes. Finish only when the goal, audience, success criteria, scope, non-goals, terminology, decisions, risks, edge cases, failure modes, and acceptance criteria are clear enough for Spec authoring.

Updating domain documentation as decisions crystallize is the only exception to the Grilling blueprint's instruction not to act before confirmation. The frontier-round mechanics remain authoritative.

After the user explicitly confirms shared understanding, end with exactly one fenced JSON block containing { "type": "planning-grill-complete" }. Do not write the Spec in this stage.
