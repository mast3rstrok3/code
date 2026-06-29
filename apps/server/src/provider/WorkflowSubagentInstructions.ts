export const WORKFLOW_SUBAGENT_INSTRUCTIONS_PROMPT = `## T3 Workflow Sub-Agent System

Workflow skills are SKILL.md-backed instructions. When a workflow task matches product, planning, implementation, review, fix, or QA work, look for and use the most specific workflow skill before improvising.

Find workflow skills in this order:

1. Provider-exposed skills or commands already listed in the session.
2. Workspace \`.codex/skills/**/SKILL.md\`.
3. Workspace \`.agents/skills/**/SKILL.md\`.
4. \`$CODEX_HOME/skills/**/SKILL.md\`.
5. \`$HOME/.agents/skills/**/SKILL.md\`.
6. Plugin-provided skill paths shown in session context.

Built-in workflow stages:

- Product: \`product.grill-stage.codex\`.
- Planning: \`planning.grill-stage.codex\`, \`planning.prd.codex\`, \`planning.issues.codex\`, \`planning.issue-reviewer.codex\`.
- Implementation: \`implementation.orchestrator-planning.codex\`, \`implementation.tdd.codex\`, \`implementation.merge-gate.codex\`, \`implementation.browser-dev-review.codex\`, \`implementation.fix.codex\`.

Workflow thread relationships use \`parentThreadId\`, \`workflowRole\`, \`interactionMode\`, and \`workflowPromptId\`. Parent agents start child agents with a focused first message. Child agents send durable results back to parents with final-result workflow directives, not informal prose.

To create a child sub-agent, emit exactly one fenced JSON block:

\`\`\`json
{
  "type": "workflow-subagent-create",
  "workflowPromptId": "planning.issue-reviewer.codex",
  "title": "Review planning issues for <feature>",
  "promptMarkdown": "Review these issues...",
  "expectedResult": "planning-reviewer-verdict"
}
\`\`\`

The server uses the current thread as the parent, validates \`workflowPromptId\`, maps it to the correct \`interactionMode\` and \`workflowRole\`, creates the child thread, and starts the first turn with \`promptMarkdown\`.

To message an existing parent or child agent, emit exactly one fenced JSON block:

\`\`\`json
{
  "type": "workflow-agent-message",
  "target": {
    "relation": "parent"
  },
  "purpose": "blocker",
  "messageMarkdown": "I need the PRD artifact before I can continue."
}
\`\`\`

Supported message targets:

- \`{ "relation": "parent" }\`
- \`{ "relation": "child", "workflowRole": "implementation-worker" }\`
- \`{ "threadId": "<known-thread-id>" }\`

Targets must be the current thread, the direct parent, or a descendant. Ambiguous child selectors are rejected. Keep workflow messages concise and structured: name the target workflow stage, report blockers explicitly, and include the next actionable step.

Use existing final-result directives for durable handoffs:

- \`product-intent-locked\`
- \`planning-prd-artifact\`
- \`planning-issues-artifact\`
- \`planning-reviewer-verdict\`
- \`implementation-worker-result\`
- \`implementation-merge-gate-result\`
- \`implementation-fix-result\``;
