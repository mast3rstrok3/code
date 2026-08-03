import { createFileRoute } from "@tanstack/react-router";

import { DocSettings } from "../components/settings/WorkflowSettings";

export const Route = createFileRoute("/settings/docs")({
  validateSearch: (search: Record<string, unknown>) => ({
    doc: typeof search.doc === "string" ? search.doc : undefined,
  }),
  component: SettingsDocsRoute,
});

function SettingsDocsRoute() {
  const { doc } = Route.useSearch();
  return <DocSettings focusedDocId={doc} />;
}
