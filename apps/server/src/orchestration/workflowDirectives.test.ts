import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import { parseWorkflowDirectiveFromMarkdown } from "./workflowDirectives.ts";

describe("workflowDirectives", () => {
  it("parses App Review fixer results with focused validations", () => {
    const result = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{
  "type": "app-review-fix-result",
  "runId": "app-review-workflow-thread-controller",
  "planId": "plan-1",
  "status": "succeeded",
  "commitSha": "abc123",
  "validations": [{
    "command": "vp test run src/checkout.test.ts",
    "status": "passed",
    "outputMarkdown": "ok",
    "completedAt": "2026-01-01T00:00:00.000Z"
  }],
  "notesMarkdown": "Fixed every finding."
}
\`\`\``);

    NodeAssert.equal(result.kind, "parsed");
    if (result.kind !== "parsed") return;
    NodeAssert.equal(result.directive.type, "app-review-fix-result");
  });

  it("parses Wayfinder Map artifacts", () => {
    const result = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{ "type": "wayfinder-map-artifact", "title": "Remote roadmap", "summaryMarkdown": "## Destination\\nShip remote workflows" }
\`\`\``);

    NodeAssert.equal(result.kind, "parsed");
    if (result.kind !== "parsed" || result.directive.type !== "wayfinder-map-artifact") return;
    NodeAssert.equal(result.directive.title, "Remote roadmap");
    NodeAssert.equal(result.directive.summaryMarkdown, "## Destination\nShip remote workflows");
  });

  it("parses product intent locked directives without an intent kind as null (fail closed)", () => {
    const result = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{ "type": "product-intent-locked", "title": "Checkout", "summaryMarkdown": "Locked intent." }
\`\`\``);

    NodeAssert.equal(result.kind, "parsed");
    if (result.kind !== "parsed") return;
    NodeAssert.equal(result.directive.type, "product-intent-locked");
    NodeAssert.equal(result.directive.title, "Checkout");
    if (result.directive.type !== "product-intent-locked") return;
    NodeAssert.equal(result.directive.intentKind, null);
  });

  it("parses product intent locked directives with a feature intent kind", () => {
    const result = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{ "type": "product-intent-locked", "intentKind": "feature", "title": "Checkout", "summaryMarkdown": "Locked intent." }
\`\`\``);

    NodeAssert.equal(result.kind, "parsed");
    if (result.kind !== "parsed") return;
    if (result.directive.type !== "product-intent-locked") return;
    NodeAssert.equal(result.directive.intentKind, "feature");
  });

  it("parses product intent locked directives with a fix intent kind", () => {
    const result = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{ "type": "product-intent-locked", "intentKind": "fix", "title": "Checkout", "summaryMarkdown": "Locked intent." }
\`\`\``);

    NodeAssert.equal(result.kind, "parsed");
    if (result.kind !== "parsed") return;
    if (result.directive.type !== "product-intent-locked") return;
    NodeAssert.equal(result.directive.intentKind, "fix");
  });

  it("rejects product intent locked directives with an invalid intent kind", () => {
    const result = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{ "type": "product-intent-locked", "intentKind": "refactor", "title": "Checkout", "summaryMarkdown": "Locked intent." }
\`\`\``);

    NodeAssert.equal(result.kind, "error");
    if (result.kind !== "error") return;
    NodeAssert.equal(
      result.message,
      'product-intent-locked.intentKind must be "feature" or "fix" when provided.',
    );
  });

  it("parses planning grill complete directives", () => {
    const result = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{ "type": "planning-grill-complete" }
\`\`\``);

    NodeAssert.equal(result.kind, "parsed");
    if (result.kind !== "parsed") return;
    NodeAssert.deepEqual(result.directive, { type: "planning-grill-complete" });
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
    "plannedFileChanges": [
      { "path": "src/checkout.ts", "action": "create" },
      { "path": "src/cart.ts", "action": "update" },
      { "path": "src/legacy.ts", "action": "delete" }
    ],
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

  it("rejects missing, empty, duplicate, and non-relative planned ticket files", () => {
    for (const plannedFileChanges of [
      undefined,
      [],
      [
        { path: "src/file.ts", action: "update" },
        { path: "src/file.ts", action: "delete" },
      ],
      [{ path: "/src/file.ts", action: "update" }],
      [{ path: "src/../file.ts", action: "update" }],
      [{ path: "src\\file.ts", action: "update" }],
      [{ path: "src/", action: "update" }],
      [{ path: "src/*.ts", action: "update" }],
    ]) {
      const ticket = {
        key: "ticket-1",
        title: "Implement checkout",
        bodyMarkdown: "Build checkout.",
        dependencyKeys: [],
        ...(plannedFileChanges === undefined ? {} : { plannedFileChanges }),
      };
      const result = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
${JSON.stringify({ type: "planning-tickets-artifact", specId: "spec-1", tickets: [ticket] })}
\`\`\``);
      NodeAssert.equal(result.kind, "error");
    }
  });

  it("requires planned files for reviewer-created tickets and accepts replacement updates", () => {
    const missing = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
${JSON.stringify({
  type: "planning-reviewer-verdict",
  cycleNumber: 1,
  passed: false,
  ticketEdits: [
    {
      type: "create",
      key: "TICKET-2",
      title: "Add tests",
      bodyMarkdown: "Add coverage.",
      dependencyKeys: [],
      replacesPlanningTicketIds: [],
    },
  ],
})}
\`\`\``);
    NodeAssert.equal(missing.kind, "error");

    const update = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
${JSON.stringify({
  type: "planning-reviewer-verdict",
  cycleNumber: 1,
  passed: false,
  ticketEdits: [
    {
      type: "update",
      ticketId: "planning-ticket-1",
      plannedFileChanges: [{ path: "src/checkout.test.ts", action: "update" }],
    },
  ],
})}
\`\`\``);
    NodeAssert.equal(update.kind, "parsed");
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
  "branch": "implementation/demo-ticket-1",
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
  "branch": "implementation/demo-ticket-1",
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
  "commitSha": "cafe1234",
  "validations": [
    {
      "command": "vp check",
      "status": "passed",
      "outputMarkdown": "ok",
      "completedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "reportMarkdown": "## Standards\\n- Mysterious Name in checkout.ts"
}
\`\`\``);
    const findingsWithoutCommit = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
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
      if (clean.directive.type === "implementation-code-review-result") {
        NodeAssert.equal(clean.directive.commitSha, undefined);
        NodeAssert.deepEqual(clean.directive.validations, []);
      }
    }
    NodeAssert.equal(findings.kind, "parsed");
    if (findings.kind === "parsed") {
      NodeAssert.equal(findings.directive.type, "implementation-code-review-result");
      NodeAssert.equal(findings.directive.status, "findings");
      if (findings.directive.type === "implementation-code-review-result") {
        NodeAssert.equal(findings.directive.commitSha, "cafe1234");
        NodeAssert.equal(findings.directive.validations.length, 1);
      }
    }
    NodeAssert.equal(findingsWithoutCommit.kind, "error");
    if (findingsWithoutCommit.kind === "error") {
      NodeAssert.match(
        findingsWithoutCommit.message,
        /commitSha is required when status is findings/,
      );
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

  it("parses an unbounded workflow sub-agent batch without truncating invalid siblings", () => {
    const children = Array.from({ length: 50 }, (_, index) =>
      index === 17
        ? { title: "Invalid child", promptMarkdown: "Missing a workflow prompt." }
        : {
            workflowPromptId: "implementation.browser-app-review.codex",
            title: `Browser reviewer ${index}`,
            promptMarkdown: `Review browser concern ${index}.`,
            appReviewMode: index % 2 === 0 ? "feedback" : "full",
          },
    );
    const result = parseWorkflowDirectiveFromMarkdown(
      `\`\`\`json\n${JSON.stringify({ type: "workflow-subagents-create", children })}\n\`\`\``,
    );

    NodeAssert.equal(result.kind, "parsed");
    if (result.kind !== "parsed" || result.directive.type !== "workflow-subagents-create") return;
    NodeAssert.equal(result.directive.children.length, 50);
    NodeAssert.match(result.directive.children[17]?.validationError ?? "", /workflowPromptId/);
    NodeAssert.equal(result.directive.children[49]?.appReviewMode, "full");
  });

  it("parses focused workflow sub-agent results", () => {
    const result = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{
  "type": "workflow-subagent-result",
  "status": "blocked",
  "resultMarkdown": "The preview server is unavailable."
}
\`\`\``);
    NodeAssert.equal(result.kind, "parsed");
    if (result.kind !== "parsed" || result.directive.type !== "workflow-subagent-result") return;
    NodeAssert.equal(result.directive.status, "blocked");
  });

  it("normalizes structured focused results that use summary fields", () => {
    const result = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{
  "type": "workflow-subagent-result",
  "status": "blocked",
  "summary": "Authentication blocked the browser review.",
  "blockers": ["No seeded reviewer account was available."],
  "recommendations": ["Provide an authenticated feature URL."]
}
\`\`\``);

    NodeAssert.equal(result.kind, "parsed");
    if (result.kind !== "parsed" || result.directive.type !== "workflow-subagent-result") return;
    NodeAssert.match(result.directive.resultMarkdown, /Authentication blocked/);
    NodeAssert.match(result.directive.resultMarkdown, /seeded reviewer account/);
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
