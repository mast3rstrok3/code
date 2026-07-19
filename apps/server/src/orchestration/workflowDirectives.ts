import type {
  OrchestrationImplementationValidationResult,
  OrchestrationImplementationWorkerResult,
  OrchestrationPlanningFileChange,
  OrchestrationThreadWorkflowRole,
} from "@t3tools/contracts";
import { ThreadId } from "@t3tools/contracts";

import { validatePlanningTicketFileChanges } from "./planningTicketFiles.ts";

export type WorkflowAgentMessageTarget =
  | {
      readonly relation: "parent";
    }
  | {
      readonly relation: "child";
      readonly workflowRole: OrchestrationThreadWorkflowRole;
    }
  | {
      readonly threadId: ThreadId;
    };

export type WorkflowDirective =
  | {
      readonly type: "product-intent-locked";
      /** `null` means the directive omitted intentKind — ingestion rejects the lock (fail closed). */
      readonly intentKind: "feature" | "fix" | null;
      readonly title: string;
      readonly summaryMarkdown: string;
    }
  | {
      readonly type: "product-intent-classification-asked";
      readonly recommendedIntentKind: "feature" | "fix" | null;
      readonly questionMarkdown: string;
    }
  | {
      readonly type: "planning-spec-artifact";
      readonly title: string;
      readonly summaryMarkdown: string;
    }
  | {
      readonly type: "planning-tickets-artifact";
      readonly specId: string;
      readonly tickets: ReadonlyArray<{
        readonly key: string;
        readonly title: string;
        readonly bodyMarkdown: string;
        readonly plannedFileChanges: ReadonlyArray<OrchestrationPlanningFileChange>;
        readonly dependencyKeys: ReadonlyArray<string>;
      }>;
    }
  | {
      readonly type: "planning-reviewer-verdict";
      readonly cycleNumber: number;
      readonly mode: "full" | "targeted";
      readonly targetPlanningTicketIds: ReadonlyArray<string>;
      readonly passed: boolean;
      readonly failingPlanningTicketIds: ReadonlyArray<string>;
      readonly dependencyFeedback: ReadonlyArray<string>;
      readonly perTicketFeedback: ReadonlyArray<{
        readonly ticketId: string;
        readonly passed: boolean;
        readonly feedbackMarkdown: string;
      }>;
      readonly ticketEdits: ReadonlyArray<
        | {
            readonly type: "update";
            readonly ticketId: string;
            readonly title?: string;
            readonly bodyMarkdown?: string;
            readonly plannedFileChanges?: ReadonlyArray<OrchestrationPlanningFileChange>;
            readonly dependencyKeys?: ReadonlyArray<string>;
          }
        | {
            readonly type: "create";
            readonly key: string;
            readonly title: string;
            readonly bodyMarkdown: string;
            readonly plannedFileChanges: ReadonlyArray<OrchestrationPlanningFileChange>;
            readonly dependencyKeys: ReadonlyArray<string>;
            readonly replacesPlanningTicketIds: ReadonlyArray<string>;
          }
        | { readonly type: "delete"; readonly ticketId: string }
        | {
            readonly type: "update-dependencies";
            readonly ticketId: string;
            readonly dependencyKeys: ReadonlyArray<string>;
          }
      >;
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
    }
  | {
      readonly type: "implementation-fast-build-result";
      readonly runId: string;
      readonly status: "succeeded" | "failed" | "blocked";
      readonly commitSha?: string;
      readonly validations: ReadonlyArray<OrchestrationImplementationValidationResult>;
      readonly notesMarkdown: string;
    }
  | {
      readonly type: "implementation-code-review-result";
      readonly runId: string;
      readonly status: "clean" | "findings" | "blocked";
      readonly reportMarkdown: string;
    }
  | {
      readonly type: "workflow-subagent-create";
      readonly workflowPromptId: string;
      readonly title: string;
      readonly promptMarkdown: string;
      readonly expectedResult?: string;
      readonly devReviewMode?: "feedback" | "full";
      readonly validationError?: string;
    }
  | {
      readonly type: "workflow-subagents-create";
      readonly children: ReadonlyArray<WorkflowSubagentCreateChild>;
    }
  | {
      readonly type: "workflow-subagent-result";
      readonly status: "completed" | "blocked";
      readonly resultMarkdown: string;
    }
  | {
      readonly type: "workflow-agent-message";
      readonly target: WorkflowAgentMessageTarget;
      readonly purpose: string;
      readonly messageMarkdown: string;
    };

export interface WorkflowSubagentCreateChild {
  readonly workflowPromptId: string;
  readonly title: string;
  readonly promptMarkdown: string;
  readonly expectedResult?: string;
  readonly devReviewMode?: "feedback" | "full";
  /** Child-local validation failures are persisted as rejected batch entries. */
  readonly validationError?: string;
}

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

function parseWorkflowSubagentChild(value: unknown, index?: number): WorkflowSubagentCreateChild {
  const prefix =
    index === undefined
      ? "workflow-subagent-create"
      : `workflow-subagents-create.children[${index}]`;
  const record = asRecord(value);
  if (record === null) {
    return {
      workflowPromptId: "invalid",
      title: `Rejected workflow sub-agent ${index ?? 0}`,
      promptMarkdown: "",
      validationError: `${prefix} must be an object.`,
    };
  }

  const errors: string[] = [];
  const requiredChildString = (key: string, fallback: string): string => {
    const raw = record[key];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      errors.push(`${prefix}.${key} must be a non-empty string.`);
      return fallback;
    }
    return raw.trim();
  };
  const workflowPromptId = requiredChildString("workflowPromptId", "invalid");
  const title = requiredChildString("title", `Rejected workflow sub-agent ${index ?? 0}`);
  const promptMarkdown = requiredChildString("promptMarkdown", "");
  const expectedResultValue = record["expectedResult"];
  const expectedResult =
    expectedResultValue === undefined || expectedResultValue === null
      ? undefined
      : typeof expectedResultValue === "string" && expectedResultValue.trim().length > 0
        ? expectedResultValue.trim()
        : undefined;
  if (
    expectedResultValue !== undefined &&
    expectedResultValue !== null &&
    expectedResult === undefined
  ) {
    errors.push(`${prefix}.expectedResult must be a non-empty string when provided.`);
  }

  const modeValue = record["devReviewMode"];
  const devReviewMode = modeValue === "feedback" || modeValue === "full" ? modeValue : undefined;
  if (modeValue !== undefined && devReviewMode === undefined) {
    errors.push(`${prefix}.devReviewMode must be feedback or full when provided.`);
  }
  if (modeValue !== undefined && workflowPromptId !== "implementation.browser-dev-review.codex") {
    errors.push(`${prefix}.devReviewMode is only valid for Browser Dev Review children.`);
  }

  return {
    workflowPromptId,
    title,
    promptMarkdown,
    ...(expectedResult !== undefined ? { expectedResult } : {}),
    ...(devReviewMode !== undefined ? { devReviewMode } : {}),
    ...(errors.length > 0 ? { validationError: errors.join(" ") } : {}),
  };
}

const WORKFLOW_AGENT_MESSAGE_WORKFLOW_ROLES: ReadonlySet<OrchestrationThreadWorkflowRole> =
  new Set<OrchestrationThreadWorkflowRole>([
    "planning-orchestrator",
    "planning-reviewer",
    "implementation-orchestrator",
    "implementation-worker",
    "implementation-validator",
    "implementation-qa-reviewer",
    "implementation-fixer",
    "implementation-code-reviewer",
  ]);

function parseWorkflowAgentMessageTarget(value: unknown): WorkflowAgentMessageTarget | string {
  const record = asRecord(value);
  if (record === null) {
    return "workflow-agent-message.target must be an object.";
  }

  const threadId = record["threadId"];
  if (threadId !== undefined && threadId !== null) {
    if (typeof threadId !== "string" || threadId.trim().length === 0) {
      return "workflow-agent-message.target.threadId must be a non-empty string.";
    }
    return { threadId: ThreadId.make(threadId.trim()) };
  }

  const relation = record["relation"];
  if (relation === "parent") {
    return { relation };
  }
  if (relation === "child") {
    const workflowRole = record["workflowRole"];
    if (
      typeof workflowRole !== "string" ||
      !WORKFLOW_AGENT_MESSAGE_WORKFLOW_ROLES.has(workflowRole as OrchestrationThreadWorkflowRole)
    ) {
      return "workflow-agent-message.target.workflowRole must be a known workflow role.";
    }
    return {
      relation,
      workflowRole: workflowRole as OrchestrationThreadWorkflowRole,
    };
  }

  return "workflow-agent-message.target must specify relation parent, relation child, or threadId.";
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

function parsePlanningFileChanges(
  value: unknown,
): ReadonlyArray<OrchestrationPlanningFileChange> | string {
  if (!Array.isArray(value)) {
    return "plannedFileChanges must be a non-empty array.";
  }

  const changes: OrchestrationPlanningFileChange[] = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null) return "plannedFileChanges entries must be objects.";
    const filePath = requiredString(record, "path");
    const action = record["action"];
    if (filePath.startsWith("Directive field")) return filePath;
    if (action !== "create" && action !== "update" && action !== "delete") {
      return "plannedFileChanges action must be create, update, or delete.";
    }
    changes.push({ path: filePath, action });
  }

  return validatePlanningTicketFileChanges(changes) ?? changes;
}

function parsePlanningTickets(value: unknown):
  | ReadonlyArray<{
      readonly key: string;
      readonly title: string;
      readonly bodyMarkdown: string;
      readonly plannedFileChanges: ReadonlyArray<OrchestrationPlanningFileChange>;
      readonly dependencyKeys: ReadonlyArray<string>;
    }>
  | string {
  if (!Array.isArray(value)) {
    return "planning-tickets-artifact.tickets must be an array.";
  }
  const tickets = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null) {
      return "planning-tickets-artifact tickets must be objects.";
    }
    const key = requiredString(record, "key");
    const title = requiredString(record, "title");
    const bodyMarkdown = requiredString(record, "bodyMarkdown");
    const plannedFileChanges = parsePlanningFileChanges(record["plannedFileChanges"]);
    const dependencyKeys = stringArray(record["dependencyKeys"] ?? []);
    if (key.startsWith("Directive field")) return key;
    if (title.startsWith("Directive field")) return title;
    if (bodyMarkdown.startsWith("Directive field")) return bodyMarkdown;
    if (typeof plannedFileChanges === "string") return plannedFileChanges;
    if (typeof dependencyKeys === "string") return dependencyKeys;
    tickets.push({ key, title, bodyMarkdown, plannedFileChanges, dependencyKeys });
  }
  return tickets;
}

function parsePerTicketFeedback(value: unknown):
  | ReadonlyArray<{
      readonly ticketId: string;
      readonly passed: boolean;
      readonly feedbackMarkdown: string;
    }>
  | string {
  if (!Array.isArray(value)) {
    return "planning-reviewer-verdict.perTicketFeedback must be an array.";
  }
  const feedbackEntries = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null) {
      return "planning-reviewer-verdict perTicketFeedback entries must be objects.";
    }
    const ticketId = requiredString(record, "ticketId");
    const feedbackMarkdown = requiredString(record, "feedbackMarkdown");
    const passed = record["passed"];
    if (ticketId.startsWith("Directive field")) return ticketId;
    if (feedbackMarkdown.startsWith("Directive field")) return feedbackMarkdown;
    if (typeof passed !== "boolean") {
      return "planning-reviewer-verdict perTicketFeedback.passed must be boolean.";
    }
    feedbackEntries.push({
      ticketId,
      passed,
      feedbackMarkdown,
    });
  }
  return feedbackEntries;
}

function parsePlanningTicketEdits(
  value: unknown,
): Extract<WorkflowDirective, { type: "planning-reviewer-verdict" }>["ticketEdits"] | string {
  if (!Array.isArray(value)) return "planning-reviewer-verdict.ticketEdits must be an array.";
  const edits: Array<Record<string, unknown>> = [];
  for (const entry of value) {
    const record = asRecord(entry);
    if (record === null) return "planning-reviewer-verdict ticket edits must be objects.";
    const type = record["type"];
    if (type === "delete") {
      const ticketId = requiredString(record, "ticketId");
      if (ticketId.startsWith("Directive field")) return ticketId;
      edits.push({ type, ticketId });
      continue;
    }
    if (type === "update-dependencies") {
      const ticketId = requiredString(record, "ticketId");
      const dependencyKeys = stringArray(record["dependencyKeys"] ?? []);
      if (ticketId.startsWith("Directive field")) return ticketId;
      if (typeof dependencyKeys === "string") return dependencyKeys;
      edits.push({ type, ticketId, dependencyKeys });
      continue;
    }
    if (type === "create") {
      const key = requiredString(record, "key");
      const title = requiredString(record, "title");
      const bodyMarkdown = requiredString(record, "bodyMarkdown");
      const plannedFileChanges = parsePlanningFileChanges(record["plannedFileChanges"]);
      const dependencyKeys = stringArray(record["dependencyKeys"] ?? []);
      const replacesPlanningTicketIds = stringArray(record["replacesPlanningTicketIds"] ?? []);
      for (const required of [key, title, bodyMarkdown]) {
        if (required.startsWith("Directive field")) return required;
      }
      if (typeof plannedFileChanges === "string") return plannedFileChanges;
      if (typeof dependencyKeys === "string") return dependencyKeys;
      if (typeof replacesPlanningTicketIds === "string") return replacesPlanningTicketIds;
      edits.push({
        type,
        key,
        title,
        bodyMarkdown,
        plannedFileChanges,
        dependencyKeys,
        replacesPlanningTicketIds,
      });
      continue;
    }
    if (type === "update") {
      const ticketId = requiredString(record, "ticketId");
      const title = optionalString(record, "title");
      const bodyMarkdown = optionalString(record, "bodyMarkdown");
      const plannedFileChanges =
        record["plannedFileChanges"] === undefined
          ? undefined
          : parsePlanningFileChanges(record["plannedFileChanges"]);
      const dependencyKeys =
        record["dependencyKeys"] === undefined ? undefined : stringArray(record["dependencyKeys"]);
      if (ticketId.startsWith("Directive field")) return ticketId;
      if (typeof title === "string" && title.startsWith("Directive field")) return title;
      if (typeof bodyMarkdown === "string" && bodyMarkdown.startsWith("Directive field")) {
        return bodyMarkdown;
      }
      if (typeof plannedFileChanges === "string") return plannedFileChanges;
      if (typeof dependencyKeys === "string") return dependencyKeys;
      edits.push({
        type,
        ticketId,
        ...(title === undefined ? {} : { title }),
        ...(bodyMarkdown === undefined ? {} : { bodyMarkdown }),
        ...(plannedFileChanges === undefined ? {} : { plannedFileChanges }),
        ...(dependencyKeys === undefined ? {} : { dependencyKeys }),
      });
      continue;
    }
    return "planning-reviewer-verdict ticket edit type is invalid.";
  }
  return edits as unknown as Extract<
    WorkflowDirective,
    { type: "planning-reviewer-verdict" }
  >["ticketEdits"];
}

function parseDirectiveRecord(record: Record<string, unknown>): WorkflowDirective | string {
  switch (record["type"]) {
    case "product-intent-locked": {
      const title = requiredString(record, "title");
      const summaryMarkdown = requiredString(record, "summaryMarkdown");
      if (title.startsWith("Directive field")) return title;
      if (summaryMarkdown.startsWith("Directive field")) return summaryMarkdown;
      const rawIntentKind = record["intentKind"];
      if (
        rawIntentKind !== undefined &&
        rawIntentKind !== null &&
        rawIntentKind !== "feature" &&
        rawIntentKind !== "fix"
      ) {
        return 'product-intent-locked.intentKind must be "feature" or "fix" when provided.';
      }
      const intentKind =
        rawIntentKind === "fix" || rawIntentKind === "feature" ? rawIntentKind : null;
      return { type: "product-intent-locked", intentKind, title, summaryMarkdown };
    }
    case "product-intent-classification-asked": {
      const questionMarkdown = requiredString(record, "questionMarkdown");
      if (questionMarkdown.startsWith("Directive field")) return questionMarkdown;
      const rawRecommendedIntentKind = record["recommendedIntentKind"];
      if (
        rawRecommendedIntentKind !== undefined &&
        rawRecommendedIntentKind !== null &&
        rawRecommendedIntentKind !== "feature" &&
        rawRecommendedIntentKind !== "fix"
      ) {
        return 'product-intent-classification-asked.recommendedIntentKind must be "feature" or "fix" when provided.';
      }
      const recommendedIntentKind =
        rawRecommendedIntentKind === "fix" || rawRecommendedIntentKind === "feature"
          ? rawRecommendedIntentKind
          : null;
      return {
        type: "product-intent-classification-asked",
        recommendedIntentKind,
        questionMarkdown,
      };
    }
    case "planning-spec-artifact": {
      const title = requiredString(record, "title");
      const summaryMarkdown = requiredString(record, "summaryMarkdown");
      if (title.startsWith("Directive field")) return title;
      if (summaryMarkdown.startsWith("Directive field")) return summaryMarkdown;
      return { type: "planning-spec-artifact", title, summaryMarkdown };
    }
    case "planning-tickets-artifact": {
      const specId = requiredString(record, "specId");
      const tickets = parsePlanningTickets(record["tickets"]);
      if (specId.startsWith("Directive field")) return specId;
      if (typeof tickets === "string") return tickets;
      return { type: "planning-tickets-artifact", specId, tickets };
    }
    case "planning-reviewer-verdict": {
      if (
        record["failingPlanningIssueIds"] !== undefined ||
        record["perIssueFeedback"] !== undefined
      ) {
        return "planning-reviewer-verdict uses Ticket fields; legacy Issue fields are not accepted.";
      }
      const cycleNumber = record["cycleNumber"];
      const passed = record["passed"];
      const mode = record["mode"] ?? "full";
      if (typeof cycleNumber !== "number" || !Number.isInteger(cycleNumber) || cycleNumber < 1) {
        return "planning-reviewer-verdict.cycleNumber must be a positive integer.";
      }
      if (typeof passed !== "boolean") {
        return "planning-reviewer-verdict.passed must be boolean.";
      }
      if (mode !== "full" && mode !== "targeted") {
        return "planning-reviewer-verdict.mode must be full or targeted.";
      }
      const failingPlanningTicketIds = stringArray(record["failingPlanningTicketIds"] ?? []);
      const targetPlanningTicketIds = stringArray(record["targetPlanningTicketIds"] ?? []);
      const dependencyFeedback = stringArray(record["dependencyFeedback"] ?? []);
      const perTicketFeedback = parsePerTicketFeedback(record["perTicketFeedback"] ?? []);
      const ticketEdits = parsePlanningTicketEdits(record["ticketEdits"] ?? []);
      if (typeof failingPlanningTicketIds === "string") return failingPlanningTicketIds;
      if (typeof dependencyFeedback === "string") return dependencyFeedback;
      if (typeof perTicketFeedback === "string") return perTicketFeedback;
      if (typeof targetPlanningTicketIds === "string") return targetPlanningTicketIds;
      if (typeof ticketEdits === "string") return ticketEdits;
      return {
        type: "planning-reviewer-verdict",
        cycleNumber,
        mode,
        targetPlanningTicketIds,
        passed,
        failingPlanningTicketIds,
        dependencyFeedback,
        perTicketFeedback,
        ticketEdits,
      };
    }
    case "implementation-worker-result": {
      const ticketId = requiredString(record, "ticketId");
      const workerThreadId = requiredString(record, "workerThreadId");
      const branch = requiredString(record, "branch");
      const worktreePath = requiredString(record, "worktreePath");
      const reportedAt = requiredString(record, "reportedAt");
      const status = record["status"];
      const validations = parseValidationResults(record["validations"] ?? []);
      const notesMarkdown = record["notesMarkdown"];
      const commitSha = record["commitSha"];
      for (const value of [ticketId, workerThreadId, branch, worktreePath, reportedAt]) {
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
          ticketId,
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
        ticketId,
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
    case "implementation-fast-build-result": {
      const runId = requiredString(record, "runId");
      const notesMarkdown = requiredString(record, "notesMarkdown");
      const status = record["status"];
      const validations = parseValidationResults(record["validations"] ?? []);
      const commitSha = optionalString(record, "commitSha");
      if (runId.startsWith("Directive field")) return runId;
      if (notesMarkdown.startsWith("Directive field")) return notesMarkdown;
      if (status !== "succeeded" && status !== "failed" && status !== "blocked") {
        return "implementation-fast-build-result.status must be succeeded, failed, or blocked.";
      }
      if (typeof validations === "string") return validations;
      if (typeof commitSha === "string" && commitSha.startsWith("Directive field"))
        return commitSha;
      if (status === "succeeded" && commitSha === undefined) {
        return "implementation-fast-build-result.commitSha is required when status is succeeded.";
      }
      return {
        type: "implementation-fast-build-result",
        runId,
        status,
        ...(commitSha === undefined ? {} : { commitSha }),
        validations,
        notesMarkdown,
      };
    }
    case "implementation-code-review-result": {
      const runId = requiredString(record, "runId");
      const reportMarkdown = requiredString(record, "reportMarkdown");
      const status = record["status"];
      if (runId.startsWith("Directive field")) return runId;
      if (reportMarkdown.startsWith("Directive field")) return reportMarkdown;
      if (status !== "clean" && status !== "findings" && status !== "blocked") {
        return "implementation-code-review-result.status must be clean, findings, or blocked.";
      }
      return {
        type: "implementation-code-review-result",
        runId,
        status,
        reportMarkdown,
      };
    }
    case "workflow-subagent-create": {
      const child = parseWorkflowSubagentChild(record);
      return {
        type: "workflow-subagent-create",
        ...child,
      };
    }
    case "workflow-subagents-create": {
      if (!Array.isArray(record["children"]) || record["children"].length === 0) {
        return "workflow-subagents-create.children must be a non-empty array.";
      }
      return {
        type: "workflow-subagents-create",
        children: record["children"].map((child, index) =>
          parseWorkflowSubagentChild(child, index),
        ),
      };
    }
    case "workflow-subagent-result": {
      const status = record["status"];
      const resultMarkdown = requiredString(record, "resultMarkdown");
      if (status !== "completed" && status !== "blocked") {
        return "workflow-subagent-result.status must be completed or blocked.";
      }
      if (resultMarkdown.startsWith("Directive field")) return resultMarkdown;
      return { type: "workflow-subagent-result", status, resultMarkdown };
    }
    case "workflow-agent-message": {
      const target = parseWorkflowAgentMessageTarget(record["target"]);
      const purpose = requiredString(record, "purpose");
      const messageMarkdown = requiredString(record, "messageMarkdown");
      if (typeof target === "string") return target;
      if (purpose.startsWith("Directive field")) return purpose;
      if (messageMarkdown.startsWith("Directive field")) return messageMarkdown;
      return {
        type: "workflow-agent-message",
        target,
        purpose,
        messageMarkdown,
      };
    }
    case "planning-prd-artifact":
    case "planning-issues-artifact":
      return "Legacy planning artifact directives are not accepted; use Spec and Ticket directives.";
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
