import type { AppDevStackByWorktreeResult, WorkflowPreset } from "@t3tools/contracts";

const WORKFLOWS_WITH_EARLY_APP_DEV_STACK = new Set<WorkflowPreset>([
  "planning",
  "fast-engineering",
  "full-feature",
  "fast-feature",
  "quick-plan",
  "fast-plan",
]);

export function buildWorktreeRuntimeContext(input: {
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly workflowPreset: WorkflowPreset | null;
  readonly stackLookup: AppDevStackByWorktreeResult | null;
  readonly setupFailureDetail?: string | null;
  readonly stackFailureDetail?: string | null;
}): string {
  const stack = input.stackLookup?.stack ?? null;
  const unhealthyService = stack?.services?.find(
    (service) =>
      (service.error !== null && service.error !== undefined) ||
      service.health === "unhealthy" ||
      service.status === "error" ||
      service.status === "stopped",
  );
  const stackHealthy =
    stack !== null &&
    stack.status === "running" &&
    unhealthyService === undefined &&
    input.stackLookup?.frontendUrl !== null;
  const provisionsDuringBootstrap =
    input.workflowPreset !== null && WORKFLOWS_WITH_EARLY_APP_DEV_STACK.has(input.workflowPreset);
  const stackLines = (() => {
    if (input.stackLookup === null) {
      return [
        "- App Dev Stack status: unavailable (the controller lookup did not complete)",
        "- App Dev Stack URL: unavailable",
      ];
    }
    if (stack === null) {
      if (input.setupFailureDetail) {
        return [
          `- App Dev Stack status: blocked because workspace dependency setup failed (${input.setupFailureDetail})`,
          "- App Dev Stack URL: unavailable",
        ];
      }
      if (input.stackFailureDetail) {
        return [
          `- App Dev Stack status: startup failed for this worktree (${input.stackFailureDetail})`,
          "- App Dev Stack URL: unavailable",
        ];
      }
      return provisionsDuringBootstrap
        ? [
            "- App Dev Stack status: pending workspace dependency readiness; orchestration starts it as soon as setup completes successfully",
            "- App Dev Stack URL: not assigned yet",
          ]
        : [
            "- App Dev Stack status: no stack is registered for this worktree",
            "- App Dev Stack URL: unavailable",
          ];
    }
    return [
      `- App Dev Stack id: ${stack.id}`,
      `- App Dev Stack name: ${stack.displayName ?? stack.id}`,
      `- App Dev Stack status: ${stack.status}`,
      `- App Dev Stack URL: ${input.stackLookup.frontendUrl ?? "not ready"}`,
    ];
  })();

  return [
    "<worktree-runtime-context>",
    "This block is generated from current orchestration state at turn start and is authoritative.",
    `- Worktree path: ${input.worktreePath}`,
    `- Git branch: ${input.branch ?? "rename pending"}`,
    ...stackLines,
    "Use only this worktree for source and Git operations.",
    "Do not inspect, query, modify, or claim evidence from a host container, database, development server, deployment URL, or App Dev Stack belonging to another worktree.",
    !stackHealthy
      ? "Until this worktree's App Dev Stack is healthy and its URL is ready, limit work to source inspection and the workflow's current non-runtime stage; do not substitute another runtime."
      : "The App Dev Stack URL above is the only authoritative runtime and browser target for this worktree.",
    "Later workflow turns receive a freshly generated block, including the exact stack id and URL once ready.",
    "</worktree-runtime-context>",
  ].join("\n");
}
