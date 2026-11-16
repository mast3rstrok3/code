import type {
  OrchestrationImplementationAutomationHalt,
  OrchestrationImplementationRun,
  OrchestrationPlanningTicket,
} from "@t3tools/contracts";

type Halt = OrchestrationImplementationAutomationHalt;

const haltKey = (halt: Halt) =>
  [halt.stage, halt.ticketId ?? "", halt.category, halt.haltedAt].join("\u0000");

/**
 * The message the workflow's root thread gets when a run stops for a human,
 * or null when the write did not start a new halt. Regrouping or rewording a
 * halt that is already showing keeps its `haltedAt`, so it does not notify again.
 */
export function workflowHaltNotice(input: {
  readonly previous: OrchestrationImplementationRun | null;
  readonly next: OrchestrationImplementationRun;
  readonly ticket: Pick<OrchestrationPlanningTicket, "id" | "key" | "title"> | null;
}): string | null {
  const halt = input.next.automationHalt;
  if (halt === null) return null;
  const previous = input.previous?.automationHalt ?? null;
  if (previous !== null && haltKey(previous) === haltKey(halt)) return null;

  const ticketLabel =
    halt.ticketId === undefined
      ? "the whole run"
      : input.ticket === null
        ? `ticket \`${halt.ticketId}\``
        : `ticket ${input.ticket.key ?? input.ticket.id} "${input.ticket.title}" (\`${halt.ticketId}\`)`;
  return [
    `Workflow update: implementation run \`${input.next.id}\` stopped and needs attention. Every ticket of this run waits until the halt clears.`,
    [
      `- Stage: ${halt.stage}, ${ticketLabel}`,
      `- Halt: ${halt.category}`,
      `- Detail: ${halt.detail}`,
    ].join("\n"),
    "Check `workflow_status_get` and read the stage's thread if the detail is unclear. When starting the stage again fixes the cause, restart it with `workflow_stage_restart`. When it needs a person (a provider login or usage limit, CI billing, a missing App Stack, or uncommitted work that is not the workflow's), tell the user exactly what to do instead.",
  ].join("\n\n");
}
