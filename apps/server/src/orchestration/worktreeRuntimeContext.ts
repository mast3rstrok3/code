import type {
  AppStackByWorktreeResult,
  OrchestrationProjectShell,
  OrchestrationThreadShell,
  WorkflowPreset,
} from "@t3tools/contracts";
import {
  appStackVariantForComposePath,
  appStackServiceBlocksReadiness,
  isAppStackDeviceService,
} from "@t3tools/shared/appStack";

const WORKFLOWS_WITH_EARLY_APP_STACK = new Set<WorkflowPreset>([
  "planning",
  "fast-engineering",
  "full-feature",
  "fast-feature",
  "quick-plan",
  "fast-plan",
]);

/** What Git reports for the workspace at turn start. */
export interface WorkspaceCheckout {
  readonly isRepo: boolean;
  /** The checked-out branch, or null on a detached HEAD. */
  readonly branch: string | null;
}

/** Threads that worked within this window still count as using their checkout. */
const SHARED_WORKSPACE_ACTIVITY_WINDOW_MS = 24 * 60 * 60 * 1_000;

const normalizeWorkspacePath = (workspacePath: string) => workspacePath.trim().replace(/\/+$/, "");

function lastActivityMs(thread: OrchestrationThreadShell): number {
  const stamps = [
    thread.latestUserMessageAt,
    thread.latestTurn?.requestedAt,
    thread.latestTurn?.startedAt,
    thread.latestTurn?.completedAt,
  ];
  return Math.max(
    0,
    ...stamps.map((stamp) => (stamp == null ? 0 : Date.parse(stamp))).filter(Number.isFinite),
  );
}

/**
 * Titles of other active threads whose workspace is `workspacePath`: a thread
 * without a worktree works in its project's root. Active means not archived or
 * settled, and running a turn or active within the last day. Two threads of
 * workflows never count against each other, because the workflow reactors
 * already decide which of them may write.
 */
export function activeThreadsSharingWorkspace(input: {
  readonly thread: Pick<OrchestrationThreadShell, "id" | "workflowContext">;
  readonly workspacePath: string;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
  readonly projects: ReadonlyArray<Pick<OrchestrationProjectShell, "id" | "workspaceRoot">>;
  readonly nowMs: number;
}): ReadonlyArray<string> {
  const target = normalizeWorkspacePath(input.workspacePath);
  const roots = new Map(input.projects.map((project) => [project.id, project.workspaceRoot]));
  const isWorkflowThread = (thread: Pick<OrchestrationThreadShell, "workflowContext">) =>
    thread.workflowContext != null;
  return input.threads
    .filter((other) => {
      if (other.id === input.thread.id) return false;
      if (other.archivedAt !== null) return false;
      if (other.settledAt !== null || other.settledOverride === "settled") return false;
      if (isWorkflowThread(input.thread) && isWorkflowThread(other)) return false;
      const otherWorkspace = other.worktreePath ?? roots.get(other.projectId);
      if (otherWorkspace === undefined || normalizeWorkspacePath(otherWorkspace) !== target) {
        return false;
      }
      return (
        other.latestTurn?.state === "running" ||
        input.nowMs - lastActivityMs(other) <= SHARED_WORKSPACE_ACTIVITY_WINDOW_MS
      );
    })
    .map((other) => other.title);
}

function gitBranchLine(recorded: string | null, checkout: WorkspaceCheckout | null): string {
  if (checkout === null) return `- Git branch: ${recorded ?? "unknown"}`;
  if (!checkout.isRepo) return "- Git branch: none (not a Git repository)";
  const current = checkout.branch ?? "detached HEAD";
  return recorded !== null && recorded !== current
    ? `- Git branch: ${current} (this thread was started on '${recorded}')`
    : `- Git branch: ${current}`;
}

export function buildWorktreeRuntimeContext(input: {
  readonly worktreePath: string;
  /** The branch recorded on the thread. */
  readonly branch: string | null;
  /** The live checkout, or null when Git could not be asked. */
  readonly checkout?: WorkspaceCheckout | null;
  /** Titles of other active threads working in the same checkout. */
  readonly sharedWithThreadTitles?: ReadonlyArray<string>;
  readonly workflowPreset: WorkflowPreset | null;
  readonly stackLookup: AppStackByWorktreeResult | null;
  readonly setupFailureDetail?: string | null;
  readonly stackFailureDetail?: string | null;
}): string {
  const stack = input.stackLookup?.stack ?? null;
  const unhealthyService = stack?.services?.find(appStackServiceBlocksReadiness);
  const stackHealthy =
    stack !== null &&
    stack.status === "running" &&
    unhealthyService === undefined &&
    input.stackLookup?.frontendUrl !== null;
  const provisionsDuringBootstrap =
    input.workflowPreset !== null && WORKFLOWS_WITH_EARLY_APP_STACK.has(input.workflowPreset);
  const stackLines = (() => {
    if (input.stackLookup === null) {
      return [
        "- App Stack status: unavailable (the controller lookup did not complete)",
        "- App Stack URL: unavailable",
      ];
    }
    if (stack === null) {
      if (input.setupFailureDetail) {
        return [
          `- App Stack status: blocked because workspace dependency setup failed (${input.setupFailureDetail})`,
          "- App Stack URL: unavailable",
        ];
      }
      if (input.stackFailureDetail) {
        return [
          `- App Stack status: startup failed for this worktree (${input.stackFailureDetail})`,
          "- App Stack URL: unavailable",
        ];
      }
      return provisionsDuringBootstrap
        ? [
            "- App Stack status: pending workspace dependency readiness; orchestration starts it as soon as setup completes successfully",
            "- App Stack URL: not assigned yet",
          ]
        : [
            "- App Stack status: no stack is registered for this worktree",
            "- App Stack URL: unavailable",
          ];
    }
    return [
      `- App Stack id: ${stack.id}`,
      `- App Stack name: ${stack.displayName ?? stack.id}`,
      `- App Stack variant: ${stack.variant ?? appStackVariantForComposePath(stack.composePath)}`,
      `- App Stack namespace: ${stack.namespace ?? "unavailable"}`,
      `- App Stack status: ${stack.status}`,
      `- App Stack URL: ${input.stackLookup.frontendUrl ?? "not ready"}`,
      ...Object.entries({
        ...Object.fromEntries(
          (stack.services ?? [])
            .filter((service) => service.previewUrl)
            .map((service) => [service.name, service.previewUrl]),
        ),
        ...stack.previewUrls,
      }).map(([name, url]) => `- App Stack service ${name}: ${url}`),
    ];
  })();

  const sharedWith = input.sharedWithThreadTitles ?? [];
  const sharedLines =
    sharedWith.length === 0
      ? []
      : [
          `- Shared checkout: ${sharedWith.length} other active thread(s) also work here: ${sharedWith
            .slice(0, 3)
            .map((title) => JSON.stringify(title))
            .join(", ")}${sharedWith.length > 3 ? ", ..." : ""}`,
          "Another thread is working in this checkout. Do not create, switch, or reset branches here, and do not stash or rebase. If this task needs its own branch, create a separate git worktree for it and work there.",
        ];

  return [
    "<worktree-runtime-context>",
    "This block is generated from current orchestration state at turn start and is authoritative.",
    "It replaces earlier runtime context in this conversation. An earlier unavailable status does not apply when this block reports a running stack.",
    `- Worktree path: ${input.worktreePath}`,
    gitBranchLine(input.branch, input.checkout ?? null),
    ...sharedLines,
    ...stackLines,
    ...(stack?.services?.some(isAppStackDeviceService)
      ? [
          "This stack has cluster test guests. Use app_stack_device_start/status/stop to lease Android or Windows and obtain access commands. Host device settings and missing local SDKs do not describe these cluster guests.",
        ]
      : []),
    "Use only this worktree for source and Git operations.",
    "Do not inspect, query, modify, or claim evidence from a host container, database, development server, deployment URL, or App Stack belonging to another worktree.",
    !stackHealthy && input.workflowPreset !== null
      ? "Until this worktree's App Stack is healthy and its URL is ready, limit work to source inspection and the workflow's current non-runtime stage; do not substitute another runtime."
      : stackHealthy
        ? "The App Stack URL and service URLs above are the authoritative runtime and browser targets for this worktree. Use the named service URL when a test needs a secondary application. Do not derive service URLs by replacing hostname text. Reuse the running stack instead of starting a competing dev server."
        : "No healthy App Stack target is confirmed. Follow repository instructions for local testing; do not assume a stack is running or substitute another worktree's runtime.",
    "Each turn receives fresh runtime context. Use the app_stack_get MCP tool, when available, to refresh this workspace's status during a turn or inspect its prod variant.",
    "</worktree-runtime-context>",
  ].join("\n");
}
