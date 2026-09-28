import { DEFAULT_MAX_PARALLEL_TICKETS, MAX_PARALLEL_TICKETS } from "@t3tools/contracts";
import { useId, useState } from "react";

import { Input } from "./ui/input";

export function WorkflowTicketConcurrency(props: {
  readonly value?: number | undefined;
  readonly onChange: (value: number) => void;
}) {
  const value = props.value ?? DEFAULT_MAX_PARALLEL_TICKETS;
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
        Parallel tickets
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
      <p id={`${id}-description`} className="text-[11px] leading-relaxed text-muted-foreground">
        Each ticket holds a slot through implementation and review. Lowering the limit lets active
        tickets finish before more start. Choose 1 to work on one ticket at a time.
      </p>
    </div>
  );
}
