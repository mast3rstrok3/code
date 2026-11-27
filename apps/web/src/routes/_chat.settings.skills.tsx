import { createFileRoute } from "@tanstack/react-router";

import { SkillSettings } from "../components/settings/SkillSettings";

export const Route = createFileRoute("/_chat/settings/skills")({
  validateSearch: (search: Record<string, unknown>) => ({
    skill: typeof search.skill === "string" ? search.skill : undefined,
  }),
  component: SettingsSkillsRoute,
});

function SettingsSkillsRoute() {
  const { skill } = Route.useSearch();
  return <SkillSettings focusedSkillId={skill} />;
}
