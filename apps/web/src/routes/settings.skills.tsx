import { createFileRoute } from "@tanstack/react-router";

import { SkillSettings } from "../components/settings/WorkflowSettings";

export const Route = createFileRoute("/settings/skills")({
  validateSearch: (search: Record<string, unknown>) => ({
    skill: typeof search.skill === "string" ? search.skill : undefined,
    prompt: typeof search.prompt === "string" ? search.prompt : undefined,
  }),
  component: SettingsSkillsRoute,
});

function SettingsSkillsRoute() {
  const { skill, prompt } = Route.useSearch();
  return <SkillSettings focusedSkillId={skill} focusedPromptId={prompt} />;
}
