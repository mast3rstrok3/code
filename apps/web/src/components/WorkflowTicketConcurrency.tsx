import {
  DEFAULT_MAX_PARALLEL_TICKETS,
  DEFAULT_MAX_PARALLEL_APP_REVIEWS,
  MAX_PARALLEL_TICKETS,
} from "@t3tools/contracts";
import { useId, useState } from "react";

import { Input } from "./ui/input";

export function WorkflowTicketConcurrency(props: {
  readonly value?: number | undefined;
  readonly onChange: (value: number) => void;
  readonly appReviewValue?: number | undefined;
  readonly onAppReviewChange?: ((value: number) => void) | undefined;
}) {
  return (
    <div className="space-y-4">
      <ConcurrencyInput
        value={props.value ?? DEFAULT_MAX_PARALLEL_TICKETS}
        onChange={props.onChange}
        label="Parallel tickets"
        description="Limits implementation and code review. App Review uses its own budget."
      />
      {props.onAppReviewChange && (
        <ConcurrencyInput
          value={props.appReviewValue ?? DEFAULT_MAX_PARALLEL_APP_REVIEWS}
          onChange={props.onAppReviewChange}
          label="Parallel App Reviews"
          description="Limits ticket App Reviews, including tests and repair cycles."
        />
      )}
      <p className="text-2xs leading-relaxed text-muted-foreground">
        Lowering a limit lets active work finish before more starts.
      </p>
    </div>
  );
}

function ConcurrencyInput(props: {
  readonly value: number;
  readonly onChange: (value: number) => void;
  readonly label: string;
  readonly description: string;
}) {
  const value = props.value;
  const [editing, setEditing] = useState({ value, text: String(value) });
  if (editing.value !== value) setEditing({ value, text: String(value) });
  const draft = editing.value === value ? editing.text : String(value);
  const setDraft = (text: string) => setEditing({ value, text });
  const id = useId();
  const commit = () => {
    const parsed = Number(draft);
    if (draft.trim() === "" || !Number.isInteger(parsed)) {
      setDraft(String(value));
      return;
    }
    const bounded = Math.min(MAX_PARALLEL_TICKETS, Math.max(1, parsed));
    setDraft(String(bounded));
    if (bounded !== value) props.onChange(bounded);
  };
  return (
    <div className="space-y-2">
      <label htmlFor={id} className="text-xs font-medium text-foreground">
        {props.label}
      </label>
      <Input
        id={id}
        type="number"
        size="compact"
        min={1}
        max={MAX_PARALLEL_TICKETS}
        step={1}
        value={draft}
        aria-describedby={`${id}-description`}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            event.preventDefault();
            event.currentTarget.blur();
          }
        }}
      />
      <p id={`${id}-description`} className="text-2xs leading-relaxed text-muted-foreground">
        {props.description}
      </p>
    </div>
  );
}
