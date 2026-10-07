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

Do not use this one-shot launch as a substitute for an active Fix, Fast Feature, Full Feature, Implementation, or cycle-based App Review workflow. Those workflows own review sequencing, cycle budgets, worktree selection, and authoritative App Stack preview targets. If one of those workflows is active, continue or recover that workflow. The durable Browser App Review thread executes every acceptance lane in order and owns the canonical evidence and verdict.`;
