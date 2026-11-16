import { createFileRoute } from "@tanstack/react-router";

import { WorkflowSettings } from "../components/settings/WorkflowSettings";

export const Route = createFileRoute("/_chat/settings/workflows")({
  component: WorkflowSettings,
});
