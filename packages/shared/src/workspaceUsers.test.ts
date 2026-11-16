import {
  DEFAULT_WORKSPACE_USER,
  DEFAULT_WORKSPACE_USER_ID,
  WorkspaceUserId,
  type WorkspaceUser,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createWorkspaceUserIdFromDisplayName,
  hasWorkspaceUserDisplayNameConflict,
  isOwnedByWorkspaceUserView,
  isProjectGroupOwnedBy,
  resolveDefaultThreadOwnerUserId,
  workspaceUserScopePatch,
} from "./workspaceUsers.ts";

function user(id: string, displayName: string): WorkspaceUser {
  return {
    id: WorkspaceUserId.make(id),
    displayName,
    github: { personalAccessToken: "" },
  };
}

describe("createWorkspaceUserIdFromDisplayName", () => {
  it("generates slugs from ordinary names", () => {
    expect(createWorkspaceUserIdFromDisplayName("Alice Smith", [])).toBe("alice-smith");
  });

  it("normalizes punctuation and whitespace runs", () => {
    expect(createWorkspaceUserIdFromDisplayName("  Alice -- Work.Profile  ", [])).toBe(
      "alice-work-profile",
    );
  });

  it("falls back to user for empty slug inputs", () => {
    expect(createWorkspaceUserIdFromDisplayName("  !!!  ", [])).toBe("user");
  });

  it("adds suffixes for id collisions", () => {
    expect(
      createWorkspaceUserIdFromDisplayName("Alice Smith", [
        user("alice-smith", "Alice Smith"),
        user("alice-smith-2", "Alice Work"),
      ]),
    ).toBe("alice-smith-3");
  });
});

describe("hasWorkspaceUserDisplayNameConflict", () => {
  it("detects display-name conflicts case-insensitively", () => {
    expect(
      hasWorkspaceUserDisplayNameConflict(" alice smith ", [user("alice", "Alice Smith")]),
    ).toBe(true);
  });

  it("ignores the current user id during rename validation", () => {
    const alice = user("alice", "Alice Smith");
    expect(
      hasWorkspaceUserDisplayNameConflict(" alice smith ", [alice], WorkspaceUserId.make("alice")),
    ).toBe(false);
  });
});

describe("new thread ownership", () => {
  const ada = { ...DEFAULT_WORKSPACE_USER, id: WorkspaceUserId.make("ada"), displayName: "Ada" };
  it("uses the active user independently of the thread view", () => {
    for (const activeWorkspaceUserView of [
      { kind: "all" },
      { kind: "user", userId: DEFAULT_WORKSPACE_USER_ID },
    ]) {
      const settings = {
        activeWorkspaceUserId: ada.id,
        activeWorkspaceUserView,
        workspaceUsers: [DEFAULT_WORKSPACE_USER, ada],
      };
      expect(resolveDefaultThreadOwnerUserId(settings)).toBe(ada.id);
    }
  });
  it("falls back to the default when a saved user no longer exists", () => {
    expect(
      resolveDefaultThreadOwnerUserId({
        activeWorkspaceUserId: ada.id,
        workspaceUsers: [DEFAULT_WORKSPACE_USER],
      }),
    ).toBe(DEFAULT_WORKSPACE_USER_ID);
  });
});

describe("project picker ownership", () => {
  const ada = WorkspaceUserId.make("ada");
  const nils = DEFAULT_WORKSPACE_USER_ID;
  it("offers a project group when any of its checkouts belongs to the acting user", () => {
    const adasCheckout = { ownerUserId: ada };
    const nilsCheckout = { ownerUserId: nils };
    expect(isProjectGroupOwnedBy({ memberProjects: [adasCheckout] }, nils)).toBe(false);
    expect(isProjectGroupOwnedBy({ memberProjects: [adasCheckout, nilsCheckout] }, nils)).toBe(
      true,
    );
  });
});

describe("sidebar user scope", () => {
  it("acts as the person it shows", () => {
    expect(workspaceUserScopePatch("user:ada")).toEqual({
      activeWorkspaceUserId: "ada",
      activeWorkspaceUserView: { kind: "user", userId: "ada" },
    });
  });
  it("widens to everyone without changing the acting user", () => {
    expect(workspaceUserScopePatch("all")).toEqual({ activeWorkspaceUserView: { kind: "all" } });
  });
});

describe("isOwnedByWorkspaceUserView", () => {
  const ada = WorkspaceUserId.make("ada");
  it("treats records without an owner as the default user's", () => {
    expect(
      isOwnedByWorkspaceUserView({}, { kind: "user", userId: DEFAULT_WORKSPACE_USER_ID }),
    ).toBe(true);
    expect(isOwnedByWorkspaceUserView({}, { kind: "user", userId: ada })).toBe(false);
  });
  it("matches every owner for everyone", () => {
    expect(isOwnedByWorkspaceUserView({ ownerUserId: ada }, { kind: "all" })).toBe(true);
  });
});
