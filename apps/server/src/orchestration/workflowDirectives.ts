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
      readonly type: "planning-grill-complete";
    }
  | {
      readonly type: "planning-spec-artifact";
      readonly title: string;
      readonly summaryMarkdown: string;
    }
  | {
      readonly type: "wayfinder-map-artifact";
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
        readonly appReviewEligible: boolean;
        readonly appReviewScope?: "e2e" | "browser" | "both";
        readonly appReviewPlanMarkdown: string | null;
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
            readonly appReviewEligible?: boolean;
            readonly appReviewScope?: "e2e" | "browser" | "both";
            readonly appReviewPlanMarkdown?: string | null;
          }
        | {
            readonly type: "create";
            readonly key: string;
            readonly title: string;
            readonly bodyMarkdown: string;
            readonly plannedFileChanges: ReadonlyArray<OrchestrationPlanningFileChange>;
            readonly dependencyKeys: ReadonlyArray<string>;
            readonly appReviewEligible: boolean;
            readonly appReviewScope?: "e2e" | "browser" | "both";
            readonly appReviewPlanMarkdown: string | null;
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
      readonly type: "app-review-repair-tickets";
      readonly runId: string;
      readonly cycleNumber: number;
      readonly tickets: ReadonlyArray<{
        readonly key: string;
        readonly parentTicketKey: string | null;
        readonly title: string;
        readonly bodyMarkdown: string;
        readonly dependencyKeys: ReadonlyArray<string>;
      }>;
    }
  | {
      readonly type: "app-review-fix-result";
      readonly runId: string;
      readonly planId: string;
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
      readonly ticketId?: string;
      readonly status: "clean" | "findings" | "blocked";
      readonly commitSha?: string;
      readonly validations: ReadonlyArray<OrchestrationImplementationValidationResult>;
      readonly reportMarkdown: string;
    }
  | {
      readonly type: "implementation-change-request-babysit-result";
      readonly runId: string;
      readonly status: "passed" | "blocked";
      readonly headSha: string;
      readonly summaryMarkdown: string;
    }
  | {
      readonly type: "workflow-subagent-create";
      readonly workflowPromptId: string;
      readonly title: string;
      readonly promptMarkdown: string;
      readonly expectedResult?: string;
      readonly appReviewMode?: "feedback" | "full";
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
  readonly appReviewMode?: "feedback" | "full";
  /** Child-local validation failures are persisted as rejected batch entries. */
  readonly validationError?: string;
}

export type WorkflowDirectiveParseResult =
  | { readonly kind: "none" }
  | { readonly kind: "parsed"; readonly directive: WorkflowDirective }
  | { readonly kind: "error"; readonly message: string };

/**
 * Extracts the contents of each ```json fence. Directive string fields may themselves contain
 * fenced code samples, so a block closes at the first subsequent ``` whose accumulated content
 * parses as JSON; when none does, it closes at the first ``` so malformed blocks still surface
 * one at a time. An opener with no closing fence is ignored, matching the lazy-regex behavior
 * this replaces.
 */
function extractJsonFenceBlocks(markdown: string): ReadonlyArray<string> {
  const blocks: string[] = [];
  const opener = /```json\s*/gi;
  for (let open = opener.exec(markdown); open !== null; open = opener.exec(markdown)) {
    const contentStart = open.index + open[0].length;
    const firstFence = markdown.indexOf("```", contentStart);
    if (firstFence === -1) {
      break;
    }
    let closer = -1;
    for (let at = firstFence; at !== -1; at = markdown.indexOf("```", at + 3)) {
      try {
        JSON.parse(markdown.slice(contentStart, at));
        closer = at;
        break;
      } catch {
        // Keep extending to the next fence; the ``` we hit may sit inside a JSON string.
      }
    }
    const end = closer === -1 ? firstFence : closer;
    blocks.push(markdown.slice(contentStart, end).trim());
    opener.lastIndex = end + 3;
  }
  return blocks;
}

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

function workflowSubagentResultMarkdown(record: Record<string, unknown>): string {
  const explicit = requiredString(record, "resultMarkdown");
  if (!explicit.startsWith("Directive field")) return explicit;

  const summary = requiredString(record, "summary");
  if (summary.startsWith("Directive field")) return explicit;

  const detail = Object.fromEntries(
    Object.entries(record).filter(
      ([key]) => key !== "type" && key !== "status" && key !== "summary",
    ),
  );
  return Object.keys(detail).length === 0
    ? summary
    : `${summary}\n\n\`\`\`json\n${JSON.stringify(detail, null, 2)}\n\`\`\``;
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

  const modeValue = record["appReviewMode"];
  const appReviewMode = modeValue === "feedback" || modeValue === "full" ? modeValue : undefined;
  if (modeValue !== undefined && appReviewMode === undefined) {
    errors.push(`${prefix}.appReviewMode must be feedback or full when provided.`);
  }
  if (modeValue !== undefined && workflowPromptId !== "implementation.browser-app-review.codex") {
    errors.push(`${prefix}.appReviewMode is only valid for Browser App Review children.`);
  }

  return {
    workflowPromptId,
    title,
    promptMarkdown,
    ...(expectedResult !== undefined ? { expectedResult } : {}),
    ...(appReviewMode !== undefined ? { appReviewMode } : {}),
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
    "implementation-change-request-babysitter",
    "app-review-orchestrator",
    "app-review-reviewer",
    "app-review-fixer",
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

const APP_REVIEW_SCOPES = ["e2e", "browser", "both"] as const;
type ParsedAppReviewScope = (typeof APP_REVIEW_SCOPES)[number];

function isAppReviewScope(value: unknown): value is ParsedAppReviewScope {
  return APP_REVIEW_SCOPES.includes(value as ParsedAppReviewScope);
}

function parsePlanningTickets(value: unknown):
  | ReadonlyArray<{
      readonly key: string;
      readonly title: string;
      readonly bodyMarkdown: string;
      readonly plannedFileChanges: ReadonlyArray<OrchestrationPlanningFileChange>;
      readonly dependencyKeys: ReadonlyArray<string>;
      readonly appReviewEligible: boolean;
      readonly appReviewScope?: ParsedAppReviewScope;
      readonly appReviewPlanMarkdown: string | null;
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
    const appReviewEligible = record["appReviewEligible"] ?? false;
    const rawAppReviewPlanMarkdown = record["appReviewPlanMarkdown"] ?? null;
    if (key.startsWith("Directive field")) return key;
    if (title.startsWith("Directive field")) return title;
    if (bodyMarkdown.startsWith("Directive field")) return bodyMarkdown;
    if (typeof plannedFileChanges === "string") return plannedFileChanges;
    if (typeof dependencyKeys === "string") return dependencyKeys;
    if (typeof appReviewEligible !== "boolean") {
      return "planning-tickets-artifact appReviewEligible must be boolean.";
    }
    if (rawAppReviewPlanMarkdown !== null && typeof rawAppReviewPlanMarkdown !== "string") {
      return "planning-tickets-artifact appReviewPlanMarkdown must be a non-empty string or null.";
    }
    const appReviewPlanMarkdown =
      typeof rawAppReviewPlanMarkdown === "string" &&
      rawAppReviewPlanMarkdown.trim().length === 0 &&
      !appReviewEligible
        ? null
        : rawAppReviewPlanMarkdown;
    if (typeof appReviewPlanMarkdown === "string" && appReviewPlanMarkdown.trim().length === 0) {
      return "planning-tickets-artifact appReviewPlanMarkdown must be a non-empty string or null.";
    }
    if (appReviewEligible && appReviewPlanMarkdown === null) {
      return "planning-tickets-artifact App Review eligible tickets require appReviewPlanMarkdown.";
    }
    const appReviewScope = record["appReviewScope"];
    if (appReviewScope !== undefined && !isAppReviewScope(appReviewScope)) {
      return "planning-tickets-artifact appReviewScope must be 'e2e', 'browser', or 'both'.";
    }
    if (appReviewScope !== undefined && !appReviewEligible) {
      return "planning-tickets-artifact appReviewScope requires appReviewEligible.";
    }
    tickets.push({
      key,
      title,
      bodyMarkdown,
      plannedFileChanges,
      dependencyKeys,
      appReviewEligible,
      ...(appReviewScope === undefined ? {} : { appReviewScope }),
      appReviewPlanMarkdown,
    });
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
      const appReviewEligible = record["appReviewEligible"] ?? false;
      const appReviewPlanMarkdown = record["appReviewPlanMarkdown"] ?? null;
      for (const required of [key, title, bodyMarkdown]) {
        if (required.startsWith("Directive field")) return required;
      }
      if (typeof plannedFileChanges === "string") return plannedFileChanges;
      if (typeof dependencyKeys === "string") return dependencyKeys;
      if (typeof replacesPlanningTicketIds === "string") return replacesPlanningTicketIds;
      if (typeof appReviewEligible !== "boolean")
        return "ticket edit appReviewEligible must be boolean.";
      if (
        appReviewPlanMarkdown !== null &&
        (typeof appReviewPlanMarkdown !== "string" || appReviewPlanMarkdown.trim().length === 0)
      )
        return "ticket edit appReviewPlanMarkdown must be a non-empty string or null.";
      if (appReviewEligible && appReviewPlanMarkdown === null)
        return "App Review eligible ticket edits require appReviewPlanMarkdown.";
      const appReviewScope = record["appReviewScope"];
      if (appReviewScope !== undefined && !isAppReviewScope(appReviewScope))
        return "ticket edit appReviewScope must be 'e2e', 'browser', or 'both'.";
      if (appReviewScope !== undefined && !appReviewEligible)
        return "ticket edit appReviewScope requires appReviewEligible.";
      edits.push({
        type,
        key,
        title,
        bodyMarkdown,
        plannedFileChanges,
        dependencyKeys,
        replacesPlanningTicketIds,
        appReviewEligible,
        ...(appReviewScope === undefined ? {} : { appReviewScope }),
        appReviewPlanMarkdown,
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
      const appReviewEligible = record["appReviewEligible"];
      const appReviewPlanMarkdown = record["appReviewPlanMarkdown"];
      if (ticketId.startsWith("Directive field")) return ticketId;
      if (typeof title === "string" && title.startsWith("Directive field")) return title;
      if (typeof bodyMarkdown === "string" && bodyMarkdown.startsWith("Directive field")) {
        return bodyMarkdown;
      }
      if (typeof plannedFileChanges === "string") return plannedFileChanges;
      if (typeof dependencyKeys === "string") return dependencyKeys;
      if (appReviewEligible !== undefined && typeof appReviewEligible !== "boolean")
        return "ticket edit appReviewEligible must be boolean.";
      if (
        appReviewPlanMarkdown !== undefined &&
        appReviewPlanMarkdown !== null &&
        (typeof appReviewPlanMarkdown !== "string" || appReviewPlanMarkdown.trim().length === 0)
      )
        return "ticket edit appReviewPlanMarkdown must be a non-empty string or null.";
      const appReviewScope = record["appReviewScope"];
      if (appReviewScope !== undefined && !isAppReviewScope(appReviewScope))
        return "ticket edit appReviewScope must be 'e2e', 'browser', or 'both'.";
      edits.push({
        type,
        ticketId,
        ...(title === undefined ? {} : { title }),
        ...(bodyMarkdown === undefined ? {} : { bodyMarkdown }),
        ...(plannedFileChanges === undefined ? {} : { plannedFileChanges }),
        ...(dependencyKeys === undefined ? {} : { dependencyKeys }),
        ...(appReviewEligible === undefined ? {} : { appReviewEligible }),
        ...(appReviewScope === undefined ? {} : { appReviewScope }),
        ...(appReviewPlanMarkdown === undefined ? {} : { appReviewPlanMarkdown }),
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
    case "planning-grill-complete":
      return { type: "planning-grill-complete" };
    case "planning-spec-artifact": {
      const title = requiredString(record, "title");
      const summaryMarkdown = requiredString(record, "summaryMarkdown");
      if (title.startsWith("Directive field")) return title;
      if (summaryMarkdown.startsWith("Directive field")) return summaryMarkdown;
      return { type: "planning-spec-artifact", title, summaryMarkdown };
    }
    case "wayfinder-map-artifact": {
      const title = requiredString(record, "title");
      const summaryMarkdown = requiredString(record, "summaryMarkdown");
      if (title.startsWith("Directive field")) return title;
      if (summaryMarkdown.startsWith("Directive field")) return summaryMarkdown;
      return { type: "wayfinder-map-artifact", title, summaryMarkdown };
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
    case "implementation-change-request-babysit-result": {
      const runId = requiredString(record, "runId");
      const headSha = requiredString(record, "headSha");
      const summaryMarkdown = requiredString(record, "summaryMarkdown");
      const status = record["status"];
      if (runId.startsWith("Directive field")) return runId;
      if (headSha.startsWith("Directive field")) return headSha;
      if (summaryMarkdown.startsWith("Directive field")) return summaryMarkdown;
      if (status !== "passed" && status !== "blocked") {
        return "implementation-change-request-babysit-result.status must be passed or blocked.";
      }
      return {
        type: "implementation-change-request-babysit-result",
        runId,
        status,
        headSha,
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
    case "app-review-repair-tickets": {
      const runId = requiredString(record, "runId");
      const cycleNumber = record["cycleNumber"];
      const rawTickets = record["tickets"];
      if (runId.startsWith("Directive field")) return runId;
      if (!Number.isInteger(cycleNumber) || (cycleNumber as number) < 1) {
        return "app-review-repair-tickets.cycleNumber must be a positive integer.";
      }
      if (!Array.isArray(rawTickets)) {
        return "app-review-repair-tickets.tickets must be an array.";
      }
      const tickets: Array<{
        key: string;
        parentTicketKey: string | null;
        title: string;
        bodyMarkdown: string;
        dependencyKeys: string[];
      }> = [];
      for (const rawTicket of rawTickets) {
        if (rawTicket === null || typeof rawTicket !== "object" || Array.isArray(rawTicket)) {
          return "app-review-repair-tickets tickets must be objects.";
        }
        const ticket = rawTicket as Record<string, unknown>;
        const key = requiredString(ticket, "key");
        const title = requiredString(ticket, "title");
        const bodyMarkdown = requiredString(ticket, "bodyMarkdown");
        const parentTicketKey = ticket["parentTicketKey"];
        const dependencyKeys = ticket["dependencyKeys"];
        for (const value of [key, title, bodyMarkdown]) {
          if (value.startsWith("Directive field")) return value;
        }
        if (parentTicketKey !== null && typeof parentTicketKey !== "string") {
          return "app-review-repair-tickets.parentTicketKey must be a string or null.";
        }
        if (
          !Array.isArray(dependencyKeys) ||
          dependencyKeys.some((dependency) => typeof dependency !== "string")
        ) {
          return "app-review-repair-tickets.dependencyKeys must be an array of strings.";
        }
        tickets.push({
          key,
          parentTicketKey,
          title,
          bodyMarkdown,
          dependencyKeys: dependencyKeys as string[],
        });
      }
      return {
        type: "app-review-repair-tickets",
        runId,
        cycleNumber: cycleNumber as number,
        tickets,
      };
    }
    case "app-review-fix-result": {
      const runId = requiredString(record, "runId");
      const planId = requiredString(record, "planId");
      const notesMarkdown = requiredString(record, "notesMarkdown");
      const status = record["status"];
      const validations = parseValidationResults(record["validations"] ?? []);
      const commitSha = optionalString(record, "commitSha");
      for (const value of [runId, planId, notesMarkdown]) {
        if (value.startsWith("Directive field")) return value;
      }
      if (status !== "succeeded" && status !== "failed" && status !== "blocked") {
        return "app-review-fix-result.status must be succeeded, failed, or blocked.";
      }
      if (typeof validations === "string") return validations;
      if (typeof commitSha === "string" && commitSha.startsWith("Directive field")) {
        return commitSha;
      }
      return {
        type: "app-review-fix-result",
        runId,
        planId,
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
      const validations = parseValidationResults(record["validations"] ?? []);
      const commitSha = optionalString(record, "commitSha");
      const ticketId = optionalString(record, "ticketId");
      if (runId.startsWith("Directive field")) return runId;
      if (reportMarkdown.startsWith("Directive field")) return reportMarkdown;
      if (status !== "clean" && status !== "findings" && status !== "blocked") {
        return "implementation-code-review-result.status must be clean, findings, or blocked.";
      }
      if (typeof validations === "string") return validations;
      if (typeof commitSha === "string" && commitSha.startsWith("Directive field"))
        return commitSha;
      if (typeof ticketId === "string" && ticketId.startsWith("Directive field")) return ticketId;
      // Each Code Review cycle owns its fixes, so "findings" means the reviewer landed its own
      // fixes and must name the commit it produced before the next fresh cycle starts.
      if (status === "findings" && commitSha === undefined) {
        return "implementation-code-review-result.commitSha is required when status is findings.";
      }
      return {
        type: "implementation-code-review-result",
        runId,
        ...(ticketId === undefined ? {} : { ticketId }),
        status,
        ...(commitSha === undefined ? {} : { commitSha }),
        validations,
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
      const resultMarkdown = workflowSubagentResultMarkdown(record);
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
  const matches = extractJsonFenceBlocks(markdown);
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

  const rawJson = matches[0];
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

/**
 * The verdict shape a planning reviewer must emit, rendered for the prompts that ask for it.
 *
 * It lives beside the parser because the two have to agree exactly: every reviewer cycle of one
 * real run was thrown away for spelling the edit discriminator `action`/`operation` — the shapes
 * the surrounding JSON teaches — while the parser accepts only `type`. Both the review launch
 * prompt and the retry that follows a rejection render this, so the reviewer is never left to
 * guess the field names.
 */
export const PLANNING_REVIEWER_TICKET_EDIT_RULES: ReadonlyArray<string> = [
  'Each ticketEdits entry is discriminated by "type": "update", "create", "delete", or "update-dependencies". "action" and "operation" are not accepted; the "action" field inside plannedFileChanges is unrelated.',
  'Dependency edits carry "dependencyKeys" holding ticket keys such as "TICKET-2". There is no "dependencies" field on an edit.',
  "An update carries only the fields it changes; omitted fields keep their current value.",
  "Leave ticketEdits empty when nothing needs correcting. The entries below show one of each accepted shape, not a required set.",
];

export function planningReviewerVerdictExampleJson(input: {
  readonly cycleNumber: number;
  readonly mode: "full" | "targeted";
  readonly targetPlanningTicketIds: ReadonlyArray<string>;
}): string {
  const exampleTicketId = input.targetPlanningTicketIds[0] ?? "planning-ticket-id";
  return JSON.stringify(
    {
      type: "planning-reviewer-verdict",
      cycleNumber: input.cycleNumber,
      mode: input.mode,
      targetPlanningTicketIds: input.targetPlanningTicketIds,
      passed: false,
      failingPlanningTicketIds: [exampleTicketId],
      dependencyFeedback: ["Dependency graph correction or empty array."],
      perTicketFeedback: [
        {
          ticketId: exampleTicketId,
          passed: false,
          feedbackMarkdown: "Concrete correction or approval note.",
        },
      ],
      ticketEdits: [
        {
          type: "update",
          ticketId: exampleTicketId,
          title: "Corrected ticket title",
          bodyMarkdown: "Corrected outcome, acceptance criteria, and expected tests.",
          plannedFileChanges: [{ path: "apps/example/src/feature.ts", action: "update" }],
          dependencyKeys: ["TICKET-2"],
          appReviewEligible: true,
          appReviewPlanMarkdown: "How a human-style UI review verifies this ticket in isolation.",
        },
        {
          type: "update-dependencies",
          ticketId: exampleTicketId,
          dependencyKeys: ["TICKET-2"],
        },
        {
          type: "create",
          key: "TICKET-7",
          title: "Missing slice this review adds",
          bodyMarkdown: "Outcome, acceptance criteria, and expected tests.",
          plannedFileChanges: [{ path: "apps/example/src/feature.ts", action: "create" }],
          dependencyKeys: [],
          replacesPlanningTicketIds: [exampleTicketId],
          appReviewEligible: false,
          appReviewPlanMarkdown: null,
        },
        { type: "delete", ticketId: exampleTicketId },
      ],
    },
    null,
    2,
  );
}
