export const BROWSER_APP_REVIEW_LAUNCH_DIRECTIVE_INSTRUCTIONS = `## Browser AppReview Launch

If the user explicitly asks to run or launch a Browser AppReview for the current thread, create a browser review sub-agent by emitting exactly one fenced JSON block:

\`\`\`json
{
  "type": "workflow-subagent-create",
  "workflowPromptId": "implementation.browser-app-review.codex",
  "title": "Browser App Review",
  "promptMarkdown": "Review the current thread in the browser. Include any concrete focus from the user's request.",
  "appReviewMode": "feedback"
}
\`\`\`

The default \`feedback\` mode creates an ordinary Browser App Review child without a durable App Review record or evidence requirement. Use \`"appReviewMode": "full"\` only when a structured durable review with recording, screenshots, checks, findings, and verdict is explicitly required. Do not perform browser automation in the parent thread.

Do not use this one-shot launch as a substitute for an active Fix, Fast Feature, Full Feature, Implementation, or cycle-based App Review workflow. Those workflows own review sequencing, cycle budgets, worktree selection, and authoritative App Dev Stack preview targets. If one of those workflows is active, continue or recover that workflow instead of spawning an ad hoc Browser App Review child.

Exception: a thread already acting as an \`implementation-qa-reviewer\` or \`app-review-reviewer\` owns the durable Browser App Review. It may launch feedback-mode Browser App Review children only when an active workflow's App Review topology assigns independent browser lanes. Those children share the authoritative preview target, return observations only, and must not capture durable evidence or repair the worktree. The parent must use its linked preview_* and app_review_* tools for canonical evidence and the verdict. The server rejects nested full-mode App Reviews.`;

export const WORKFLOW_SUBAGENT_INSTRUCTIONS_PROMPT = `## T3 Workflow Sub-Agent System

Workflow skills are SKILL.md-backed instructions. When a workflow task matches product, planning, implementation, review, fix, or QA work, look for and use the most specific workflow skill before improvising.

Find workflow skills in this order:

1. Provider-exposed skills or commands already listed in the session.
2. Workspace \`.codex/skills/**/SKILL.md\`.
3. Workspace \`.agents/skills/**/SKILL.md\`.
4. \`$CODEX_HOME/skills/**/SKILL.md\`.
5. \`$HOME/.agents/skills/**/SKILL.md\`.
6. Plugin-provided skill paths shown in session context.

The shared \`shared.grilling.codex\` primitive is composed into the Product and Engineering grills; it is not launched as a standalone workflow child.

Built-in workflow stages:

- Product: \`product.fix.codex\`, \`product.fast-feature.codex\`, \`product.full-feature.codex\`.
- Planning: \`planning.grill-stage.codex\` (interactive), \`planning.engineering-grill-automatic.codex\` (Full Feature automation), \`planning.domain-modeling.codex\`, \`planning.wayfinder.codex\`, \`planning.research.codex\`, \`planning.prototype.codex\`, \`planning.spec.codex\`, \`planning.tickets.codex\`, \`planning.ticket-reviewer.codex\`.
- Implementation: \`implementation.orchestrator-planning.codex\`, \`implementation.tdd.codex\`, \`implementation.merge-gate.codex\`, \`implementation.browser-app-review.codex\`, \`implementation.fix.codex\`, \`implementation.code-review.codex\`.

Workflow thread relationships use \`parentThreadId\`, \`workflowRole\`, \`interactionMode\`, and \`workflowPromptId\`. Parent agents start child agents with a focused first message. Child agents send durable results back to parents with final-result workflow directives, not informal prose.

Workflow prompts carry artifact identifiers and ticket scope, not copied artifact bodies. Use the read-only \`workflow_context_get\`, \`workflow_spec_get\`, \`workflow_wayfinder_map_get\`, \`workflow_tickets_list\`, \`workflow_ticket_get\`, \`workflow_app_reviews_list\`, \`workflow_app_review_get\`, and \`workflow_doc_get\` tools to retrieve canonical workflow artifacts and supporting documents on demand. Never treat prompt text as a writable artifact copy.

To create a child sub-agent, emit exactly one fenced JSON block:

\`\`\`json
{
  "type": "workflow-subagent-create",
  "workflowPromptId": "planning.ticket-reviewer.codex",
  "title": "Review planning tickets for <feature>",
  "promptMarkdown": "Review these tickets...",
  "expectedResult": "planning-reviewer-verdict"
}
\`\`\`

The server uses the current thread as the parent, validates \`workflowPromptId\`, maps it to the correct \`interactionMode\` and \`workflowRole\`, creates the child thread, and starts the first turn with \`promptMarkdown\`.

To launch any number of children concurrently, use one \`workflow-subagents-create\` directive with a non-empty \`children\` array. There is no application child-count or nesting-depth limit. Children settle independently and the parent receives one ordered aggregate after all children are terminal.

${BROWSER_APP_REVIEW_LAUNCH_DIRECTIVE_INSTRUCTIONS}

To message an existing parent or child agent, emit exactly one fenced JSON block:

\`\`\`json
{
  "type": "workflow-agent-message",
  "target": {
    "relation": "parent"
  },
  "purpose": "blocker",
  "messageMarkdown": "I need the Spec artifact before I can continue."
}
\`\`\`

Supported message targets:

- \`{ "relation": "parent" }\`
- \`{ "relation": "child", "workflowRole": "implementation-worker" }\`
- \`{ "threadId": "<known-thread-id>" }\`

Targets must be the current thread, the direct parent, or a descendant. Ambiguous child selectors are rejected. Keep workflow messages concise and structured: name the target workflow stage, report blockers explicitly, and include the next actionable step.

Use existing final-result directives for durable handoffs:

- \`product-intent-locked\`
- \`planning-spec-artifact\`
- \`wayfinder-map-artifact\`
- \`planning-tickets-artifact\`
- \`planning-reviewer-verdict\`
- \`implementation-worker-result\`
- \`implementation-merge-gate-result\`
- \`app-review-document\`
- \`app-review-repair-tickets\`
- \`implementation-fix-result\`
- \`app-review-fix-result\`
- \`implementation-code-review-result\`
- \`implementation-change-request-babysit-result\`
- \`workflow-subagent-result\` for focused feedback children.`;
