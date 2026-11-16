import { createFileRoute } from "@tanstack/react-router";

import { resolveThreadRouteSearch } from "../threadRoutes";

// The _chat layout owns ChatView so draft promotion keeps it mounted.
export const Route = createFileRoute("/_chat/$environmentId/$threadId")({
  component: () => null,
  validateSearch: resolveThreadRouteSearch,
});
