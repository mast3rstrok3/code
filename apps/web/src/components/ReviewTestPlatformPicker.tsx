import type { ReviewTestPlatform, WorkflowStepReviewPartsOverride } from "@t3tools/contracts";
import {
  REVIEW_TEST_PLATFORMS,
  REVIEW_TEST_PLATFORM_LABELS,
  resolveLayeredAppReviewStepParts,
  resolveReviewTestPlatforms,
  setTicketTestPlatforms,
  TICKET_APP_REVIEW_PARTS_KEY,
} from "@t3tools/shared/appReviewParts";
import type { SetWorkflowStepReviewParts } from "./WorkflowStepReviewParts";

export function ReviewTestPlatformPicker(props: {
  platforms: readonly ReviewTestPlatform[];
  onChange?:
    | ((platforms: readonly [ReviewTestPlatform, ...ReviewTestPlatform[]]) => void)
    | undefined;
  label?: string;
}) {
  return (
    <fieldset className="space-y-2" disabled={props.onChange === undefined}>
      <legend className="text-xs font-medium">{props.label ?? "E2E test platforms"}</legend>
      <div className="flex flex-wrap gap-x-4 gap-y-2">
        {REVIEW_TEST_PLATFORMS.map((platform) => (
          <label key={platform} className="flex items-center gap-1.5 text-xs">
            <input
              type="checkbox"
              checked={props.platforms.includes(platform)}
              disabled={props.platforms.length === 1 && props.platforms.includes(platform)}
              onChange={(event) => {
                const selected = REVIEW_TEST_PLATFORMS.filter((candidate) =>
                  candidate === platform
                    ? event.target.checked
                    : props.platforms.includes(candidate),
                );
                const [first, ...rest] = selected;
                if (first !== undefined) props.onChange?.([first, ...rest]);
              }}
              className="accent-primary"
            />
            {REVIEW_TEST_PLATFORM_LABELS[platform]}
          </label>
        ))}
      </div>
      <p className="text-[11px] text-muted-foreground">
        Web by default. Windows and Android can use configured runners from Linux. iOS and macOS
        need a Mac. Missing runners block the selected tests.
      </p>
    </fieldset>
  );
}

export function TicketTestPlatformPicker(props: {
  overrides: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  defaults?: ReadonlyArray<WorkflowStepReviewPartsOverride> | undefined;
  ticketId?: string;
  onSetStepReviewParts: SetWorkflowStepReviewParts | undefined;
}) {
  const parts = resolveLayeredAppReviewStepParts({
    threadOverrides: props.overrides,
    settingsOverrides: props.defaults,
    key: TICKET_APP_REVIEW_PARTS_KEY,
  });
  return (
    <div className="space-y-2">
      <ReviewTestPlatformPicker
        label={props.ticketId === undefined ? "Ticket E2E test platforms" : "E2E test platforms"}
        platforms={resolveReviewTestPlatforms(parts, props.ticketId)}
        onChange={
          props.onSetStepReviewParts === undefined
            ? undefined
            : (platforms) => {
                props.onSetStepReviewParts?.(
                  TICKET_APP_REVIEW_PARTS_KEY,
                  props.ticketId === undefined
                    ? { ...parts, testPlatforms: platforms }
                    : setTicketTestPlatforms(parts, props.ticketId, platforms),
                );
              }
        }
      />
      {!parts.e2e ? (
        <p className="text-xs text-muted-foreground">
          Enable E2E tests in review settings to run these platforms.
        </p>
      ) : null}
      {props.ticketId !== undefined ? (
        <p className="text-[11px] text-muted-foreground">
          Applies to the next App Review run. Rerun App Review to test a completed ticket again.
        </p>
      ) : null}
      {props.ticketId !== undefined &&
      parts.ticketTestPlatforms?.some((entry) => entry.ticketId === props.ticketId) &&
      props.onSetStepReviewParts ? (
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-foreground"
          onClick={() =>
            props.onSetStepReviewParts?.(
              TICKET_APP_REVIEW_PARTS_KEY,
              setTicketTestPlatforms(parts, props.ticketId!, null),
            )
          }
        >
          Use workflow platforms
        </button>
      ) : null}
    </div>
  );
}
