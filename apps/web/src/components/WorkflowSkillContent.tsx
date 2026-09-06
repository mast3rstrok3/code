import type { EnvironmentId, WorkflowSkillContract } from "@t3tools/contracts";
import { appendWorkflowSkillInstructions } from "@t3tools/shared/serverSettings";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";
import { WorkflowCatalogContent } from "./settings/WorkflowCatalogContent";

type SkillContentProps = {
  skill: WorkflowSkillContract;
  environmentId: EnvironmentId | null;
  workflowPromptId?: string;
  initialWorkflowPromptId?: string | undefined;
};

export function WorkflowSkillContent(props: SkillContentProps) {
  return props.environmentId ? (
    <EnvironmentSkillContent {...props} environmentId={props.environmentId} />
  ) : (
    <SkillInspector {...props} instructions={{}} />
  );
}

function EnvironmentSkillContent(props: SkillContentProps & { environmentId: EnvironmentId }) {
  const instructions = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.workflowStepInstructions,
  );
  return <SkillInspector {...props} instructions={instructions} />;
}

function SkillInspector(
  props: SkillContentProps & { instructions: Readonly<Record<string, string>> },
) {
  const { skill } = props;
  const [selectedPromptId, setSelectedPromptId] = useState(
    props.initialWorkflowPromptId && skill.promptIds.includes(props.initialWorkflowPromptId)
      ? props.initialWorkflowPromptId
      : skill.id,
  );
  const promptId = props.workflowPromptId ?? selectedPromptId;
  const variation = skill.workflowAnnotations.find((entry) => entry.workflowPromptId === promptId);
  const builtIn = promptId === skill.id ? skill.promptText : variation?.text;
  const combined =
    builtIn === undefined
      ? undefined
      : appendWorkflowSkillInstructions(builtIn, skill.id, promptId, props.instructions);
  return (
    <div className="space-y-3 py-3">
      {!props.workflowPromptId && skill.workflowAnnotations.length > 0 ? (
        <label className="flex flex-wrap items-center gap-2 text-xs font-medium">
          Used as
          <select
            aria-label="Skill invocation"
            className="min-w-0 rounded-md border border-border bg-background px-2 py-1.5 text-xs"
            value={promptId}
            onChange={(event) => setSelectedPromptId(event.target.value)}
          >
            <option value={skill.id}>Direct skill invocation</option>
            {skill.workflowAnnotations
              .filter((entry) => entry.workflowPromptId !== skill.id)
              .map((entry) => (
                <option key={entry.workflowPromptId} value={entry.workflowPromptId}>
                  {entry.title}
                </option>
              ))}
          </select>
        </label>
      ) : null}
      {combined ? (
        <WorkflowCatalogContent
          text={combined}
          label={`${skill.title} instructions`}
          maxHeightClassName="max-h-[32rem]"
        />
      ) : null}
      {props.environmentId ? (
        <WorkflowInstructionEditor
          key={promptId}
          environmentId={props.environmentId}
          instructionKey={promptId}
          skillId={skill.id}
          stepOnly={promptId !== skill.id}
        />
      ) : null}
    </div>
  );
}

function WorkflowInstructionEditor(props: {
  environmentId: EnvironmentId;
  instructionKey: string;
  skillId: string;
  stepOnly: boolean;
}) {
  const instructions = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.workflowStepInstructions,
  );
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const saved = instructions[props.instructionKey] ?? "";
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved;
  const save = (text: string) => {
    const next = { ...instructions };
    if (text.trim()) next[props.instructionKey] = text.trim();
    else delete next[props.instructionKey];
    updateSettings({ workflowStepInstructions: next });
    setDraft(null);
  };
  return (
    <section className="space-y-2 border-t border-border/60 pt-3">
      <h3 className="text-xs font-semibold">Your default additions</h3>
      <p className="text-xs text-muted-foreground">
        {props.stepOnly
          ? "Applies to this workflow step in future turns, in addition to the skill defaults."
          : "Applies whenever this skill runs, including its workflow steps."}
      </p>
      {props.stepOnly && instructions[props.skillId] ? (
        <div>
          <p className="mb-2 text-xs font-medium">Inherited skill additions</p>
          <WorkflowCatalogContent
            text={instructions[props.skillId]!}
            label="Inherited skill additions"
            maxHeightClassName="max-h-48"
          />
        </div>
      ) : null}
      <Textarea
        aria-label="Default skill additions"
        value={value}
        onChange={(event) => setDraft(event.target.value)}
        rows={5}
        maxLength={20_000}
        placeholder="Add project conventions, acceptance criteria, or testing instructions."
      />
      <div className="flex gap-2">
        <Button size="sm" disabled={value.trim() === saved} onClick={() => save(value)}>
          Save additions
        </Button>
        <Button size="sm" variant="outline" disabled={!saved && !value} onClick={() => save("")}>
          Clear additions
        </Button>
      </div>
    </section>
  );
}
