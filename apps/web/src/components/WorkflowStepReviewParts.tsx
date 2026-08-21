import type { WorkflowStepReviewPartsOverride } from "@t3tools/contracts";
import {
  APP_REVIEW_PARTS_TARGETS,
  describeAppReviewParts,
  resolveAppReviewStepParts,
  type AppReviewParts,
} from "@t3tools/shared/appReviewParts";
import {
  workflowStepCycleKeyId,
  workflowStepCycleKeysEqual,
  type WorkflowStepCycleKey,
} from "@t3tools/shared/workflowStepCycles";

import { Switch } from "./ui/switch";

export type SetWorkflowStepReviewParts = (
  key: WorkflowStepCycleKey,
  parts: AppReviewParts | null,
) => void;

/**
 * On/off per review part for a step and the agents it starts, or nothing when
 * none of them is an App Review.
 *
 * Keyed like the model and cycle pins so "which parts", "how many times", and
 * "with which model" live side by side. A part turned off here is a
 * prohibition the server enforces, not a preference: the review runs without
 * it, and with both parts off the review step is skipped entirely.
 */
export function WorkflowStepReviewPartPins(props: {
  readonly workflowPromptId: string;
  readonly subStepWorkflowPromptIds: ReadonlyArray<string>;
  readonly overrides: ReadonlyArray<WorkflowStepReviewPartsOverride>;
  readonly className?: string | undefined;
  readonly onSetStepReviewParts: SetWorkflowStepReviewParts;
}) {
  const targets = APP_REVIEW_PARTS_TARGETS.filter(
    (target) =>
      workflowStepCycleKeysEqual(target.key, { workflowPromptId: props.workflowPromptId }) ||
      props.subStepWorkflowPromptIds.some((subStepId) =>
        workflowStepCycleKeysEqual(target.key, {
          workflowPromptId: subStepId,
          stepWorkflowPromptId: props.workflowPromptId,
        }),
      ),
  );
  if (targets.length === 0) return null;

  return (
    <div className={props.className ?? "space-y-2"}>
      <div className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
        Review parts
      </div>
      {targets.map((target) => {
        const parts = resolveAppReviewStepParts({ overrides: props.overrides, key: target.key });
        const hasOverride = props.overrides.some((entry) =>
          workflowStepCycleKeysEqual(entry, target.key),
        );
        return (
          <div key={workflowStepCycleKeyId(target.key)} className="space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate text-xs font-medium text-foreground">{target.label}</span>
              {hasOverride ? (
                <button
                  type="button"
                  onClick={() => props.onSetStepReviewParts(target.key, null)}
                  className="cursor-pointer shrink-0 text-[10px] font-medium uppercase tracking-wider text-muted-foreground hover:text-foreground"
                >
                  Auto
                </button>
              ) : null}
            </div>
            <div className="flex items-center gap-4">
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                E2E tests
                <Switch
                  checked={parts.e2e}
                  onCheckedChange={(checked) =>
                    props.onSetStepReviewParts(target.key, { ...parts, e2e: checked === true })
                  }
                  aria-label={`E2E tests for ${target.label}`}
                />
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                Browser review
                <Switch
                  checked={parts.browser}
                  onCheckedChange={(checked) =>
                    props.onSetStepReviewParts(target.key, { ...parts, browser: checked === true })
                  }
                  aria-label={`Browser review for ${target.label}`}
                />
              </label>
            </div>
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {describeAppReviewParts(parts)}
              {parts.e2e || parts.browser ? "" : " — this review step is skipped entirely"} ·{" "}
              {target.description}
            </p>
          </div>
        );
      })}
    </div>
  );
}
