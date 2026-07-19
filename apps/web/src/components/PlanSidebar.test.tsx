import { EnvironmentId } from "@t3tools/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";

import PlanSidebar, { PlannedFileChanges } from "./PlanSidebar";

describe("PlanSidebar disclosures", () => {
  it("renders all available top-level sections collapsed with accessible triggers", () => {
    const markup = renderToStaticMarkup(
      <PlanSidebar
        activePlan={{
          createdAt: "2026-07-19T00:00:00.000Z",
          turnId: null,
          explanation: "Inspect the project before implementing.",
          steps: [{ step: "Inspect the project", status: "inProgress" }],
        }}
        activeProposedPlan={{
          id: "plan-1",
          createdAt: "2026-07-19T00:00:00.000Z",
          updatedAt: "2026-07-19T00:00:00.000Z",
          turnId: null,
          planMarkdown: "# Full Plan\n\nImplement the requested change.",
          implementedAt: null,
          implementationThreadId: null,
        }}
        environmentId={EnvironmentId.make("environment-local")}
        markdownCwd={undefined}
        workspaceRoot={undefined}
        timestampFormat="locale"
      />,
    );

    for (const label of [
      "Steps",
      "Full Plan",
      "Spec",
      "Tickets",
      "Ticket Review Cycles",
      "Implementation Runs",
    ]) {
      expect(markup).toContain(`aria-label="Expand ${label}"`);
    }
    expect(markup.match(/aria-expanded="false"/g)).toHaveLength(6);
  });
});

describe("PlannedFileChanges", () => {
  it("groups actions in create, update, delete order while preserving paths", () => {
    const markup = renderToStaticMarkup(
      <PlannedFileChanges
        changes={[
          { path: "src/removed.ts", action: "delete" },
          { path: "src/created.ts", action: "create" },
          { path: "src/updated.ts", action: "update" },
        ]}
      />,
    );

    expect(markup).toContain("Planned files");
    expect(markup.indexOf("Create")).toBeLessThan(markup.indexOf("Update"));
    expect(markup.indexOf("Update")).toBeLessThan(markup.indexOf("Delete"));
    expect(markup).toContain("src/created.ts");
    expect(markup).toContain("src/updated.ts");
    expect(markup).toContain("src/removed.ts");
  });

  it("renders the legacy empty state", () => {
    const markup = renderToStaticMarkup(<PlannedFileChanges changes={[]} />);
    expect(markup).toContain("No planned file changes recorded.");
  });
});
