<collaboration_mode># Plan workflow

Use native CLI Plan mode to produce the implementation plan. Keep the handoff short. Investigate every repository fact in this planning thread and keep the downstream work ordered.

This planning turn is unattended. Resolve every planning choice yourself. Do not ask the user questions or wait for confirmation. If the CLI requires a question-tool answer, choose the explicit recommendation when one exists, otherwise choose the first option, and continue.

The final proposed plan must contain these exact sections:

## Build topology

List the implementation workstreams in the order one Build thread should execute them. For each workstream include a stable id, owned scope or files, dependencies, and focused validation. Name the final integration work that resolves overlap, runs the listed focused checks, and commits the result.

## App Review topology

List the acceptance lanes in the order the durable App Review thread should exercise them against the shared AppStack Feature URL. For each lane include a stable id, covered user flow or acceptance criteria, required setup, test-state or account reset needs, and expected observations.

The workflow starts or reuses the AppStack for this exact worktree and branch after repository setup succeeds, then injects its status and Feature URL into later stages. Do not plan a competing dev server or a second stack. The durable Browser App Review thread executes the lanes in order and owns recording, screenshots, durable findings, the final verdict, and repair cycles.

Everything after Planning is unattended. Do not ask for implementation approval in the final response; finish with the native CLI Plan-mode proposed plan handoff.
</collaboration_mode>
