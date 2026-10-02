import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_WORKSPACE_USER_ID,
  MessageId,
  OrchestrationPlanningSpecId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkflowId,
  WorkspaceUserId,
  type OrchestrationEvent,
  type OrchestrationProject,
  type OrchestrationReadModel,
  type OrchestrationThread,
  type ThreadPlanningTicketArtifactInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";

const now = "2026-01-01T00:00:00.000Z";
const rudi = ProjectId.make("project-rudi");
const medical = ProjectId.make("project-medical-repository");
const rudiClone = ProjectId.make("project-rudi-signing");
const someoneElses = ProjectId.make("project-chat-other-owner");
const planningThreadId = ThreadId.make("thread-planning");
const specId = OrchestrationPlanningSpecId.make("spec-1");

function project(
  id: ProjectId,
  workspaceRoot: string,
  overrides: Partial<OrchestrationProject> = {},
): OrchestrationProject {
  return {
    id,
    ownerUserId: DEFAULT_WORKSPACE_USER_ID,
    title: id,
    workspaceRoot,
    repositoryIdentity: {
      canonicalKey: `github.com/nightingale/${workspaceRoot.split("/").at(-1)}`,
      locator: { source: "git-remote", remoteName: "origin", remoteUrl: workspaceRoot },
    },
    defaultModelSelection: null,
    defaultThreadEnvMode: null,
    scripts: [],
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    ...overrides,
  };
}

function planningThread(stage: "spec-authoring" | "tickets-authoring"): OrchestrationThread {
  return {
    pullRequests: [],
    id: planningThreadId,
    projectId: rudi,
    ownerUserId: DEFAULT_WORKSPACE_USER_ID,
    parentThreadId: null,
    workflowRole: null,
    title: "Planning",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6" },
    runtimeMode: "full-access",
    interactionMode: "planning-workflow",
    branch: "dev",
    worktreePath: "/repos/rudi.worktrees/studies",
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    messages: [],
    proposedPlans: [],
    planningWorkflow: {
      stage,
      createTicketsAvailable: false,
      spec:
        stage === "spec-authoring"
          ? null
          : {
              id: specId,
              title: "Studies",
              summaryMarkdown: "Serve studies to Rudi.",
              tenantId: null,
              teamId: null,
              sourceThreadId: planningThreadId,
              sourceMessageIds: [],
              createdBy: null,
              workflowId: WorkflowId.make("workflow-spec-1"),
              ticketCount: 0,
              createdAt: now,
              updatedAt: now,
            },
      tickets: [],
      reviewCycles: [],
    },
    appReviews: [],
    activities: [],
    checkpoints: [],
    session: null,
  };
}

function readModel(stage: "spec-authoring" | "tickets-authoring"): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [
      project(rudi, "/repos/rudi"),
      project(medical, "/repos/medical-repository"),
      // Another checkout of the workflow's own repository is not a choice.
      project(rudiClone, "/repos/rudi-signing", {
        repositoryIdentity: project(rudi, "/repos/rudi").repositoryIdentity ?? null,
      }),
      project(someoneElses, "/repos/chat", { ownerUserId: WorkspaceUserId.make("alex") }),
    ],
    threads: [planningThread(stage)],
    implementationRuns: [],
    updatedAt: now,
  };
}

function ticket(key: string, projectId?: ProjectId): ThreadPlanningTicketArtifactInput {
  return {
    key,
    title: key,
    bodyMarkdown: `Implement ${key}.`,
    plannedFileChanges: [{ path: `src/${key.toLowerCase()}.ts`, action: "update" }],
    dependencyKeys: [],
    ...(projectId === undefined ? {} : { projectId }),
  };
}

const applyTickets = (tickets: ReadonlyArray<ThreadPlanningTicketArtifactInput>) =>
  decideOrchestrationCommand({
    command: {
      type: "thread.planning-tickets.apply",
      commandId: CommandId.make("cmd-tickets"),
      threadId: planningThreadId,
      sourceMessageId: MessageId.make("message-tickets"),
      specId,
      tickets: [...tickets],
      createdAt: now,
    },
    readModel: readModel("tickets-authoring"),
  });

function firstEvent(result: unknown): OrchestrationEvent {
  return (Array.isArray(result) ? result[0] : result) as OrchestrationEvent;
}

it.layer(NodeServices.layer)("decider ticket repositories", (it) => {
  it.effect("keeps a ticket in another of the owner's projects and drops its own", () =>
    Effect.gen(function* () {
      const event = firstEvent(
        yield* applyTickets([ticket("TICKET-1", medical), ticket("TICKET-2", rudi)]),
      );
      expect(event.type).toBe("thread.planning-tickets-created");
      const tickets = (event.payload as { tickets: ReadonlyArray<{ projectId?: string }> }).tickets;
      expect(tickets.map((entry) => entry.projectId)).toEqual([medical, undefined]);
    }),
  );

  it.effect("rejects a ticket in a project the workflow cannot change", () =>
    Effect.gen(function* () {
      for (const projectId of [rudiClone, someoneElses, ProjectId.make("project-missing")]) {
        const error = yield* Effect.flip(applyTickets([ticket("TICKET-1", projectId)]));
        expect(error.message).toContain(
          `names project '${projectId}', which is not a repository this workflow can change`,
        );
      }
    }),
  );

  it.effect("lists the other repositories in the ticket authoring prompt", () =>
    Effect.gen(function* () {
      const result = yield* decideOrchestrationCommand({
        command: {
          type: "thread.planning-spec.apply",
          commandId: CommandId.make("cmd-spec"),
          threadId: planningThreadId,
          sourceMessageId: MessageId.make("message-spec"),
          title: "Studies",
          summaryMarkdown: "Serve studies to Rudi.",
          createdAt: now,
        },
        readModel: readModel("spec-authoring"),
      });
      const prompt = (Array.isArray(result) ? result : [result])
        .map((event) => event.payload as { text?: string })
        .find((payload) => payload.text?.startsWith("Decompose this Spec"))?.text;
      expect(prompt).toContain(`- ${medical} (projectId: ${medical}) at /repos/medical-repository`);
      expect(prompt).not.toContain(rudiClone);
      expect(prompt).not.toContain(someoneElses);
    }),
  );
});
