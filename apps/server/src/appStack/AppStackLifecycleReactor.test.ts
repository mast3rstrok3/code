import { describe, expect, it } from "@effect/vitest";
import { AppStack, ProjectId, ThreadId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { settledStackGroups } from "./AppStackLifecycleReactor.ts";

const at = "2026-11-01T00:00:00.000Z";
const decodeStack = Schema.decodeSync(AppStack);
const stack = (id: string, worktreePath: string, extra: Partial<AppStack> = {}): AppStack => ({
  ...decodeStack({
    id,
    uuid: id,
    userId: "user",
    worktreePath,
    composePath: "infra/compose/compose.app-dev.yml",
    displayName: id,
    description: null,
    status: "running",
    services: [],
    serviceCount: 0,
    lastError: null,
    errorCount: 0,
    createdAt: at,
    updatedAt: at,
  }),
  ...extra,
});
const settled = { settledOverride: "settled", settledAt: null } as const;
const thread = (
  id: string,
  worktreePath: string | null,
  extra: Partial<Parameters<typeof settledStackGroups>[0]["threads"][number]> = {},
) => ({
  id: ThreadId.make(id),
  projectId: ProjectId.make("project"),
  worktreePath,
  status: "idle" as const,
  pendingRuntimeRequest: null,
  settledOverride: null,
  settledAt: null,
  ...extra,
});
const workspaceRoots = new Map([[ProjectId.make("project"), "/repo"]]);
const stopped = (input: Omit<Parameters<typeof settledStackGroups>[0], "workspaceRoots">) =>
  settledStackGroups({ ...input, workspaceRoots }).map((group) => group.map((member) => member.id));

describe("settledStackGroups", () => {
  it("stops a worktree's stacks only once every thread on it settles", () => {
    const stacks = [stack("dev", "/wt/a/"), stack("prod", "/wt/a", { variant: "prod" })];
    expect(stopped({ stacks, threads: [thread("one", "/wt/a", settled)] })).toEqual([
      ["dev"],
      ["prod"],
    ]);
    const shared = [thread("one", "/wt/a", settled), thread("two", "/wt/a")];
    expect(stopped({ stacks, threads: shared })).toEqual([]);
  });

  it("resolves a thread without a worktree to its project directory", () => {
    expect(
      stopped({ stacks: [stack("root", "/repo")], threads: [thread("one", null, settled)] }),
    ).toEqual([["root"]]);
  });

  it.each([
    ["a standing dev deployment", [stack("s", "/wt/a", { branchName: "dev" })]],
    ["a standing main deployment", [stack("s", "/wt/a", { branchName: "main" })]],
    [
      "a bundle with a protected member",
      [
        stack("a", "/wt/a", { bundleId: "b" }),
        stack("b", "/wt/b", { bundleId: "b", protected: true }),
      ],
    ],
    ["a stopped stack", [stack("s", "/wt/a", { status: "stopped" })]],
  ])("keeps %s", (_name, stacks) => {
    expect(stopped({ stacks, threads: [thread("one", "/wt/a", settled)] })).toEqual([]);
  });

  it("stops a bundle as one group unless another of its worktrees is in use", () => {
    const stacks = [stack("a", "/wt/a", { bundleId: "b" }), stack("b", "/wt/b", { bundleId: "b" })];
    expect(stopped({ stacks, threads: [thread("one", "/wt/a", settled)] })).toEqual([["a", "b"]]);
    expect(
      stopped({ stacks, threads: [thread("one", "/wt/a", settled), thread("two", "/wt/b")] }),
    ).toEqual([]);
  });

  it.each([
    ["a queued turn", { status: "queued" as const }],
    ["a running turn", { status: "running" as const }],
    ["a pending question", { pendingRuntimeRequest: { id: "request" } as never }],
  ])("keeps a settled thread's stack while it has %s", (_name, extra) => {
    expect(
      stopped({
        stacks: [stack("s", "/wt/a")],
        threads: [thread("one", "/wt/a", { ...settled, ...extra })],
      }),
    ).toEqual([]);
  });

  it("ignores a settlement event of a thread that no longer uses the stack", () => {
    const threads = [thread("one", "/wt/a", settled)];
    expect(
      stopped({ stacks: [stack("s", "/wt/a")], threads, threadId: ThreadId.make("other") }),
    ).toEqual([]);
    expect(stopped({ stacks: [stack("s", "/wt/a")], threads, threadId: threads[0]!.id })).toEqual([
      ["s"],
    ]);
  });
});
