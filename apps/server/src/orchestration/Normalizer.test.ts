import { describe, expect, it } from "vite-plus/test";
import {
  CommandId,
  type ClientOrchestrationCommand,
  DEFAULT_WORKSPACE_USER_ID,
  AppReviewWorkflowCycleBudget,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  WorkflowId,
} from "@t3tools/contracts";

import { canonicalizeClientCommandTimestamps } from "./Normalizer.ts";

const clientCreatedAt = "2031-01-01T00:00:00.000Z";
const serverReceivedAt = "2026-07-18T00:00:00.000Z";

describe("canonicalizeClientCommandTimestamps", () => {
  it("replaces a client command timestamp with the server receipt timestamp", () => {
    const command: ClientOrchestrationCommand = {
      type: "project.create",
      commandId: CommandId.make("command-1"),
      projectId: ProjectId.make("project-1"),
      title: "Clock-safe project",
      workspaceRoot: "/tmp/clock-safe-project",
      createdAt: clientCreatedAt,
    };

    expect(canonicalizeClientCommandTimestamps(command, serverReceivedAt)).toEqual({
      ...command,
      createdAt: serverReceivedAt,
    });
  });

  it("replaces both timestamps when the first turn bootstraps a thread", () => {
    const command: ClientOrchestrationCommand = {
      type: "thread.turn.start",
      commandId: CommandId.make("command-2"),
      threadId: ThreadId.make("thread-1"),
      message: {
        messageId: MessageId.make("message-1"),
        role: "user",
        text: "Start a thread",
        attachments: [],
      },
      runtimeMode: "full-access",
      interactionMode: "default",
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          ownerUserId: DEFAULT_WORKSPACE_USER_ID,
          title: "Clock-safe thread",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.4",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.turn.start");
    if (result.type !== "thread.turn.start") {
      throw new Error("Expected a thread.turn.start command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });

  it("uses the same clock-safe bootstrap path for a draft App Review launch", () => {
    const threadId = ThreadId.make("thread-app-review-draft");
    const command: ClientOrchestrationCommand = {
      type: "thread.app-review-workflow.launch",
      commandId: CommandId.make("command-app-review"),
      targetThreadId: threadId,
      controllerThreadId: threadId,
      caller: { type: "standalone", sourceThreadId: threadId },
      briefMarkdown: "Review checkout.",
      previewTargets: ["https://preview.example.test"],
      cycleBudget: AppReviewWorkflowCycleBudget.make(10),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.6-sol",
      },
      bootstrap: {
        createThread: {
          projectId: ProjectId.make("project-1"),
          ownerUserId: DEFAULT_WORKSPACE_USER_ID,
          workflowRole: "app-review-orchestrator",
          workflowContext: {
            workflowId: WorkflowId.make(`app-review-workflow-${threadId}`),
            rootThreadId: threadId,
            ticketScope: [],
          },
          title: "Review checkout",
          modelSelection: {
            instanceId: ProviderInstanceId.make("codex"),
            model: "gpt-5.6-sol",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          workflowPreset: "app-review",
          branch: null,
          worktreePath: null,
          createdAt: clientCreatedAt,
        },
      },
      createdAt: clientCreatedAt,
    };

    const result = canonicalizeClientCommandTimestamps(command, serverReceivedAt);

    expect(result.type).toBe("thread.app-review-workflow.launch");
    if (result.type !== "thread.app-review-workflow.launch") {
      throw new Error("Expected an App Review workflow launch command");
    }
    expect(result.createdAt).toBe(serverReceivedAt);
    expect(result.bootstrap?.createThread?.createdAt).toBe(serverReceivedAt);
  });
});
