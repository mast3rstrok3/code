import { WorkspaceUserId, type WorkspaceUser } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  createWorkspaceUserIdFromDisplayName,
  hasWorkspaceUserDisplayNameConflict,
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
