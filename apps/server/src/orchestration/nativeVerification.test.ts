import { describe, it, expect } from "vite-plus/test";
import {
  NativeVerificationHandoff,
  OrchestrationImplementationRun,
  ThreadId,
  ProjectId,
  type NativeVerificationAction,
  type NativeVerificationResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { transitionNativeVerification } from "./nativeVerification.ts";
import {
  nativeRepositoryUrl,
  nativePlatformsForHost,
  parseNativeVerificationResult,
} from "./nativeVerificationService.ts";

const now = "2026-09-09T10:00:00.000Z";
const commit = "a".repeat(40);
const handoff = Schema.decodeUnknownSync(NativeVerificationHandoff)({
  id: "handoff-1",
  revision: 0,
  status: "ready",
  requiredPlatforms: ["macos", "ios"],
  repositoryUrl: "https://github.com/example/app.git",
  branch: "t3-native/handoff-1",
  commitSha: commit,
  sourceThreadId: "source",
  runId: "run-1",
  ticketId: "ticket-1",
  title: "Native capture",
  instructionsMarkdown: "Verify installed capture.",
  previewTargets: [],
  claim: null,
  results: [],
  createdAt: now,
  updatedAt: now,
});
const branchInfo = {
  baseBranch: "dev",
  pinnedCommit: commit,
  orchestratorBranch: "feature",
  orchestratorWorktreePath: "/repo/feature",
};
const decodeRun = Schema.decodeUnknownSync(OrchestrationImplementationRun);
const makeRun = () =>
  decodeRun({
    id: "run-1",
    specId: "spec-1",
    planningTicketIds: ["ticket-1", "ticket-2"],
    orchestratorThreadId: "orchestrator",
    status: "needs-human-attention",
    ...branchInfo,
    launchSummary: {
      specId: "spec-1",
      planningTicketIds: ["ticket-1", "ticket-2"],
      ...branchInfo,
      validationCommands: [],
      createdAt: now,
    },
    ticketStates: [
      {
        ticketId: "ticket-1",
        status: "failed",
        dependencyTicketIds: [],
        branch: "ticket-1",
        worktreePath: "/repo/ticket-1",
        workerThreadId: "worker",
        workerResult: {
          ticketId: "ticket-1",
          workerThreadId: "worker",
          branch: "ticket-1",
          worktreePath: "/repo/ticket-1",
          status: "failed",
          commitSha: commit,
          validations: [],
          notesMarkdown: "Needs native acceptance",
          reportedAt: now,
        },
        updatedAt: now,
      },
      {
        ticketId: "ticket-2",
        status: "failed",
        dependencyTicketIds: ["ticket-1"],
        warningMarkdown: "Blocked by failed dependency: ticket-1.",
        updatedAt: now,
      },
      { ticketId: "independent", status: "ready", dependencyTicketIds: [], updatedAt: now },
    ],
    automationHalt: {
      ticketId: "ticket-1",
      stage: "implementation",
      category: "review-blocked",
      detail: "Native OS unavailable",
      haltedAt: now,
    },
    createdAt: now,
    updatedAt: now,
  });
const apply = (run: OrchestrationImplementationRun, action: NativeVerificationAction) => {
  const result = transitionNativeVerification({
    run,
    ticketId: "ticket-1",
    expectedRevision: run.ticketStates[0]?.nativeVerification?.revision ?? null,
    action,
    now,
  });
  if (typeof result === "string") throw new Error(result);
  return result;
};
const claim = (platform: "macos" | "ios" = "macos") => ({
  type: "claim" as const,
  claim: {
    id: `claim-${platform}`,
    environmentId: "mac",
    environmentLabel: "MacBook",
    threadId: ThreadId.make(`native-${platform}`),
    projectId: ProjectId.make("local-project"),
    platform,
    claimedAt: now,
  },
});
const report = (platform: "macos" | "ios", commitSha = commit): NativeVerificationResult => ({
  status: "passed",
  platform,
  commitSha,
  validations: [
    {
      command: "native acceptance",
      status: "passed",
      outputMarkdown: "Installed app passed capture and insertion.",
      completedAt: now,
    },
  ],
  summaryMarkdown: "Native acceptance passed.",
  evidence: ["https://evidence.example/native.mp4"],
  completedAt: now,
});

describe("native verification handoffs", () => {
  it("parks native verification, restores dependent tickets to blocked, and leaves independent work ready", () => {
    const run = apply(makeRun(), { type: "prepare", handoff });
    expect(run.status).toBe("running");
    expect(run.automationHalt).toBeNull();
    expect(run.ticketStates.map((ticket) => ticket.status)).toEqual([
      "awaiting-native-verification",
      "blocked",
      "ready",
    ]);
    expect(run.ticketStates[0]?.workerResult?.status).toBe("failed");
    expect(decodeRun(run)).toEqual(run);
  });
  it("preserves a claim across reload and refuses a second owner or stale revision", () => {
    const run = apply(apply(makeRun(), { type: "prepare", handoff }), claim());
    const reload = decodeRun(JSON.parse(JSON.stringify(run)));
    expect(reload.ticketStates[0]?.nativeVerification?.claim?.environmentId).toBe("mac");
    expect(() => apply(reload, claim("ios"))).toThrow("already owns");
    expect(
      transitionNativeVerification({
        run,
        ticketId: "ticket-1",
        expectedRevision: 0,
        action: { type: "release", claimId: "claim-macos" },
        now,
      }),
    ).toContain("changed");
    expect(() => apply(reload, { type: "release", claimId: "stale" })).toThrow("no longer current");
  });
  it("requires every requested platform at the same commit before continuing reviews", () => {
    let run = apply(apply(makeRun(), { type: "prepare", handoff }), claim());
    run = apply(run, { type: "submit", claimId: "claim-macos", result: report("macos") });
    expect(run.ticketStates[0]?.status).toBe("awaiting-native-verification");
    run = apply(run, claim("ios"));
    const repaired = "b".repeat(40);
    run = apply(run, { type: "submit", claimId: "claim-ios", result: report("ios", repaired) });
    expect(run.ticketStates[0]?.nativeVerification?.status).toBe("ready");
    run = apply(run, claim());
    run = apply(run, { type: "submit", claimId: "claim-macos", result: report("macos", repaired) });
    expect(run.ticketStates[0]?.nativeVerification?.status).toBe("completed");
    expect(run.ticketStates[0]?.status).toBe("running");
    expect(run.ticketStates[0]?.workerResult).toMatchObject({
      status: "succeeded",
      commitSha: repaired,
    });
    expect(run.ticketStates[0]?.nativeVerification?.results).toHaveLength(3);
  });
  it("rejects the wrong platform, missing evidence, and a pass with unresolved failures", () => {
    const run = apply(apply(makeRun(), { type: "prepare", handoff }), claim());
    for (const result of [
      report("ios"),
      { ...report("macos"), evidence: [] },
      {
        ...report("macos"),
        validations: [{ ...report("macos").validations[0]!, status: "failed" as const }],
      },
    ]) {
      expect(() => apply(run, { type: "submit", claimId: "claim-macos", result })).toThrow();
    }
    const blocked = apply(run, {
      type: "submit",
      claimId: "claim-macos",
      result: { ...report("macos"), status: "blocked" },
    });
    expect(blocked.ticketStates[0]?.nativeVerification?.status).toBe("ready");
    expect(blocked.ticketStates[0]?.status).toBe("awaiting-native-verification");
  });
  it("preserves unrelated failures and earlier E2E validation failures", () => {
    const initial = makeRun();
    const runWithFailures = {
      ...initial,
      ticketStates: initial.ticketStates
        .map((state) =>
          state.workerResult
            ? {
                ...state,
                workerResult: {
                  ...state.workerResult,
                  validations: [
                    {
                      command: "backend e2e",
                      status: "failed" as const,
                      outputMarkdown: "Missing assertion",
                      completedAt: now,
                    },
                  ],
                },
              }
            : state,
        )
        .concat([
          {
            ...initial.ticketStates[1]!,
            ticketId: initial.ticketStates[2]!.ticketId,
            dependencyTicketIds: [],
            warningMarkdown: "Blocked by failed dependency: unrelated.",
          },
        ]),
    };
    let run = apply(runWithFailures, {
      type: "prepare",
      handoff: { ...handoff, requiredPlatforms: ["macos"] },
    });
    expect(run.ticketStates.at(-1)?.status).toBe("failed");
    run = apply(run, claim());
    run = apply(run, { type: "submit", claimId: "claim-macos", result: report("macos") });
    expect(run.ticketStates[0]?.workerResult?.validations).toContainEqual({
      command: "backend e2e",
      status: "failed",
      outputMarkdown: "Missing assertion",
      completedAt: now,
    });
  });

  it("invalidates released claims and retains canceled handoff history", () => {
    let run = apply(apply(makeRun(), { type: "prepare", handoff }), claim());
    run = apply(run, { type: "release", claimId: "claim-macos" });
    expect(() =>
      apply(run, { type: "submit", claimId: "claim-macos", result: report("macos") }),
    ).toThrow();
    run = apply(run, { type: "cancel" });
    expect(run.ticketStates[0]?.nativeVerification?.status).toBe("canceled");
    expect(run.ticketStates[0]?.status).toBe("awaiting-native-verification");
  });
});

it("accepts supported GitHub remotes without exporting credentials", () => {
  for (const remote of [
    "git@github.com:example/app.git",
    "https://token@github.com/example/app.git",
    "https://github.com/example/app",
  ])
    expect(nativeRepositoryUrl(remote)).toBe("https://github.com/example/app.git");
  for (const remote of ["ext::command", "file:///repo", "https://github.com.evil/example/app"])
    expect(nativeRepositoryUrl(remote)).toBeNull();
});
it("does not advertise Apple verification on Linux or accept prose as a result", () => {
  expect(nativePlatformsForHost("linux")).not.toContain("macos");
  expect(nativePlatformsForHost("darwin")).toContain("ios");
  expect(parseNativeVerificationResult("All tests passed")).toBeNull();
  expect(
    parseNativeVerificationResult(
      "```json\n" +
        JSON.stringify({ type: "native-verification-result", result: report("macos") }) +
        "\n```",
    ),
  ).toEqual(report("macos"));
});
