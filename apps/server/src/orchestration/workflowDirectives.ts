import type {
  OrchestrationImplementationValidationResult,
  OrchestrationImplementationWorkerResult,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";

export type WorkflowDirective =
  | {
      readonly type: "product-intent-locked";
      readonly title: string;
      readonly summaryMarkdown: string;
    }
  | {
      readonly type: "planning-prd-artifact";
      readonly title: string;
      readonly summaryMarkdown: string;
    }
  | {
      readonly type: "planning-issues-artifact";
      readonly prdId: string;
      readonly issues: ReadonlyArray<{
        readonly key: string;
        readonly title: string;
        readonly bodyMarkdown: string;
        readonly dependencyKeys: ReadonlyArray<string>;
      }>;
    }
  | {
      readonly type: "planning-reviewer-verdict";
      readonly cycleNumber: number;
      readonly passed: boolean;
      readonly failingPlanningIssueIds: ReadonlyArray<string>;
      readonly dependencyFeedback: ReadonlyArray<string>;
      readonly perIssueFeedback: ReadonlyArray<{
        readonly issueId: string;
        readonly passed: boolean;
        readonly feedbackMarkdown: string;
      }>;
    }
  | (OrchestrationImplementationWorkerResult & {
      readonly type: "implementation-worker-result";
    })
  | {
      readonly type: "implementation-merge-gate-result";
      readonly runId: string;
      readonly status: "passed" | "failed";
      readonly validations: ReadonlyArray<OrchestrationImplementationValidationResult>;
      readonly summaryMarkdown: string;
    }
  | {
      readonly type: "implementation-fix-result";
      readonly runId: string;
      readonly status: "succeeded" | "failed" | "blocked";
      readonly commitSha?: string;
      readonly validations: ReadonlyArray<OrchestrationImplementationValidationResult>;
      readonly notesMarkdown: string;
    };

export type WorkflowDirectiveParseResult =
  | { readonly kind: "none" }
  | { readonly kind: "parsed"; readonly directive: WorkflowDirective }
  | { readonly kind: "error"; readonly message: string };

const JSON_FENCE_PATTERN = /```json\s*([\s\S]*?)```/gi;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : `Directive field '${key}' must be a non-empty string.`;
}

function stringArray(value: unknown): ReadonlyArray<string> | string {
  if (!Array.isArray(value)) {
    return "Directive field must be an array of strings.";
  }
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return "Directive field must be an array of non-empty strings.";
    }
    result.push(entry.trim());
  }
  return result;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined | string {
  const value = record[key];
  if (value === undefined || value === null) {
    return undefined;
  }
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : `Directive field '${key}' must be a non-empty string when provided.`;
}

function parseValidationResults(
  value: unknown,
): ReadonlyArray<OrchestrationImplementationValidationResult> | string {
  if (!Array.isArray(value)) {
    return "implementation validations must be an array.";
  }
  const validations: OrchestrationImplementationValidationResult[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null) {
      return "implementation validation entries must be objects.";
    }
    const command = requiredString(record, "command");
    const completedAt = requiredString(record, "completedAt");
    const status = record["status"];
    if (command.startsWith("Directive field")) return command;
    if (completedAt.startsWith("Directive field")) return completedAt;
    if (status !== "passed" && status !== "failed") {
      return "implementation validation status must be passed or failed.";
    }
    const outputMarkdown = record["outputMarkdown"];
    if (outputMarkdown !== undefined && typeof outputMarkdown !== "string") {
      return "implementation validation outputMarkdown must be a string when provided.";
    }
    validations.push({
      command,
      status,
      outputMarkdown: outputMarkdown ?? "",
      completedAt,
    });
  }
  return validations;
}

function parsePlanningIssues(value: unknown):
  | ReadonlyArray<{
      readonly key: string;
      readonly title: string;
      readonly bodyMarkdown: string;
      readonly dependencyKeys: ReadonlyArray<string>;
    }>
  | string {
  if (!Array.isArray(value)) {
    return "planning-issues-artifact.issues must be an array.";
  }
  const issues = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null) {
      return "planning-issues-artifact issues must be objects.";
    }
    const key = requiredString(record, "key");
    const title = requiredString(record, "title");
    const bodyMarkdown = requiredString(record, "bodyMarkdown");
    const dependencyKeys = stringArray(record["dependencyKeys"] ?? []);
    if (key.startsWith("Directive field")) return key;
    if (title.startsWith("Directive field")) return title;
    if (bodyMarkdown.startsWith("Directive field")) return bodyMarkdown;
    if (typeof dependencyKeys === "string") return dependencyKeys;
    issues.push({ key, title, bodyMarkdown, dependencyKeys });
  }
  return issues;
}

function parsePerIssueFeedback(value: unknown):
  | ReadonlyArray<{
      readonly issueId: string;
      readonly passed: boolean;
      readonly feedbackMarkdown: string;
    }>
  | string {
  if (!Array.isArray(value)) {
    return "planning-reviewer-verdict.perIssueFeedback must be an array.";
  }
  const feedbackEntries = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null) {
      return "planning-reviewer-verdict perIssueFeedback entries must be objects.";
    }
    const issueId = requiredString(record, "issueId");
    const feedbackMarkdown = requiredString(record, "feedbackMarkdown");
    const passed = record["passed"];
    if (issueId.startsWith("Directive field")) return issueId;
    if (feedbackMarkdown.startsWith("Directive field")) return feedbackMarkdown;
    if (typeof passed !== "boolean") {
      return "planning-reviewer-verdict perIssueFeedback.passed must be boolean.";
    }
    feedbackEntries.push({
      issueId,
      passed,
      feedbackMarkdown,
    });
  }
  return feedbackEntries;
}

function parseDirectiveRecord(record: Record<string, unknown>): WorkflowDirective | string {
  switch (record["type"]) {
    case "product-intent-locked": {
      const title = requiredString(record, "title");
      const summaryMarkdown = requiredString(record, "summaryMarkdown");
      if (title.startsWith("Directive field")) return title;
      if (summaryMarkdown.startsWith("Directive field")) return summaryMarkdown;
      return { type: "product-intent-locked", title, summaryMarkdown };
    }
    case "planning-prd-artifact": {
      const title = requiredString(record, "title");
      const summaryMarkdown = requiredString(record, "summaryMarkdown");
      if (title.startsWith("Directive field")) return title;
      if (summaryMarkdown.startsWith("Directive field")) return summaryMarkdown;
      return { type: "planning-prd-artifact", title, summaryMarkdown };
    }
    case "planning-issues-artifact": {
      const prdId = requiredString(record, "prdId");
      const issues = parsePlanningIssues(record["issues"]);
      if (prdId.startsWith("Directive field")) return prdId;
      if (typeof issues === "string") return issues;
      return { type: "planning-issues-artifact", prdId, issues };
    }
    case "planning-reviewer-verdict": {
      const cycleNumber = record["cycleNumber"];
      const passed = record["passed"];
      if (typeof cycleNumber !== "number" || !Number.isInteger(cycleNumber) || cycleNumber < 1) {
        return "planning-reviewer-verdict.cycleNumber must be a positive integer.";
      }
      if (typeof passed !== "boolean") {
        return "planning-reviewer-verdict.passed must be boolean.";
      }
      const failingPlanningIssueIds = stringArray(record["failingPlanningIssueIds"] ?? []);
      const dependencyFeedback = stringArray(record["dependencyFeedback"] ?? []);
      const perIssueFeedback = parsePerIssueFeedback(record["perIssueFeedback"] ?? []);
      if (typeof failingPlanningIssueIds === "string") return failingPlanningIssueIds;
      if (typeof dependencyFeedback === "string") return dependencyFeedback;
      if (typeof perIssueFeedback === "string") return perIssueFeedback;
      return {
        type: "planning-reviewer-verdict",
        cycleNumber,
        passed,
        failingPlanningIssueIds,
        dependencyFeedback,
        perIssueFeedback,
      };
    }
    case "implementation-worker-result": {
      const issueId = requiredString(record, "issueId");
      const workerThreadId = requiredString(record, "workerThreadId");
      const branch = requiredString(record, "branch");
      const worktreePath = requiredString(record, "worktreePath");
      const reportedAt = requiredString(record, "reportedAt");
      const status = record["status"];
      const validations = parseValidationResults(record["validations"] ?? []);
      const notesMarkdown = record["notesMarkdown"];
      const commitSha = record["commitSha"];
      for (const value of [issueId, workerThreadId, branch, worktreePath, reportedAt]) {
        if (value.startsWith("Directive field")) return value;
      }
      if (status !== "succeeded" && status !== "failed") {
        return "implementation-worker-result.status must be succeeded or failed.";
      }
      if (typeof validations === "string") return validations;
      if (notesMarkdown !== undefined && typeof notesMarkdown !== "string") {
        return "implementation-worker-result.notesMarkdown must be a string when provided.";
      }
      if (status === "succeeded") {
        if (typeof commitSha !== "string" || commitSha.trim().length === 0) {
          return "implementation-worker-result.commitSha is required when status is succeeded.";
        }
        return {
          type: "implementation-worker-result",
          issueId,
          workerThreadId: ThreadId.make(workerThreadId),
          branch,
          worktreePath,
          status,
          commitSha: commitSha.trim(),
          validations,
          notesMarkdown: notesMarkdown ?? "",
          reportedAt,
        };
      }
      if (
        commitSha !== undefined &&
        commitSha !== null &&
        (typeof commitSha !== "string" || commitSha.trim().length === 0)
      ) {
        return "implementation-worker-result.commitSha must be a non-empty string or null.";
      }
      return {
        type: "implementation-worker-result",
        issueId,
        workerThreadId: ThreadId.make(workerThreadId),
        branch,
        worktreePath,
        status,
        commitSha: typeof commitSha === "string" ? commitSha.trim() : null,
        validations,
        notesMarkdown: notesMarkdown ?? "",
        reportedAt,
      };
    }
    case "implementation-merge-gate-result": {
      const runId = requiredString(record, "runId");
      const summaryMarkdown = requiredString(record, "summaryMarkdown");
      const status = record["status"];
      const validations = parseValidationResults(record["validations"] ?? []);
      if (runId.startsWith("Directive field")) return runId;
      if (summaryMarkdown.startsWith("Directive field")) return summaryMarkdown;
      if (status !== "passed" && status !== "failed") {
        return "implementation-merge-gate-result.status must be passed or failed.";
      }
      if (typeof validations === "string") return validations;
      return {
        type: "implementation-merge-gate-result",
        runId,
        status,
        validations,
        summaryMarkdown,
      };
    }
    case "implementation-fix-result": {
      const runId = requiredString(record, "runId");
      const notesMarkdown = requiredString(record, "notesMarkdown");
      const status = record["status"];
      const validations = parseValidationResults(record["validations"] ?? []);
      const commitSha = optionalString(record, "commitSha");
      if (runId.startsWith("Directive field")) return runId;
      if (notesMarkdown.startsWith("Directive field")) return notesMarkdown;
      if (status !== "succeeded" && status !== "failed" && status !== "blocked") {
        return "implementation-fix-result.status must be succeeded, failed, or blocked.";
      }
      if (typeof validations === "string") return validations;
      if (typeof commitSha === "string" && commitSha.startsWith("Directive field")) {
        return commitSha;
      }
      return {
        type: "implementation-fix-result",
        runId,
        status,
        ...(commitSha !== undefined ? { commitSha } : {}),
        validations,
        notesMarkdown,
      };
    }
    default:
      return "none";
  }
}

export function parseWorkflowDirectiveFromMarkdown(markdown: string): WorkflowDirectiveParseResult {
  const matches = [...markdown.matchAll(JSON_FENCE_PATTERN)];
  if (matches.length === 0) {
    const trimmed = markdown.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) {
      return { kind: "none" };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      return { kind: "none" };
    }
    const record = asRecord(parsed);
    if (record === null || typeof record["type"] !== "string") {
      return { kind: "none" };
    }
    const directive = parseDirectiveRecord(record);
    if (directive === "none") {
      return { kind: "none" };
    }
    return typeof directive === "string"
      ? { kind: "error", message: directive }
      : { kind: "parsed", directive };
  }
  if (matches.length > 1) {
    return { kind: "error", message: "Workflow directives require exactly one fenced JSON block." };
  }

  const rawJson = matches[0]?.[1]?.trim();
  if (!rawJson) {
    return { kind: "error", message: "Workflow directive JSON block is empty." };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    return { kind: "error", message: "Workflow directive JSON is malformed." };
  }
  const record = asRecord(parsed);
  if (record === null) {
    return { kind: "error", message: "Workflow directive must be a JSON object." };
  }
  const directive = parseDirectiveRecord(record);
  if (directive === "none") {
    return { kind: "none" };
  }
  return typeof directive === "string"
    ? { kind: "error", message: directive }
    : { kind: "parsed", directive };
}
