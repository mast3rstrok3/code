import {
  DEFAULT_WORKSPACE_USER,
  DEFAULT_WORKSPACE_USER_ID,
  WorkspaceUserId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { resolveDefaultThreadOwnerUserId } from "./workspaceUsers";

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
