import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { parseWorkflowDirectiveFromMarkdown } from "./workflowDirectives.ts";

describe("workflowDirectives", () => {
  it("parses product intent locked directives", () => {
    const result = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{ "type": "product-intent-locked", "title": "Checkout", "summaryMarkdown": "Locked intent." }
\`\`\``);

    NodeAssert.equal(result.kind, "parsed");
    if (result.kind !== "parsed") return;
    NodeAssert.equal(result.directive.type, "product-intent-locked");
    NodeAssert.equal(result.directive.title, "Checkout");
  });

  it("parses canonical Spec, Ticket, and Ticket review directives", () => {
    const spec = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{ "type": "planning-spec-artifact", "title": "Checkout", "summaryMarkdown": "Build checkout." }
\`\`\``);
    const tickets = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{
  "type": "planning-tickets-artifact",
  "specId": "spec-1",
  "tickets": [{
    "key": "ticket-1",
    "title": "Implement checkout",
    "bodyMarkdown": "Build checkout.",
    "dependencyKeys": []
  }]
}
\`\`\``);
    const review = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{
  "type": "planning-reviewer-verdict",
  "cycleNumber": 1,
  "passed": false,
  "failingPlanningTicketIds": ["planning-ticket-1"],
  "dependencyFeedback": [],
  "perTicketFeedback": [{
    "ticketId": "planning-ticket-1",
    "passed": false,
    "feedbackMarkdown": "Missing validation."
  }]
}
\`\`\``);

    NodeAssert.equal(spec.kind, "parsed");
    NodeAssert.equal(tickets.kind, "parsed");
    NodeAssert.equal(review.kind, "parsed");
  });

  it("rejects legacy planning artifact directives and Ticket fields", () => {
    for (const markdown of [
      `\`\`\`json
{ "type": "planning-prd-artifact", "title": "Checkout", "summaryMarkdown": "Legacy." }
\`\`\``,
      `\`\`\`json
{ "type": "planning-issues-artifact", "prdId": "prd-1", "issues": [] }
\`\`\``,
      `\`\`\`json
{
  "type": "planning-reviewer-verdict",
  "cycleNumber": 1,
  "passed": false,
  "failingPlanningIssueIds": ["planning-issue-1"],
  "dependencyFeedback": [],
  "perIssueFeedback": []
}
\`\`\``,
    ]) {
      NodeAssert.equal(parseWorkflowDirectiveFromMarkdown(markdown).kind, "error");
    }
  });

  it("parses implementation worker success directives with branded worker thread ids", () => {
    const result = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{
  "type": "implementation-worker-result",
  "ticketId": "planning-ticket-1",
  "workerThreadId": "thread-worker-1",
  "branch": "implementation/demo/ticket-1",
  "worktreePath": "/tmp/demo-ticket-1",
  "status": "succeeded",
  "commitSha": "abc123",
  "validations": [
    {
      "command": "vp test",
      "status": "passed",
      "outputMarkdown": "ok",
      "completedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "notesMarkdown": "Done.",
  "reportedAt": "2026-01-01T00:00:01.000Z"
}
\`\`\``);

    NodeAssert.equal(result.kind, "parsed");
    if (result.kind !== "parsed") return;
    NodeAssert.equal(result.directive.type, "implementation-worker-result");
    NodeAssert.equal(result.directive.workerThreadId, "thread-worker-1");
    NodeAssert.equal(result.directive.status, "succeeded");
  });

  it("rejects implementation worker success without commit sha", () => {
    const result = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{
  "type": "implementation-worker-result",
  "ticketId": "planning-ticket-1",
  "workerThreadId": "thread-worker-1",
  "branch": "implementation/demo/ticket-1",
  "worktreePath": "/tmp/demo-ticket-1",
  "status": "succeeded",
  "validations": [],
  "reportedAt": "2026-01-01T00:00:01.000Z"
}
\`\`\``);

    NodeAssert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    NodeAssert.match(result.message, /commitSha is required/);
  });

  it("parses merge-gate and fix directives", () => {
    const mergeGate = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{
  "type": "implementation-merge-gate-result",
  "runId": "implementation-run-1",
  "status": "passed",
  "validations": [],
  "summaryMarkdown": "Merged and checked."
}
\`\`\``);
    const fix = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{
  "type": "implementation-fix-result",
  "runId": "implementation-run-1",
  "status": "succeeded",
  "commitSha": "def456",
  "validations": [],
  "notesMarkdown": "Fixed."
}
\`\`\``);

    NodeAssert.equal(mergeGate.kind, "parsed");
    if (mergeGate.kind === "parsed") {
      NodeAssert.equal(mergeGate.directive.type, "implementation-merge-gate-result");
      NodeAssert.equal(mergeGate.directive.status, "passed");
    }
    NodeAssert.equal(fix.kind, "parsed");
    if (fix.kind === "parsed") {
      NodeAssert.equal(fix.directive.type, "implementation-fix-result");
      NodeAssert.equal(fix.directive.status, "succeeded");
    }
  });

  it("parses code-review result directives", () => {
    const clean = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{
  "type": "implementation-code-review-result",
  "runId": "implementation-run-1",
  "status": "clean",
  "reportMarkdown": "## Standards\\nNo findings.\\n\\n## Spec\\nNo findings."
}
\`\`\``);
    const findings = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{
  "type": "implementation-code-review-result",
  "runId": "implementation-run-1",
  "status": "findings",
  "reportMarkdown": "## Standards\\n- Mysterious Name in checkout.ts"
}
\`\`\``);
    const invalid = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{
  "type": "implementation-code-review-result",
  "runId": "implementation-run-1",
  "status": "passed",
  "reportMarkdown": "report"
}
\`\`\``);

    NodeAssert.equal(clean.kind, "parsed");
    if (clean.kind === "parsed") {
      NodeAssert.equal(clean.directive.type, "implementation-code-review-result");
      NodeAssert.equal(clean.directive.status, "clean");
    }
    NodeAssert.equal(findings.kind, "parsed");
    if (findings.kind === "parsed") {
      NodeAssert.equal(findings.directive.type, "implementation-code-review-result");
      NodeAssert.equal(findings.directive.status, "findings");
    }
    NodeAssert.equal(invalid.kind, "error");
    if (invalid.kind === "error") {
      NodeAssert.match(invalid.message, /must be clean, findings, or blocked/);
    }
  });

  it("parses workflow sub-agent create directives", () => {
    const result = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{
  "type": "workflow-subagent-create",
  "workflowPromptId": "planning.ticket-reviewer.codex",
  "title": "Review planning tickets",
  "promptMarkdown": "Review these tickets.",
  "expectedResult": "planning-reviewer-verdict"
}
\`\`\``);

    NodeAssert.equal(result.kind, "parsed");
    if (result.kind !== "parsed") return;
    NodeAssert.equal(result.directive.type, "workflow-subagent-create");
    NodeAssert.equal(result.directive.workflowPromptId, "planning.ticket-reviewer.codex");
    NodeAssert.equal(result.directive.expectedResult, "planning-reviewer-verdict");
  });

  it("parses workflow agent message directives", () => {
    const result = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{
  "type": "workflow-agent-message",
  "target": {
    "relation": "child",
    "workflowRole": "implementation-worker"
  },
  "purpose": "blocker",
  "messageMarkdown": "Please report current status."
}
\`\`\``);

    NodeAssert.equal(result.kind, "parsed");
    if (result.kind !== "parsed") return;
    NodeAssert.equal(result.directive.type, "workflow-agent-message");
    NodeAssert.equal(result.directive.purpose, "blocker");
    NodeAssert.deepEqual(result.directive.target, {
      relation: "child",
      workflowRole: "implementation-worker",
    });
  });

  it("rejects workflow agent messages with unknown child roles", () => {
    const result = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{
  "type": "workflow-agent-message",
  "target": {
    "relation": "child",
    "workflowRole": "unknown-role"
  },
  "purpose": "blocker",
  "messageMarkdown": "Please report current status."
}
\`\`\``);

    NodeAssert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    NodeAssert.match(result.message, /known workflow role/);
  });
});
