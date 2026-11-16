import { createFileRoute } from "@tanstack/react-router";

import { UsersSettingsPanel } from "../components/settings/UsersSettings";

function SettingsUsersRoute() {
  return <UsersSettingsPanel />;
}

export const Route = createFileRoute("/_chat/settings/users")({
  component: SettingsUsersRoute,
});
