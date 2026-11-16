import {
  DEFAULT_WORKSPACE_USER,
  DEFAULT_WORKSPACE_USER_ID,
  EnvironmentId,
  WorkspaceUserId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterProjectsForActingUsers,
  resolveWorkspaceUserScope,
  selectWorkspaceUserScope,
} from "./workspaceUserScope";

const ada = { ...DEFAULT_WORKSPACE_USER, id: WorkspaceUserId.make("ada"), displayName: "Ada" };
const users = [DEFAULT_WORKSPACE_USER, ada];

describe("resolveWorkspaceUserScope", () => {
  it("keeps the saved view until the server's users load", () => {
    expect(
      resolveWorkspaceUserScope(
        { activeUserId: ada.id, view: { kind: "user", userId: ada.id } },
        null,
      ),
    ).toEqual({ view: { kind: "user", userId: ada.id }, actingUserId: ada.id });
  });

  it("falls back to everyone and the default user once a saved user is gone", () => {
    expect(
      resolveWorkspaceUserScope({ activeUserId: ada.id, view: { kind: "user", userId: ada.id } }, [
        DEFAULT_WORKSPACE_USER,
        { ...ada, id: WorkspaceUserId.make("grace") },
      ]),
    ).toEqual({ view: { kind: "all" }, actingUserId: DEFAULT_WORKSPACE_USER_ID });
  });

  it("shows everyone on a single-user server, which has no switcher to undo a narrow view", () => {
    expect(
      resolveWorkspaceUserScope({ view: { kind: "user", userId: DEFAULT_WORKSPACE_USER_ID } }, [
        DEFAULT_WORKSPACE_USER,
      ]).view,
    ).toEqual({ kind: "all" });
  });

  it("acts as the saved user while viewing everyone", () => {
    expect(
      resolveWorkspaceUserScope({ activeUserId: ada.id, view: { kind: "all" } }, users),
    ).toEqual({ view: { kind: "all" }, actingUserId: ada.id });
  });
});

describe("selectWorkspaceUserScope", () => {
  it("shows and acts as the picked person", () => {
    expect(selectWorkspaceUserScope(undefined, "user:ada")).toEqual({
      activeUserId: "ada",
      view: { kind: "user", userId: "ada" },
    });
  });

  it("widens to everyone without changing the acting user", () => {
    expect(
      selectWorkspaceUserScope(
        { activeUserId: ada.id, view: { kind: "user", userId: ada.id } },
        "all",
      ),
    ).toEqual({ activeUserId: ada.id, view: { kind: "all" } });
  });
});

describe("filterProjectsForActingUsers", () => {
  const home = EnvironmentId.make("home");
  const work = EnvironmentId.make("work");
  const projects = [
    { id: "nils-home", environmentId: home },
    { id: "ada-home", environmentId: home, ownerUserId: ada.id },
    { id: "ada-work", environmentId: work, ownerUserId: ada.id },
  ];

  it("offers each environment's acting user only their own projects", () => {
    expect(
      filterProjectsForActingUsers(projects, new Map([[home, DEFAULT_WORKSPACE_USER_ID]])).map(
        (project) => project.id,
      ),
    ).toEqual(["nils-home", "ada-work"]);
  });

  it("keeps shared projects for everyone", () => {
    expect(
      filterProjectsForActingUsers(
        projects,
        new Map([
          [home, ada.id],
          [work, DEFAULT_WORKSPACE_USER_ID],
        ]),
        (project) => project.id === "nils-home",
      ).map((project) => project.id),
    ).toEqual(["nils-home", "ada-home"]);
  });
});
