import { describe, expect, it, vi } from "vite-plus/test";

import { buildHomeListFilterMenuItems } from "./home-list-filter-menu";

const base = {
  environments: [],
  projects: [],
  selectedEnvironmentId: null,
  selectedProjectKey: null,
  userScopes: [],
  onEnvironmentChange: () => undefined,
  onProjectChange: () => undefined,
  onUserScopeChange: () => undefined,
};

describe("buildHomeListFilterMenuItems", () => {
  it("offers the Wizard filter only once a Wizard thread exists or the filter is on", () => {
    const onChange = vi.fn();
    const ids = (offered: boolean, active: boolean) =>
      buildHomeListFilterMenuItems({ ...base, wizard: { offered, active, onChange } }).map(
        (item) => item.id,
      );
    expect(ids(false, false)).toEqual(["environment"]);
    expect(ids(true, false)).toEqual(["wizard", "environment"]);
    expect(ids(false, true)).toEqual(["wizard", "environment"]);
  });

  it("selects the current mode and switches it", () => {
    const onChange = vi.fn();
    const [wizard] = buildHomeListFilterMenuItems({
      ...base,
      wizard: { offered: true, active: true, onChange },
    });
    if (wizard === undefined || !("items" in wizard)) throw new Error("expected a Wizard group");
    expect(
      wizard.items.map((item) => [item.id, "selected" in item ? item.selected : undefined]),
    ).toEqual([
      ["wizard:all", false],
      ["wizard:only", true],
    ]);
    for (const item of wizard.items) if ("onPress" in item) item.onPress();
    expect(onChange.mock.calls).toEqual([[false], [true]]);
  });
});
