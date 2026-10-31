import { DEFAULT_WORKSPACE_USER, EnvironmentId, WorkspaceUserId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildWorkspaceUserMenuScopes,
  parseWorkspaceUserMenuActionId,
  workspaceUserMenuActions,
  workspaceUserMenuIsCustomized,
} from "./workspaceUserMenu";

const home = EnvironmentId.make("home");
const work = EnvironmentId.make("work");
const ada = { ...DEFAULT_WORKSPACE_USER, id: WorkspaceUserId.make("ada"), displayName: "Ada" };
const environments = [
  { environmentId: home, label: "Home" },
  { environmentId: work, label: "Work" },
];

describe("buildWorkspaceUserMenuScopes", () => {
  it("offers a switcher only where there are people to switch between", () => {
    const scopes = buildWorkspaceUserMenuScopes({
      scopes: [
        { environmentId: home, users: [DEFAULT_WORKSPACE_USER, ada], view: { kind: "all" } },
        { environmentId: work, users: [DEFAULT_WORKSPACE_USER], view: { kind: "all" } },
      ],
      environments,
      selectedEnvironmentId: null,
    });
    expect(scopes).toEqual([
      {
        environmentId: home,
        title: "User",
        options: [
          { key: "all", title: "Everyone", selected: true },
          { key: "user:nils", title: "Nils", selected: false },
          { key: "user:ada", title: "Ada", selected: false },
        ],
      },
    ]);
    expect(workspaceUserMenuIsCustomized(scopes)).toBe(false);
  });

  it("names each environment when several have users, and follows the environment filter", () => {
    const input = {
      scopes: [
        {
          environmentId: work,
          users: [DEFAULT_WORKSPACE_USER, ada],
          view: { kind: "all" } as const,
        },
        {
          environmentId: home,
          users: [DEFAULT_WORKSPACE_USER, ada],
          view: { kind: "user", userId: ada.id } as const,
        },
      ],
      environments,
    };
    const all = buildWorkspaceUserMenuScopes({ ...input, selectedEnvironmentId: null });
    expect(all.map((scope) => scope.title)).toEqual(["User · Home", "User · Work"]);
    expect(workspaceUserMenuIsCustomized(all)).toBe(true);
    expect(
      buildWorkspaceUserMenuScopes({ ...input, selectedEnvironmentId: work }).map(
        (scope) => scope.title,
      ),
    ).toEqual(["User"]);
  });
});

describe("workspace user menu action ids", () => {
  it("round-trips every option and rejects anything else", () => {
    const scopes = buildWorkspaceUserMenuScopes({
      scopes: [
        { environmentId: home, users: [DEFAULT_WORKSPACE_USER, ada], view: { kind: "all" } },
        { environmentId: work, users: [DEFAULT_WORKSPACE_USER, ada], view: { kind: "all" } },
      ],
      environments,
      selectedEnvironmentId: null,
    });
    const actions = workspaceUserMenuActions(scopes);
    const workAda = actions[1]?.subactions?.[2]?.id;
    expect(workAda && parseWorkspaceUserMenuActionId(workAda, scopes)).toEqual({
      environmentId: work,
      key: "user:ada",
    });
    expect(parseWorkspaceUserMenuActionId(actions[0]!.id!, scopes)).toBeNull();
    expect(parseWorkspaceUserMenuActionId("environment:all", scopes)).toBeNull();
  });
});
