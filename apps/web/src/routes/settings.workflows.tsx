import { createFileRoute } from "@tanstack/react-router";

import { WorkflowSettings } from "../components/settings/WorkflowSettings";

export const Route = createFileRoute("/settings/workflows")({
  component: WorkflowSettings,
});
