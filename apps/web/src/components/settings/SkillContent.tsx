import type { BundledSkill, EnvironmentId } from "@t3tools/contracts";
import { appendSkillAdditions, skillAdditions } from "@t3tools/shared/serverSettings";
import { useState } from "react";

import { useEnvironmentSettings, useUpdateEnvironmentSettings } from "~/hooks/useSettings";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { SkillMarkdown } from "./SkillMarkdown";

/** The SKILL.md Claude reads, with the environment's saved additions, and their editor. */
export function SkillContent(props: { skill: BundledSkill; environmentId: EnvironmentId | null }) {
  return props.environmentId ? (
    <EnvironmentSkillContent skill={props.skill} environmentId={props.environmentId} />
  ) : (
    <div className="py-3">
      <SkillMarkdown
        text={props.skill.content}
        label={`${props.skill.name} instructions`}
        maxHeightClassName="max-h-[32rem]"
      />
    </div>
  );
}

function EnvironmentSkillContent(props: { skill: BundledSkill; environmentId: EnvironmentId }) {
  const { skill } = props;
  const additions = useEnvironmentSettings(
    props.environmentId,
    (settings) => settings.workflowStepInstructions,
  );
  const updateSettings = useUpdateEnvironmentSettings(props.environmentId);
  const saved = skillAdditions(additions, skill.name);
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? saved;
  const save = (text: string) => {
    const next = { ...additions };
    delete next[`matt-pocock.${skill.name}`];
    if (text.trim()) next[skill.name] = text.trim();
    else delete next[skill.name];
    updateSettings({ workflowStepInstructions: next });
    setDraft(null);
  };
  return (
    <div className="space-y-3 py-3">
      <SkillMarkdown
        text={appendSkillAdditions(skill.content, skill.name, additions)}
        label={`${skill.name} instructions`}
        maxHeightClassName="max-h-[32rem]"
      />
      <section className="space-y-2 border-t border-border/60 pt-3">
        <h3 className="text-xs font-semibold">Your default additions</h3>
        <p className="text-xs text-muted-foreground">
          Appended to this skill for Claude sessions started after you save.
        </p>
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
    </div>
  );
}
