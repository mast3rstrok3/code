import { createFileRoute } from "@tanstack/react-router";

import { SkillSettings } from "../components/settings/WorkflowSettings";

export const Route = createFileRoute("/settings/skills")({
  validateSearch: (search: Record<string, unknown>) => ({
    skill: typeof search.skill === "string" ? search.skill : undefined,
  }),
  component: SettingsSkillsRoute,
});

function SettingsSkillsRoute() {
  const { skill } = Route.useSearch();
  return <SkillSettings focusedSkillId={skill} />;
}
