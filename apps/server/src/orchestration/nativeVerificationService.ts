import * as NodeCrypto from "node:crypto";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  CommandId,
  EventId,
  OrchestrationImplementationValidationResult,
  MessageId,
  NativeVerificationError,
  NativeVerificationResult,
  DEFAULT_WORKSPACE_USER_ID,
  type NativeVerificationRequest,
  type NativeVerificationResponse,
  type NativeVerificationHandoff,
  type NativeVerificationPlatform,
  type NativeVerificationAction,
  OrchestrationPlanningTicketId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as DateTime from "effect/DateTime";
import * as Path from "effect/Path";
import { GitVcsDriver } from "../vcs/GitVcsDriver.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { transitionNativeVerification } from "./nativeVerification.ts";

const encodeValidations = Schema.encodeSync(
  Schema.fromJsonString(Schema.Array(OrchestrationImplementationValidationResult)),
);

export const nativePlatformsForHost = (platform: string): NativeVerificationPlatform[] =>
  platform === "darwin"
    ? ["macos", "ios", "android"]
    : platform === "win32"
      ? ["windows", "android"]
      : ["android"];

/** Compare GitHub SSH and HTTPS remotes without copying embedded credentials into a handoff. */
export function nativeRepositoryUrl(remote: string): string | null {
  const match =
    /^(?:https:\/\/(?:[^/@]+@)?github\.com\/|git@github\.com:|ssh:\/\/git@github\.com\/)([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/.exec(
      remote.trim(),
    );
  return match ? `https://github.com/${match[1]}/${match[2]}.git` : null;
}

export function nativeVerificationPrompt(handoff: NativeVerificationHandoff): string {
  return [
    `Verify ${handoff.title} on ${handoff.claim?.platform}.`,
    handoff.instructionsMarkdown,
    `Required starting commit: ${handoff.commitSha}. Work only on branch ${handoff.branch}.`,
    `Assigned backend targets: ${handoff.previewTargets.join(", ") || "None. Ask the user to assign the required backend before runtime verification."}`,
    "Run the actual installed application or simulator required by the acceptance criteria. Unit tests alone do not establish native acceptance. Record the OS, application build, test commands, results, and inspectable screenshots or recordings. Do not mark unavailable platforms passed.",
    "Repair defects in this worktree when needed, run the affected checks, commit the repairs, and leave the worktree clean. The Submit action publishes the resulting commit and returns it to the original workflow. Do not push, merge into another branch, or claim other tickets.",
    "Finish with one fenced JSON object of type native-verification-result, containing a result object with status passed/failed/blocked, platform, commitSha, validations, summaryMarkdown, evidence, and completedAt. Each validation has command, status, outputMarkdown and completedAt. Evidence is an array of URLs accessible to the workflow owner. Keep failed commands and identify corrected passing retries with supersedesCommand. A blocked result must name the missing prerequisite and next action.",
    "The original workflow remains on the source server. Closing this machine does not release the claim; use Release in its Native verification panel to transfer it.",
  ].join("\n\n");
}

export function parseNativeVerificationResult(text: string): NativeVerificationResult | null {
  const decode = Schema.decodeUnknownOption(
    Schema.Struct({
      type: Schema.Literal("native-verification-result"),
      result: NativeVerificationResult,
    }),
  );
  for (const match of [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].toReversed()) {
    try {
      const parsed = decode(JSON.parse(match[1] ?? ""));
      if (Option.isSome(parsed)) return parsed.value.result;
    } catch {
      /* Incomplete fenced output cannot complete a handoff. */
    }
  }
  return null;
}

export const executeNativeVerification = Effect.fn("NativeVerification.execute")(function* (
  input: NativeVerificationRequest,
) {
  const query = yield* ProjectionSnapshotQuery;
  const engine = yield* OrchestrationEngineService;
  const driverOption = yield* Effect.serviceOption(GitVcsDriver);
  if (Option.isNone(driverOption))
    return yield* new NativeVerificationError({
      message: "Native verification is unavailable in this server configuration.",
    });
  const driver = driverOption.value;
  const path = yield* Path.Path;
  const hostPlatform = yield* HostProcessPlatform;
  const now = DateTime.formatIso(yield* DateTime.now);
  const readModel = yield* query.getCommandReadModel();
  const fail = (message: string) => new NativeVerificationError({ message });
  const git = (cwd: string, args: readonly string[]) =>
    driver.execute({ operation: "native verification", cwd, args, timeoutMs: 120_000 });
  const cleanHead = Effect.fn("NativeVerification.cleanHead")(function* (
    cwd: string,
    branch: string,
  ) {
    const status = yield* git(cwd, ["status", "--porcelain"]);
    if (status.stdout.trim())
      return yield* fail(
        "Commit or discard local changes before transferring native verification.",
      );
    const actualBranch = (yield* git(cwd, ["branch", "--show-current"])).stdout.trim();
    if (actualBranch !== branch)
      return yield* fail("The worktree is no longer on the expected branch.");
    return (yield* git(cwd, ["rev-parse", "HEAD"])).stdout.trim();
  });
  if (input.operation === "capabilities")
    return {
      type: "capabilities",
      platforms: nativePlatformsForHost(hostPlatform),
      projects: readModel.projects
        .filter((p) => p.deletedAt === null)
        .map((p) => ({ id: p.id, title: p.title })),
    } satisfies NativeVerificationResponse;

  if (
    input.operation === "checkout" ||
    input.operation === "report" ||
    input.operation === "release-check"
  ) {
    const { handoff } = input;
    const claim = handoff.claim;
    if (!claim || handoff.status !== "claimed")
      return yield* fail("Claim this handoff before opening it locally.");
    if (!nativePlatformsForHost(hostPlatform).includes(claim.platform))
      return yield* fail(
        `This ${hostPlatform} server cannot verify ${claim.platform}. Select the environment running on the target machine.`,
      );
    if (
      !/^[a-zA-Z0-9-]+$/.test(handoff.id) ||
      handoff.branch !== `t3-native/${handoff.id}` ||
      !/^[a-f0-9]{40,64}$/.test(handoff.commitSha)
    )
      return yield* fail("Invalid handoff branch or commit.");
    if (input.operation === "checkout") {
      if (input.projectId !== claim.projectId)
        return yield* fail("The local project does not match the claimed assignment.");
      const project = readModel.projects.find(
        (p) => p.id === input.projectId && p.deletedAt === null,
      );
      if (!project)
        return yield* fail("Select a local project containing a clone of this repository.");
      const remote = nativeRepositoryUrl(
        (yield* git(project.workspaceRoot, ["remote", "get-url", "origin"])).stdout,
      );
      if (remote === null || remote !== handoff.repositoryUrl)
        return yield* fail(
          "The selected local project's origin does not match the handoff repository.",
        );
      const existingThread = readModel.threads.find((thread) => thread.id === claim.threadId);
      if (existingThread) {
        if (
          existingThread.projectId !== project.id ||
          existingThread.branch !== handoff.branch ||
          !existingThread.worktreePath
        )
          return yield* fail("The claim's thread already belongs to another checkout.");
        const existingDetail = yield* query.getThreadDetailSnapshot(existingThread.id);
        const alreadyStarted =
          existingThread.latestTurn !== null ||
          (Option.isSome(existingDetail) &&
            existingDetail.value.thread.messages.some((message) => message.role === "user"));
        if (!alreadyStarted) {
          yield* engine.dispatch({
            type: "thread.turn.start",
            commandId: CommandId.make(NodeCrypto.randomUUID()),
            threadId: claim.threadId,
            message: {
              messageId: MessageId.make(NodeCrypto.randomUUID()),
              role: "user",
              text: nativeVerificationPrompt(handoff),
              attachments: [],
            },
            runtimeMode: "full-access",
            interactionMode: "default",
            modelSelection: existingThread.modelSelection,
            createdAt: now,
          });
        }
        return {
          type: "checkout",
          threadId: existingThread.id,
          worktreePath: existingThread.worktreePath,
        } satisfies NativeVerificationResponse;
      }
      yield* git(project.workspaceRoot, ["fetch", "origin", `refs/heads/${handoff.branch}`]);
      const fetched = (yield* git(project.workspaceRoot, [
        "rev-parse",
        "FETCH_HEAD",
      ])).stdout.trim();
      if (fetched !== handoff.commitSha)
        return yield* fail(
          "The published checkpoint changed. Release the claim and refresh the handoff.",
        );
      const worktreePath = path.join(`${project.workspaceRoot}.worktrees`, `native-${handoff.id}`);
      if (
        readModel.threads.some(
          (thread) =>
            thread.worktreePath === worktreePath &&
            (thread.latestTurn?.state === "running" ||
              thread.session?.activeTurnId ||
              thread.session?.status === "running" ||
              thread.session?.status === "starting"),
        )
      )
        return yield* fail(
          "A previous verification turn still uses this checkout. Stop it before transferring verification.",
        );
      const add = yield* driver.execute({
        operation: "native checkout",
        cwd: project.workspaceRoot,
        args: ["worktree", "add", "-b", handoff.branch, worktreePath, fetched],
        allowNonZeroExit: true,
      });
      if (add.exitCode !== 0) {
        const head = yield* cleanHead(worktreePath, handoff.branch);
        if (head !== handoff.commitSha) {
          yield* git(worktreePath, ["merge-base", "--is-ancestor", head, fetched]);
          yield* git(worktreePath, ["merge", "--ff-only", fetched]);
        }
      }
      const modelSelection =
        project.defaultModelSelection ??
        readModel.threads.find((thread) => thread.projectId === project.id)?.modelSelection;
      if (!modelSelection)
        return yield* fail(
          "Choose a default model for the local project before claiming native verification.",
        );
      yield* engine.dispatch({
        type: "thread.create",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId: claim.threadId,
        projectId: project.id,
        ownerUserId: DEFAULT_WORKSPACE_USER_ID,
        title: `Native verification: ${handoff.title}`,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: handoff.branch,
        worktreePath,
        createdAt: now,
      });
      yield* engine.dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(NodeCrypto.randomUUID()),
        threadId: claim.threadId,
        message: {
          messageId: MessageId.make(NodeCrypto.randomUUID()),
          role: "user",
          text: nativeVerificationPrompt(handoff),
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        modelSelection,
        createdAt: now,
      });
      return {
        type: "checkout",
        threadId: claim.threadId,
        worktreePath,
      } satisfies NativeVerificationResponse;
    }
    const detail = yield* query.getThreadDetailSnapshot(claim.threadId);
    if (Option.isNone(detail) && input.operation === "release-check")
      return { type: "idle" } satisfies NativeVerificationResponse;
    if (Option.isNone(detail) || !detail.value.thread.worktreePath)
      return yield* fail("The local verification thread was not found.");
    const thread = detail.value.thread;
    if (thread.projectId !== claim.projectId || thread.branch !== handoff.branch)
      return yield* fail("The local thread does not match this assignment.");
    if (
      thread.latestTurn?.state === "running" ||
      thread.session?.activeTurnId ||
      thread.session?.status === "running" ||
      thread.session?.status === "starting"
    )
      return yield* fail(
        "Stop or finish the local verification turn before submitting or releasing its claim.",
      );
    if (input.operation === "release-check")
      return { type: "idle" } satisfies NativeVerificationResponse;
    const result = [...thread.messages]
      .toReversed()
      .filter((message) => message.role === "assistant")
      .map((message) => parseNativeVerificationResult(message.text))
      .find((value) => value !== null);
    if (!result)
      return yield* fail(
        "The local thread has not produced a native-verification-result report yet.",
      );
    const head = yield* cleanHead(thread.worktreePath!, handoff.branch);
    if (result.commitSha !== head || result.platform !== claim.platform)
      return yield* fail("The report does not match the local HEAD and claimed platform.");
    yield* git(thread.worktreePath!, ["merge-base", "--is-ancestor", handoff.commitSha, head]);
    yield* git(thread.worktreePath!, ["push", "origin", `${head}:refs/heads/${handoff.branch}`]);
    return { type: "report", result } satisfies NativeVerificationResponse;
  }

  const run = readModel.implementationRuns.find((r) => r.id === input.runId);
  const ticket = run?.ticketStates.find((state) => state.ticketId === input.ticketId);
  if (!run || !ticket || !ticket.worktreePath || !ticket.branch || !ticket.workerThreadId)
    return yield* fail("This ticket has no implementation checkout to hand off.");
  const owner = readModel.threads.find((thread) => thread.id === run.orchestratorThreadId);
  const sourceThreadId = owner?.parentThreadId ?? run.orchestratorThreadId;
  const existing = ticket.nativeVerification;
  let action: NativeVerificationAction;
  if (input.operation === "prepare") {
    if (
      readModel.appReviewWorkflowRuns?.some(
        (review) => review.id === ticket.appReviewWorkflowRunId && review.status === "running",
      )
    )
      return yield* fail(
        "Finish or cancel the ticket's App Review before handing its checkout to another machine.",
      );
    const busy = readModel.threads.some(
      (thread) =>
        thread.worktreePath === ticket.worktreePath &&
        (thread.latestTurn?.state === "running" ||
          thread.session?.activeTurnId ||
          thread.session?.status === "running" ||
          thread.session?.status === "starting"),
    );
    if (busy)
      return yield* fail(
        "Stop or finish the ticket's active turn before preparing its native handoff.",
      );
    if (!ticket.workerResult)
      return yield* fail(
        "The ticket needs a committed implementation result before native verification can be handed off.",
      );
    const commitSha = yield* cleanHead(ticket.worktreePath, ticket.branch);
    const repositoryUrl = nativeRepositoryUrl(
      (yield* git(ticket.worktreePath, ["remote", "get-url", "origin"])).stdout,
    );
    if (!repositoryUrl)
      return yield* fail("Native handoff currently requires a GitHub origin using HTTPS or SSH.");
    const source = yield* query.getThreadDetailSnapshot(sourceThreadId);
    const plan = Option.isSome(source)
      ? source.value.thread.planningWorkflow?.tickets.find((item) => item.id === ticket.ticketId)
      : undefined;
    if (!plan) return yield* fail("The ticket's acceptance criteria could not be loaded.");
    const id = NodeCrypto.randomUUID();
    const branch = `t3-native/${id}`;
    const review = readModel.appReviewWorkflowRuns?.find(
      (r) => r.id === ticket.appReviewWorkflowRunId,
    );
    const handoff: NativeVerificationHandoff = {
      id,
      revision: 0,
      status: "ready",
      requiredPlatforms: input.platforms,
      repositoryUrl,
      branch,
      commitSha,
      sourceThreadId,
      runId: run.id,
      ticketId: ticket.ticketId,
      title: plan.title,
      instructionsMarkdown: `${plan.bodyMarkdown}\n\nNative acceptance plan:\n${plan.appReviewPlanMarkdown ?? "Use the ticket acceptance criteria."}\n\nPrior implementation notes:\n${ticket.workerResult.notesMarkdown}\n\nPrevious review:\n${ticket.warningMarkdown ?? "None"}\n\nPrior validations, preserve failures or explicitly supersede them with passing reruns:\n${encodeValidations(ticket.workerResult.validations)}`,
      previewTargets: review?.previewTargets ?? [],
      claim: null,
      results: [],
      createdAt: now,
      updatedAt: now,
    };
    action = { type: "prepare", handoff };
    const valid = transitionNativeVerification({
      run,
      ticketId: ticket.ticketId,
      expectedRevision: existing?.revision ?? null,
      action,
      now,
    });
    if (typeof valid === "string") return yield* fail(valid);
    yield* git(ticket.worktreePath, ["push", "origin", `${commitSha}:refs/heads/${branch}`]);
  } else {
    if (!existing) return yield* fail("Prepare a native handoff first.");
    action =
      input.operation === "claim"
        ? { type: "claim", claim: { ...input.claim, claimedAt: now } }
        : input.operation === "release"
          ? { type: "release", claimId: input.claimId }
          : input.operation === "cancel"
            ? { type: "cancel" }
            : { type: "submit", claimId: input.claimId, result: input.result };
    const valid = transitionNativeVerification({
      run,
      ticketId: ticket.ticketId,
      expectedRevision: input.revision,
      action,
      now,
    });
    if (typeof valid === "string") return yield* fail(valid);
    if (input.operation === "submit") {
      const head = yield* cleanHead(ticket.worktreePath, ticket.branch);
      if (head !== existing.commitSha && head !== input.result.commitSha)
        return yield* fail(
          "The original ticket changed after handoff. Prepare a new checkpoint and verify that commit.",
        );
      yield* git(ticket.worktreePath, ["fetch", "origin", `refs/heads/${existing.branch}`]);
      const returned = (yield* git(ticket.worktreePath, ["rev-parse", "FETCH_HEAD"])).stdout.trim();
      if (returned !== input.result.commitSha)
        return yield* fail("The result's commit does not match the published verification branch.");
      yield* git(ticket.worktreePath, [
        "merge-base",
        "--is-ancestor",
        existing.commitSha,
        returned,
      ]);
      yield* git(ticket.worktreePath, ["merge", "--ff-only", returned]);
    }
  }
  yield* engine.dispatch({
    type: "thread.native-verification.update",
    commandId: CommandId.make(NodeCrypto.randomUUID()),
    threadId: sourceThreadId,
    runId: run.id,
    ticketId: OrchestrationPlanningTicketId.make(ticket.ticketId),
    expectedRevision: input.operation === "prepare" ? (existing?.revision ?? null) : input.revision,
    action,
    createdAt: now,
  });
  const updated = yield* query.getCommandReadModel();
  const handoff = updated.implementationRuns
    .find((r) => r.id === run.id)
    ?.ticketStates.find((t) => t.ticketId === ticket.ticketId)?.nativeVerification;
  if (!handoff) return yield* fail("The handoff update has not reached the read model yet.");
  yield* engine.dispatch({
    type: "thread.activity.append",
    commandId: CommandId.make(NodeCrypto.randomUUID()),
    threadId: run.orchestratorThreadId,
    activity: {
      id: EventId.make(NodeCrypto.randomUUID()),
      kind: "implementation-native-verification-updated",
      tone: "info",
      summary: `Native verification ${handoff.status}`,
      payload: { runId: run.id, ticketId: ticket.ticketId },
      turnId: null,
      createdAt: now,
    },
    createdAt: now,
  });
  return { type: "handoff", handoff } satisfies NativeVerificationResponse;
});
