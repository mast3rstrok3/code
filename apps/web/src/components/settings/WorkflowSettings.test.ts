import { describe, expect, it } from "vite-plus/test";

import { SETTINGS_NAV_ITEMS } from "./SettingsSidebarNav";
import { resolveCatalogFocusId } from "./WorkflowSettings";

describe("workflow catalog settings", () => {
  it("publishes separate workflow, skill, and doc navigation entries", () => {
    expect(
      SETTINGS_NAV_ITEMS.filter((item) => ["Workflows", "Skills", "Docs"].includes(item.label)).map(
        (item) => [item.label, item.to],
      ),
    ).toEqual([
      ["Workflows", "/settings/workflows"],
      ["Skills", "/settings/skills"],
      ["Docs", "/settings/docs"],
    ]);
  });

  it("accepts valid catalog deep links and ignores stale IDs", () => {
    expect(resolveCatalogFocusId("tdd", ["grill", "tdd"])).toBe("tdd");
    expect(resolveCatalogFocusId("removed", ["grill", "tdd"])).toBeUndefined();
    expect(resolveCatalogFocusId(undefined, ["grill", "tdd"])).toBeUndefined();
  });
});
