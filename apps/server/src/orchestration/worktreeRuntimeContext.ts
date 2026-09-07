import type { AppStackByWorktreeResult, WorkflowPreset } from "@t3tools/contracts";
import { appStackVariantForComposePath } from "@t3tools/shared/appStack";

const WORKFLOWS_WITH_EARLY_APP_STACK = new Set<WorkflowPreset>([
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
  readonly stackLookup: AppStackByWorktreeResult | null;
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

  return [
    "<worktree-runtime-context>",
    "This block is generated from current orchestration state at turn start and is authoritative.",
    "It replaces earlier runtime context in this conversation. An earlier unavailable status does not apply when this block reports a running stack.",
    `- Worktree path: ${input.worktreePath}`,
    `- Git branch: ${input.branch ?? "rename pending"}`,
    ...stackLines,
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
