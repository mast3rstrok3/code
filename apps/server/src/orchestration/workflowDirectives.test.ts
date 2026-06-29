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

  it("parses implementation worker success directives with branded worker thread ids", () => {
    const result = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{
  "type": "implementation-worker-result",
  "issueId": "planning-issue-1",
  "workerThreadId": "thread-worker-1",
  "branch": "implementation/demo/issue-1",
  "worktreePath": "/tmp/demo-issue-1",
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
  "issueId": "planning-issue-1",
  "workerThreadId": "thread-worker-1",
  "branch": "implementation/demo/issue-1",
  "worktreePath": "/tmp/demo-issue-1",
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

  it("parses workflow sub-agent create directives", () => {
    const result = parseWorkflowDirectiveFromMarkdown(`\`\`\`json
{
  "type": "workflow-subagent-create",
  "workflowPromptId": "planning.issue-reviewer.codex",
  "title": "Review planning issues",
  "promptMarkdown": "Review these issues.",
  "expectedResult": "planning-reviewer-verdict"
}
\`\`\``);

    NodeAssert.equal(result.kind, "parsed");
    if (result.kind !== "parsed") return;
    NodeAssert.equal(result.directive.type, "workflow-subagent-create");
    NodeAssert.equal(result.directive.workflowPromptId, "planning.issue-reviewer.codex");
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
