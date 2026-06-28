import { WorkspaceUserId, type WorkspaceUser } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  clearWorkspaceUserGithubPersonalAccessToken,
  createWorkspaceUser,
  renameWorkspaceUser,
  replaceWorkspaceUserGithubPersonalAccessToken,
  validateAddWorkspaceUser,
  validateRenameWorkspaceUser,
} from "./UsersSettings.logic";

function user(input: {
  readonly id: string;
  readonly displayName: string;
  readonly github?: WorkspaceUser["github"];
}): WorkspaceUser {
  return {
    id: WorkspaceUserId.make(input.id),
    displayName: input.displayName,
    github: input.github ?? { personalAccessToken: "" },
  };
}

describe("createWorkspaceUser", () => {
  it("produces a unique id and empty GitHub settings", () => {
    const existingUsers = [user({ id: "alice", displayName: "Alice Work" })];

    expect(createWorkspaceUser(" Alice ", existingUsers)).toEqual({
      id: "alice-2",
      displayName: "Alice",
      github: { personalAccessToken: "" },
    });
  });
});

describe("renameWorkspaceUser", () => {
  it("preserves the existing github object", () => {
    const github: WorkspaceUser["github"] = {
      personalAccessToken: "",
      personalAccessTokenRedacted: true,
    };
    const existingUsers = [user({ id: "alice", displayName: "Alice", github })];

    const nextUsers = renameWorkspaceUser(
      existingUsers,
      WorkspaceUserId.make("alice"),
      "Alice Work",
    );

    expect(nextUsers?.[0]).toEqual({
      id: "alice",
      displayName: "Alice Work",
      github,
    });
    expect(nextUsers?.[0]?.github).toBe(github);
  });
});

describe("workspace user GitHub token updates", () => {
  it("trims replacement tokens and marks redaction false for server persistence", () => {
    const existingUsers = [
      user({
        id: "alice",
        displayName: "Alice",
        github: { personalAccessToken: "", personalAccessTokenRedacted: true },
      }),
    ];

    expect(
      replaceWorkspaceUserGithubPersonalAccessToken(
        existingUsers,
        WorkspaceUserId.make("alice"),
        "  ghp_token  ",
      ),
    ).toEqual([
      {
        id: "alice",
        displayName: "Alice",
        github: {
          personalAccessToken: "ghp_token",
          personalAccessTokenRedacted: false,
        },
      },
    ]);
  });

  it("sends an empty token and redaction false when clearing", () => {
    const existingUsers = [
      user({
        id: "alice",
        displayName: "Alice",
        github: { personalAccessToken: "", personalAccessTokenRedacted: true },
      }),
    ];

    expect(
      clearWorkspaceUserGithubPersonalAccessToken(existingUsers, WorkspaceUserId.make("alice")),
    ).toEqual([
      {
        id: "alice",
        displayName: "Alice",
        github: {
          personalAccessToken: "",
          personalAccessTokenRedacted: false,
        },
      },
    ]);
  });
});

describe("workspace user validation", () => {
  it("rejects blank and duplicate add actions", () => {
    const existingUsers = [user({ id: "alice", displayName: "Alice" })];

    expect(validateAddWorkspaceUser("   ", existingUsers)).toEqual({
      valid: false,
      reason: "blank",
    });
    expect(validateAddWorkspaceUser(" alice ", existingUsers)).toEqual({
      valid: false,
      reason: "duplicate",
    });
    expect(createWorkspaceUser(" alice ", existingUsers)).toBeNull();
  });

  it("rejects blank and duplicate rename actions", () => {
    const existingUsers = [
      user({ id: "alice", displayName: "Alice" }),
      user({ id: "bob", displayName: "Bob" }),
    ];
    const alice = existingUsers[0]!;

    expect(
      validateRenameWorkspaceUser({
        user: alice,
        displayName: "   ",
        workspaceUsers: existingUsers,
      }),
    ).toEqual({ valid: false, reason: "blank" });
    expect(
      validateRenameWorkspaceUser({
        user: alice,
        displayName: " bob ",
        workspaceUsers: existingUsers,
      }),
    ).toEqual({ valid: false, reason: "duplicate" });
    expect(renameWorkspaceUser(existingUsers, WorkspaceUserId.make("alice"), "Bob")).toBeNull();
  });
});
