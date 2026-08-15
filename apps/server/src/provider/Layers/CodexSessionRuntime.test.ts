import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { describe } from "vite-plus/test";
import { DEFAULT_MODEL, ThreadId } from "@t3tools/contracts";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as CodexRpc from "effect-codex-app-server/rpc";

import {
  CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS,
  buildCodexDeveloperInstructions,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_INTERACTIVE_GRILL_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
} from "../CodexDeveloperInstructions.ts";
import { WORKFLOW_PROMPT_IDS } from "../WorkflowPromptRegistry.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  buildTurnStartParams,
  decodeWorkflowRequestUserInputArguments,
  hasConfiguredMcpServer,
  handleWorkflowRequestUserInputToolCall,
  isRecoverableThreadResumeError,
  openCodexThread,
  WORKFLOW_REQUEST_USER_INPUT_TOOL,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

describe("CodexSessionRuntimeIdentifierGenerationError", () => {
  it("retains identifier purpose and the random source failure", () => {
    const cause = new Error("random source unavailable");
    const error = new CodexErrors.CodexAppServerIdentifierGenerationError({
      purpose: "provider-event",
      cause,
    });

    NodeAssert.equal(error.purpose, "provider-event");
    NodeAssert.strictEqual(error.cause, cause);
    NodeAssert.equal(
      error.message,
      "Failed to generate Codex App Server identifier for provider-event.",
    );
  });
});

function makeThreadOpenResponse(
  threadId: string,
): CodexRpc.ClientRequestResponsesByMethod["thread/start"] {
  return {
    cwd: "/tmp/project",
    model: "gpt-5.3-codex",
    modelProvider: "openai",
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandbox: { type: "danger-full-access" },
    thread: {
      id: threadId,
      createdAt: "2026-04-18T00:00:00.000Z",
      source: { session: "cli" },
      turns: [],
      status: {
        state: "idle",
        activeFlags: [],
      },
    },
  } as unknown as CodexRpc.ClientRequestResponsesByMethod["thread/start"];
}

describe("buildTurnStartParams", () => {
  it("keeps invalid turn values only in the schema cause", () => {
    const secret = "codex-turn-input-secret-sentinel";
    const error = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        attachments: [
          {
            type: "image",
            url: { secret } as unknown as string,
          },
        ],
      }).pipe(Effect.flip),
    );
    const { cause, ...directDiagnostics } = error;

    NodeAssert.equal(error.operation, "decode-request-payload");
    NodeAssert.equal(error.method, "turn/start");
    NodeAssert.ok((error.ticketCount ?? 0) > 0);
    NodeAssert.ok(error.ticketKinds?.includes("Pointer"));
    NodeAssert.ok((error.maximumPathDepth ?? 0) > 0);
    NodeAssert.ok(Schema.isSchemaError(cause));
    NodeAssert.doesNotMatch(error.message, new RegExp(secret));
    NodeAssert.doesNotMatch(JSON.stringify(directDiagnostics), new RegExp(secret));
  });

  it("includes plan collaboration mode when requested", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Make a plan",
        model: "gpt-5.3-codex",
        effort: "medium",
        interactionMode: "plan",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "dangerFullAccess",
      },
      input: [
        {
          type: "text",
          text: "Make a plan",
        },
      ],
      model: "gpt-5.3-codex",
      effort: "medium",
      collaborationMode: {
        mode: "plan",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("plan", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it.effect("uses native plan transport for every Product Grill prompt", () =>
    Effect.gen(function* () {
      for (const workflowPromptId of [
        WORKFLOW_PROMPT_IDS.productFixCodex,
        WORKFLOW_PROMPT_IDS.productFastFeatureCodex,
        WORKFLOW_PROMPT_IDS.productFullFeatureCodex,
      ]) {
        const params = yield* buildTurnStartParams({
          threadId: "provider-thread-1",
          runtimeMode: "full-access",
          prompt: "Start the Product Grill",
          model: "gpt-5.3-codex",
          effort: "medium",
          interactionMode: "product-workflow",
          workflowPromptId,
        });

        NodeAssert.equal(params.collaborationMode?.mode, "plan");
        const instructions = params.collaborationMode?.settings.developer_instructions ?? "";
        NodeAssert.ok(
          instructions.startsWith(
            buildCodexDeveloperInstructions("interactive-grill", {
              model: "gpt-5.3-codex",
              reasoningEffort: "medium",
            }),
          ),
        );
        NodeAssert.match(instructions, /Product Grill/);
        NodeAssert.match(instructions, /do not produce a `<proposed_plan>` block/);
        NodeAssert.doesNotMatch(instructions, /When you present the official plan/);
      }
    }),
  );

  it.effect("uses default transport when the T3 workflow input tool is available", () =>
    Effect.gen(function* () {
      for (const [interactionMode, workflowPromptId] of [
        ["product-workflow", WORKFLOW_PROMPT_IDS.productFixCodex],
        ["product-workflow", WORKFLOW_PROMPT_IDS.productFastFeatureCodex],
        ["product-workflow", WORKFLOW_PROMPT_IDS.productFullFeatureCodex],
        ["planning-workflow", WORKFLOW_PROMPT_IDS.planningGrillStageCodex],
      ] as const) {
        const params = yield* buildTurnStartParams({
          threadId: "provider-thread-1",
          runtimeMode: "full-access",
          prompt: "Start grilling",
          interactionMode,
          workflowPromptId,
          workflowUserInputToolAvailable: true,
        });

        NodeAssert.equal(params.collaborationMode?.mode, "default");
        const instructions = params.collaborationMode?.settings.developer_instructions ?? "";
        NodeAssert.match(instructions, /workflow_request_user_input/);
        NodeAssert.doesNotMatch(instructions, /predates T3's/);
      }
    }),
  );

  it.effect("uses native plan transport for interactive Engineering Grill", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Start planning",
        interactionMode: "planning-workflow",
        workflowPromptId: WORKFLOW_PROMPT_IDS.planningGrillStageCodex,
      });

      NodeAssert.equal(params.collaborationMode?.mode, "plan");
      const instructions = params.collaborationMode?.settings.developer_instructions ?? "";
      NodeAssert.match(instructions, /native Plan collaboration transport/);
      NodeAssert.match(instructions, /CONTEXT\.md/);
      NodeAssert.match(instructions, /CONTEXT-MAP\.md/);
      NodeAssert.match(instructions, /qualifying ADRs/);
      NodeAssert.match(instructions, /planning-grill-complete/);
      NodeAssert.match(instructions, /do not produce a `<proposed_plan>` block/);
      NodeAssert.doesNotMatch(instructions, /When you present the official plan/);
    }),
  );

  it.effect("keeps non-interactive workflow stages in native default mode", () =>
    Effect.gen(function* () {
      for (const [interactionMode, workflowPromptId] of [
        ["planning-workflow", WORKFLOW_PROMPT_IDS.planningAutomaticEngineeringGrillCodex],
        ["planning-workflow", WORKFLOW_PROMPT_IDS.planningSpecCodex],
        ["planning-workflow", WORKFLOW_PROMPT_IDS.planningWayfinderCodex],
        ["implementation-workflow", WORKFLOW_PROMPT_IDS.implementationTddCodex],
      ] as const) {
        const params = yield* buildTurnStartParams({
          threadId: "provider-thread-1",
          runtimeMode: "full-access",
          prompt: "Continue workflow",
          interactionMode,
          workflowPromptId,
        });

        NodeAssert.equal(params.collaborationMode?.mode, "default");
        const instructions = params.collaborationMode?.settings.developer_instructions ?? "";
        NodeAssert.ok(instructions.startsWith(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS));
      }
    }),
  );

  it.effect("preserves explicit CLI Plan mode when a stale Product Grill prompt remains", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Plan the implementation",
        interactionMode: "plan",
        workflowPromptId: WORKFLOW_PROMPT_IDS.productFastFeatureCodex,
      });

      NodeAssert.equal(params.collaborationMode?.mode, "plan");
      const instructions = params.collaborationMode?.settings.developer_instructions ?? "";
      NodeAssert.ok(instructions.startsWith(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS));
      NodeAssert.match(instructions, /<proposed_plan>/);
      NodeAssert.doesNotMatch(instructions, /Interactive T3 Grill/);
      NodeAssert.doesNotMatch(instructions, /# Product Grill/);
    }),
  );

  it("includes default collaboration mode and image attachments", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto-accept-edits",
        prompt: "Implement it",
        model: "gpt-5.3-codex",
        interactionMode: "default",
        attachments: [
          {
            type: "image",
            url: "data:image/png;base64,abc",
          },
        ],
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "workspaceWrite",
      },
      input: [
        {
          type: "text",
          text: "Implement it",
        },
        {
          type: "image",
          url: "data:image/png;base64,abc",
        },
      ],
      model: "gpt-5.3-codex",
      collaborationMode: {
        mode: "default",
        settings: {
          model: "gpt-5.3-codex",
          reasoning_effort: "medium",
          developer_instructions: buildCodexDeveloperInstructions("default", {
            model: "gpt-5.3-codex",
            reasoningEffort: "medium",
          }),
        },
      },
    });
  });

  it("reports the same fallback model and effort in settings and instructions", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Go",
        interactionMode: "default",
      }),
    );

    const settings = params.collaborationMode?.settings;
    NodeAssert.equal(settings?.model, DEFAULT_MODEL);
    NodeAssert.equal(settings?.reasoning_effort, "medium");
    NodeAssert.ok(settings?.developer_instructions?.includes(`as ${DEFAULT_MODEL} with medium`));
  });

  it.effect("routes approvals to the auto reviewer in auto mode", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "auto",
        prompt: "Ship it",
      });

      NodeAssert.deepStrictEqual(params, {
        threadId: "provider-thread-1",
        approvalPolicy: "on-request",
        approvalsReviewer: "auto_review",
        sandboxPolicy: {
          type: "workspaceWrite",
        },
        input: [
          {
            type: "text",
            text: "Ship it",
          },
        ],
      });
    }),
  );

  it("omits collaboration mode when interaction mode is absent", () => {
    const params = Effect.runSync(
      buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "approval-required",
        prompt: "Review",
      }),
    );

    NodeAssert.deepStrictEqual(params, {
      threadId: "provider-thread-1",
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: {
        type: "readOnly",
      },
      input: [
        {
          type: "text",
          text: "Review",
        },
      ],
    });
  });
});

function workflowQuestion(index: number) {
  return {
    id: `question_${index}`,
    header: `Question ${index}`,
    question: `Which direction should question ${index} take?`,
    options: [
      { label: "Focused", description: "Keep the surface narrow." },
      { label: "Broad", description: "Cover the wider surface." },
    ],
    recommendation: {
      optionLabel: "Focused",
      rationale: "It creates a faster feedback loop.",
    },
  };
}

describe("workflow_request_user_input validation", () => {
  for (const questionCount of [1, 2, 3, 4, 5, 6, 7]) {
    it.effect(`accepts a natural ${questionCount}-question frontier`, () =>
      Effect.gen(function* () {
        const decoded = yield* decodeWorkflowRequestUserInputArguments({
          questions: Array.from({ length: questionCount }, (_, index) => workflowQuestion(index)),
        });
        NodeAssert.equal(decoded.questions.length, questionCount);
      }),
    );
  }

  for (const questionCount of [0, 8]) {
    it.effect(`rejects a ${questionCount}-question frontier`, () =>
      Effect.gen(function* () {
        const error = yield* decodeWorkflowRequestUserInputArguments({
          questions: Array.from({ length: questionCount }, (_, index) => workflowQuestion(index)),
        }).pipe(Effect.flip);
        NodeAssert.match(error.message, /questions|length/i);
      }),
    );
  }

  it.effect("rejects duplicate question IDs", () =>
    Effect.gen(function* () {
      const error = yield* decodeWorkflowRequestUserInputArguments({
        questions: [workflowQuestion(1), { ...workflowQuestion(2), id: "question_1" }],
      }).pipe(Effect.flip);
      NodeAssert.match(error.message, /unique/i);
    }),
  );

  it.effect("rejects duplicate option labels", () =>
    Effect.gen(function* () {
      const question = workflowQuestion(1);
      const error = yield* decodeWorkflowRequestUserInputArguments({
        questions: [
          {
            ...question,
            options: [question.options[0], { ...question.options[1], label: "Focused" }],
          },
        ],
      }).pipe(Effect.flip);
      NodeAssert.match(error.message, /unique option labels/i);
    }),
  );

  it.effect("rejects recommendations that target a missing option", () =>
    Effect.gen(function* () {
      const error = yield* decodeWorkflowRequestUserInputArguments({
        questions: [
          {
            ...workflowQuestion(1),
            recommendation: {
              optionLabel: "Missing",
              rationale: "This must not decode.",
            },
          },
        ],
      }).pipe(Effect.flip);
      NodeAssert.match(error.message, /must match one of its option labels/i);
    }),
  );
});

describe("workflow_request_user_input handling", () => {
  const payload = {
    tool: "workflow_request_user_input",
    callId: "call-1",
    threadId: "provider-thread-1",
    turnId: "turn-1",
    arguments: {
      questions: [workflowQuestion(1), workflowQuestion(2)],
    },
  } as const;

  it("tells Code Mode to expose the dynamic-tool result to the model", () => {
    NodeAssert.match(
      WORKFLOW_REQUEST_USER_INPUT_TOOL.description,
      /complete result.*outer text\(result\) helper/,
    );
    NodeAssert.match(
      WORKFLOW_REQUEST_USER_INPUT_TOOL.description,
      /contentItems, not result\.content/,
    );
  });

  it.effect("emits one complete request, waits, and returns every answer", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<ReadonlyArray<unknown>>();
      const answers = yield* Deferred.make<Record<string, string>>();
      const callFiber = yield* handleWorkflowRequestUserInputToolCall({
        registered: true,
        payload,
        requestUserInput: ({ questions }) =>
          Deferred.succeed(requested, questions).pipe(Effect.andThen(Deferred.await(answers))),
      }).pipe(Effect.forkChild);

      const questions = yield* Deferred.await(requested);
      NodeAssert.equal(questions.length, 2);
      NodeAssert.equal((questions[0] as { readonly multiSelect?: boolean }).multiSelect, false);
      yield* Deferred.succeed(answers, {
        question_1: "Focused",
        question_2: "A custom answer",
      });
      const response = yield* Fiber.join(callFiber);
      NodeAssert.deepStrictEqual(response, {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: '{"question_1":"Focused","question_2":"A custom answer"}',
          },
        ],
      });
    }),
  );

  it.effect("runs pending-request cleanup when the tool call is interrupted", () =>
    Effect.gen(function* () {
      const requested = yield* Deferred.make<void>();
      const answers = yield* Deferred.make<Record<string, string>>();
      const cleanedUp = yield* Ref.make(false);
      const callFiber = yield* handleWorkflowRequestUserInputToolCall({
        registered: true,
        payload,
        requestUserInput: () =>
          Deferred.succeed(requested, undefined).pipe(
            Effect.andThen(Deferred.await(answers)),
            Effect.ensuring(Ref.set(cleanedUp, true)),
          ),
      }).pipe(Effect.forkChild);

      yield* Deferred.await(requested);
      yield* Fiber.interrupt(callFiber);
      NodeAssert.equal(yield* Ref.get(cleanedUp), true);
    }),
  );

  it.effect("rejects an unregistered or differently named dynamic tool", () =>
    Effect.gen(function* () {
      for (const invalidPayload of [
        { registered: false, payload },
        { registered: true, payload: { ...payload, tool: "another_tool" } },
      ]) {
        const error = yield* handleWorkflowRequestUserInputToolCall({
          ...invalidPayload,
          requestUserInput: () => Effect.succeed({}),
        }).pipe(Effect.flip);
        NodeAssert.equal(error.code, -32602);
        NodeAssert.match(error.message, /Only the registered/);
      }
    }),
  );
});

describe("buildCodexDeveloperInstructions", () => {
  it("appends runtime info after the mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /T3 Code/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("includes runtime info alongside plan mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("plan", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /as gpt-5\.3-codex with medium reasoning effort/);
  });

  it("uses workflow-specific instructions for interactive structured-input turns", () => {
    const instructions = buildCodexDeveloperInstructions("interactive-grill", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.ok(instructions.startsWith(CODEX_INTERACTIVE_GRILL_DEVELOPER_INSTRUCTIONS));
    NodeAssert.match(instructions, /only as a compatibility fallback/);
    NodeAssert.match(instructions, /request_user_input/);
    NodeAssert.match(instructions, /Product Grill or Engineering Grill workflow prompt/);
    NodeAssert.match(instructions, /CONTEXT\.md/);
    NodeAssert.match(instructions, /CONTEXT-MAP\.md/);
    NodeAssert.match(instructions, /qualifying ADRs/);
    NodeAssert.match(instructions, /do not produce a `<proposed_plan>` block/);
    NodeAssert.doesNotMatch(instructions, /When you present the official plan/);
  });

  it("varies with the model and effort of each turn", () => {
    const first = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });
    const second = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.4",
      reasoningEffort: "high",
    });

    NodeAssert.notEqual(first, second);
  });

  it("flattens multiline metadata into single-line runtime info", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt\n5.3\ncodex",
      reasoningEffort: " high\neffort ",
    });

    NodeAssert.match(instructions, /as gpt 5\.3 codex with high effort reasoning effort/);
    NodeAssert.doesNotMatch(instructions, /<runtime_info>[^<]*\n/);
  });
});

describe("Codex developer instructions browser scoping", () => {
  it("keeps browser tooling out of default and plan collaboration modes", () => {
    for (const instructions of [
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
    ]) {
      NodeAssert.doesNotMatch(instructions, /Chrome DevTools MCP/);
      NodeAssert.doesNotMatch(instructions, /Agent Browser CLI/);
      NodeAssert.doesNotMatch(instructions, /t3-code/);
      NodeAssert.doesNotMatch(instructions, /preview_status/);
      NodeAssert.doesNotMatch(instructions, /Do not switch to global browser skills/);
    }
    NodeAssert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /workflow-subagent-create/);
    NodeAssert.match(
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      /implementation\.browser-dev-review\.codex/,
    );
    NodeAssert.match(
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      /Do not use this one-shot launch as a substitute for an active Fix, Fast Feature/,
    );
    NodeAssert.doesNotMatch(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /workflow-subagent-create/);
  });

  it("defines browser QA developer instructions for Browser Dev Review only", () => {
    NodeAssert.match(CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS, /preview_open/);
    NodeAssert.match(CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS, /preview_navigate/);
    NodeAssert.match(CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS, /dev_review_recording_start/);
    NodeAssert.match(CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS, /dev_review_capture_screenshot/);
    NodeAssert.match(CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS, /t3-code/);
    NodeAssert.doesNotMatch(CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS, /agent-browser/i);
    NodeAssert.doesNotMatch(CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS, /rrweb/i);
    NodeAssert.doesNotMatch(CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS, /Chrome DevTools MCP/);
    NodeAssert.match(CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS, /Browser Dev Review QA role only/);
  });
});

describe("Codex workflow prompt browser scoping", () => {
  it.effect("omits browser tooling from implementation orchestrator turns", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Start implementation workflow",
        model: "gpt-5.3-codex",
        interactionMode: "implementation-workflow",
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationOrchestratorPlanningCodex,
      });

      const instructions = params.collaborationMode?.settings.developer_instructions ?? "";
      NodeAssert.doesNotMatch(instructions, /T3 Workflow Sub-Agent System/);
      NodeAssert.doesNotMatch(instructions, /workflow-agent-message/);
      NodeAssert.match(instructions, /Implementation Workflow: Orchestrator Start/);
      NodeAssert.doesNotMatch(instructions, /Chrome DevTools MCP/);
      NodeAssert.doesNotMatch(instructions, /Agent Browser CLI/);
      NodeAssert.doesNotMatch(instructions, /preview_status/);
    }),
  );

  it.effect("includes browser tooling only for Browser Dev Review turns", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Review in browser",
        model: "gpt-5.3-codex",
        interactionMode: "implementation-workflow",
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
      });

      const instructions = params.collaborationMode?.settings.developer_instructions ?? "";
      NodeAssert.match(instructions, /Browser Dev Review QA tools/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /preview_snapshot/);
      NodeAssert.match(instructions, /dev_review_recording_start/);
      NodeAssert.match(instructions, /dev_review_capture_screenshot/);
      NodeAssert.match(instructions, /preview-browser-qa\.md/);
      NodeAssert.match(instructions, /Never turn evidenced product defects into blocked/);
      NodeAssert.doesNotMatch(instructions, /Agent Browser CLI/);
      NodeAssert.doesNotMatch(instructions, /agent-browser/);
      NodeAssert.doesNotMatch(instructions, /rrweb/i);
      NodeAssert.doesNotMatch(instructions, /Chrome DevTools MCP/);
      NodeAssert.doesNotMatch(instructions, /chrome-devtools-mcp/);
    }),
  );
});

describe("hasConfiguredMcpServer", () => {
  it("detects inline Codex MCP configuration arguments", () => {
    NodeAssert.equal(hasConfiguredMcpServer(undefined), false);
    NodeAssert.equal(hasConfiguredMcpServer(["--model", "gpt-5.4"]), false);
    NodeAssert.equal(
      hasConfiguredMcpServer(["-c", 'mcp_servers.t3-code.url="http://127.0.0.1/mcp"']),
      true,
    );
  });
});

describe("codexSessionAppServerArgs", () => {
  it("keeps the app-server subcommand when explicit args are provided", () => {
    NodeAssert.deepStrictEqual(codexSessionAppServerArgs(["-c", "model=gpt-5"], undefined), [
      "app-server",
      "-c",
      "model=gpt-5",
    ]);
  });

  it("keeps launch args when explicit app-server args are provided", () => {
    NodeAssert.deepStrictEqual(
      codexSessionAppServerArgs(
        ["-c", "mcp_servers.t3-code.url=http://127.0.0.1/mcp"],
        "--strict-config --enable foo",
      ),
      [
        "app-server",
        "--strict-config",
        "--enable",
        "foo",
        "-c",
        "mcp_servers.t3-code.url=http://127.0.0.1/mcp",
      ],
    );
  });
});

describe("isRecoverableThreadResumeError", () => {
  it("matches missing thread errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Thread does not exist",
        }),
      ),
      true,
    );
  });

  it("ignores non-recoverable resume errors", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Permission denied",
        }),
      ),
      false,
    );
  });

  it("ignores unrelated missing-resource errors that do not mention threads", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Config file not found",
        }),
      ),
      false,
    );
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "Model does not exist",
        }),
      ),
      false,
    );
  });
});

describe("openCodexThread", () => {
  it.effect("registers the workflow user-input tool on a fresh grill thread", () =>
    Effect.gen(function* () {
      const payloads: Array<unknown> = [];
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          _method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          payloads.push(payload);
          return Effect.succeed(
            makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: undefined,
        enableWorkflowUserInputTool: true,
      });

      NodeAssert.deepStrictEqual(
        (payloads[0] as { readonly dynamicTools?: ReadonlyArray<unknown> }).dynamicTools,
        [WORKFLOW_REQUEST_USER_INPUT_TOOL],
      );
    }),
  );

  it.effect("falls back to thread/start when resume fails recoverably", () =>
    Effect.gen(function* () {
      const calls: Array<{ method: "thread/start" | "thread/resume"; payload: unknown }> = [];
      const started = makeThreadOpenResponse("fresh-thread");
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          calls.push({ method, payload });
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "thread not found",
              }),
            );
          }
          return Effect.succeed(started as CodexRpc.ClientRequestResponsesByMethod[M]);
        },
      };

      const opened = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      });

      NodeAssert.equal(opened.thread.id, "fresh-thread");
      NodeAssert.deepStrictEqual(
        calls.map((call) => call.method),
        ["thread/resume", "thread/start"],
      );
    }),
  );

  it.effect("propagates non-recoverable resume failures", () =>
    Effect.gen(function* () {
      const client = {
        request: <M extends "thread/start" | "thread/resume">(
          method: M,
          _payload: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          if (method === "thread/resume") {
            return Effect.fail(
              new CodexErrors.CodexAppServerRequestError({
                code: -32603,
                errorMessage: "timed out waiting for server",
              }),
            );
          }
          return Effect.succeed(
            makeThreadOpenResponse("fresh-thread") as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      };

      const error = yield* openCodexThread({
        client,
        threadId: ThreadId.make("thread-1"),
        runtimeMode: "full-access",
        cwd: "/tmp/project",
        requestedModel: "gpt-5.3-codex",
        serviceTier: undefined,
        resumeThreadId: "stale-thread",
      }).pipe(Effect.flip);

      NodeAssert.ok(isCodexAppServerRequestError(error));
      NodeAssert.equal(error.errorMessage, "timed out waiting for server");
    }),
  );
});
