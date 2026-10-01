import type {
  EnvironmentId,
  OrchestrationPlanningTicket,
  WorkflowStepReviewPartsOverride,
} from "@t3tools/contracts";
import {
  resolveLayeredAppReviewStepParts,
  resolveTicketAppStack,
  setTicketAppStack,
  TICKET_APP_REVIEW_PARTS_KEY,
  ticketAppStackSource,
} from "@t3tools/shared/appReviewParts";
import { describeAppStackShape } from "@t3tools/shared/appStack";
import { useState } from "react";

import { appStackEnvironment } from "~/state/appStacks";
import { useEnvironmentQuery } from "~/state/query";

import { AppStackBundleAppChecklist } from "./AppStackBundleAppChecklist";
import {
  bundledApps,
  setBundledApp,
  setServiceOmitted,
  TICKET_APP_STACK_SOURCE_LABELS,
} from "./TicketAppStackPicker.logic";
import { Checkbox } from "./ui/checkbox";
import type { SetWorkflowStepReviewParts } from "./WorkflowStepReviewParts";

/**
 * The App Stack a ticket's App Review runs: which other platform apps it
 * bundles and which services it leaves out. The planner's choice applies until
 * the user picks one here.
 */
export function TicketAppStackPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly ticket: OrchestrationPlanningTicket;
  /** The workflow worktree, whose contract names the apps and services. */
  readonly worktreePath: string | null;
  readonly branch: string | null;
  readonly overrides: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  readonly defaults?: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  readonly onSetStepReviewParts: SetWorkflowStepReviewParts | undefined;
}) {
  const [editing, setEditing] = useState(false);
  const parts = resolveLayeredAppReviewStepParts({
    threadOverrides: props.overrides,
    settingsOverrides: props.defaults,
    key: TICKET_APP_REVIEW_PARTS_KEY,
  });
  const shape = resolveTicketAppStack(parts, props.ticket);
  const source = ticketAppStackSource(parts, props.ticket);
  // Asked for only while editing: it reads every platform app's contract.
  const planQuery = useEnvironmentQuery(
    editing && props.worktreePath !== null
      ? appStackEnvironment.bundlePlan({
          environmentId: props.environmentId,
          input: { worktreePath: props.worktreePath, gitBranch: props.branch, variant: "dev" },
        })
      : null,
  );
  const plan = planQuery.data;
  const onSet = props.onSetStepReviewParts;
  const set =
    onSet === undefined
      ? undefined
      : (next: Parameters<typeof setTicketAppStack>[2]) =>
          onSet(TICKET_APP_REVIEW_PARTS_KEY, setTicketAppStack(parts, props.ticket.id, next));

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="text-xs font-medium">App Stack</div>
          <p className="text-2xs text-muted-foreground">
            {TICKET_APP_STACK_SOURCE_LABELS[source]}: {describeAppStackShape(shape)}
          </p>
        </div>
        {set !== undefined && props.worktreePath !== null ? (
          <button
            type="button"
            className="shrink-0 text-xs text-muted-foreground hover:text-foreground"
            onClick={() => setEditing((current) => !current)}
          >
            {editing ? "Done" : "Change"}
          </button>
        ) : null}
      </div>
      {editing ? (
        plan ? (
          <div className="space-y-1 rounded-md border border-border/70 p-2">
            <p className="text-2xs text-muted-foreground">
              Checked apps run from this branch next to the ticket and reach each other. Unchecked
              apps stay on their standing dev copies. Unchecked services do not start.
            </p>
            <AppStackBundleAppChecklist
              plan={plan}
              selected={bundledApps(shape, plan)}
              onToggle={
                set === undefined
                  ? undefined
                  : (app, checked) => set(setBundledApp(shape, plan, app, checked))
              }
              describe={(_member, state) =>
                state.own
                  ? "This ticket's app"
                  : state.selected
                    ? "Runs from this branch"
                    : "Standing dev copy"
              }
              renderDetails={(member, state) =>
                state.selected && (member.services?.length ?? 0) > 0 ? (
                  <div className="ml-7 flex flex-wrap gap-x-3 gap-y-1 pb-1">
                    {member.services?.map((service) => (
                      <label key={service} className="flex items-center gap-1.5 text-2xs">
                        <Checkbox
                          checked={!(shape.omitServices?.[member.app] ?? []).includes(service)}
                          disabled={set === undefined}
                          onCheckedChange={(checked) =>
                            set?.(setServiceOmitted(shape, member.app, service, !checked))
                          }
                        />
                        {service}
                      </label>
                    ))}
                  </div>
                ) : null
              }
            />
          </div>
        ) : (
          <p className="text-2xs text-muted-foreground">
            {planQuery.error === null
              ? "Listing this workspace's apps…"
              : `Its apps could not be listed: ${planQuery.error}`}
          </p>
        )
      ) : null}
      {source === "override" && set !== undefined ? (
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() => set(null)}
        >
          Use planned App Stack
        </button>
      ) : null}
    </div>
  );
}
