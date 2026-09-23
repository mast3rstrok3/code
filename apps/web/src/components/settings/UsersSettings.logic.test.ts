import { WorkspaceUserId, type WorkspaceUser } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  addWorkspaceUserGithubOwnerToken,
  clearWorkspaceUserGithubPersonalAccessToken,
  createWorkspaceUser,
  githubFineGrainedTokenUrl,
  removeWorkspaceUserGithubOwnerToken,
  renameWorkspaceUser,
  replaceWorkspaceUserGithubOwnerToken,
  replaceWorkspaceUserGithubPersonalAccessToken,
  validateAddGithubOwnerToken,
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

describe("workspace user GitHub owner tokens", () => {
  const ada = user({
    id: "ada",
    displayName: "Ada",
    github: {
      personalAccessToken: "",
      personalAccessTokenRedacted: true,
      ownerTokens: [{ owner: "Acme", personalAccessToken: "", personalAccessTokenRedacted: true }],
    },
  });

  it("rejects invalid, duplicate, and tokenless owners", () => {
    expect(validateAddGithubOwnerToken(ada, "", "token")).toEqual({
      valid: false,
      reason: "blank-owner",
    });
    expect(validateAddGithubOwnerToken(ada, "acme/widgets", "token")).toEqual({
      valid: false,
      reason: "invalid-owner",
    });
    expect(validateAddGithubOwnerToken(ada, "acme", "token")).toEqual({
      valid: false,
      reason: "duplicate-owner",
    });
    expect(validateAddGithubOwnerToken(ada, "other-org", " ")).toEqual({
      valid: false,
      reason: "blank-token",
    });
  });

  it("adds, replaces, and removes one owner without touching the others", () => {
    const added = addWorkspaceUserGithubOwnerToken([ada], ada.id, " other-org ", " new-token ");
    expect(added?.[0]?.github).toEqual({
      ...ada.github,
      ownerTokens: [
        ...(ada.github.ownerTokens ?? []),
        {
          owner: "other-org",
          personalAccessToken: "new-token",
          personalAccessTokenRedacted: false,
        },
      ],
    });

    const replaced = replaceWorkspaceUserGithubOwnerToken(added!, ada.id, "Acme", "acme-2");
    expect(replaced?.[0]?.github.ownerTokens?.[0]).toEqual({
      owner: "Acme",
      personalAccessToken: "acme-2",
      personalAccessTokenRedacted: false,
    });
    expect(replaced?.[0]?.github.ownerTokens?.[1]).toEqual(added?.[0]?.github.ownerTokens?.[1]);

    const removed = removeWorkspaceUserGithubOwnerToken(replaced!, ada.id, "Acme");
    expect(removed?.[0]?.github.ownerTokens?.map((token) => token.owner)).toEqual(["other-org"]);
    expect(removed?.[0]?.github.personalAccessTokenRedacted).toBe(true);
  });

  it("keeps owner tokens when the default token changes", () => {
    const cleared = clearWorkspaceUserGithubPersonalAccessToken([ada], ada.id);
    expect(cleared?.[0]?.github.ownerTokens).toEqual(ada.github.ownerTokens);
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

describe("githubFineGrainedTokenUrl", () => {
  it("targets the owner and pre-fills the permissions threads need", () => {
    const url = new URL(githubFineGrainedTokenUrl(" Acme "));
    expect(url.origin + url.pathname).toBe(
      "https://github.com/settings/personal-access-tokens/new",
    );
    expect(Object.fromEntries(url.searchParams)).toMatchObject({
      name: "T3 Code Acme",
      target_name: "Acme",
      contents: "write",
      pull_requests: "write",
      statuses: "read",
      actions: "read",
    });
  });

  it("leaves the owner to GitHub's default account and keeps the name within 40 characters", () => {
    expect(new URL(githubFineGrainedTokenUrl()).searchParams.has("target_name")).toBe(false);
    const long = new URL(githubFineGrainedTokenUrl("a".repeat(39)));
    expect(long.searchParams.get("name")?.length).toBe(40);
  });
});
