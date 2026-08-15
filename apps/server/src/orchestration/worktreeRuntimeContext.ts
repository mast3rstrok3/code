import type { AppDevStackByWorktreeResult, WorkflowPreset } from "@t3tools/contracts";

const WORKFLOWS_THAT_PROVISION_AFTER_BUILD = new Set<WorkflowPreset>([
  "planning",
  "full-feature",
  "fast-feature",
]);

export function buildWorktreeRuntimeContext(input: {
  readonly worktreePath: string;
  readonly branch: string | null;
  readonly workflowPreset: WorkflowPreset | null;
  readonly stackLookup: AppDevStackByWorktreeResult | null;
}): string {
  const stack = input.stackLookup?.stack ?? null;
  const provisionsAfterBuild =
    input.workflowPreset !== null && WORKFLOWS_THAT_PROVISION_AFTER_BUILD.has(input.workflowPreset);
  const stackLines = (() => {
    if (input.stackLookup === null) {
      return [
        "- App Dev Stack status: unavailable (the controller lookup did not complete)",
        "- App Dev Stack URL: unavailable",
      ];
    }
    if (stack === null) {
      return provisionsAfterBuild
        ? [
            "- App Dev Stack status: pending Build; orchestration starts it only after Build succeeds",
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
    stack === null
      ? "Until this worktree's App Dev Stack is ready, limit work to source inspection and the workflow's current non-runtime stage; do not substitute another runtime."
      : input.stackLookup?.frontendUrl === null
        ? "This stack is not ready for runtime or browser evidence yet. Wait for orchestration to provide its frontend URL."
        : "The App Dev Stack URL above is the only authoritative runtime and browser target for this worktree.",
    "Later workflow turns receive a freshly generated block, including the exact stack id and URL once ready.",
    "</worktree-runtime-context>",
  ].join("\n");
}
