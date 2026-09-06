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
import * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS,
  buildCodexDeveloperInstructions,
  CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
  CODEX_INTERACTIVE_GRILL_DEVELOPER_INSTRUCTIONS,
  CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS,
  codexDefaultModeDeveloperInstructions,
  codexPlanModeDeveloperInstructions,
} from "../CodexDeveloperInstructions.ts";
import { WORKFLOW_PROMPT_IDS } from "../WorkflowPromptRegistry.ts";
import { codexSessionAppServerArgs } from "./codexLaunchArgs.ts";
import {
  buildTurnStartParams,
  startCodexTurn,
  decodeWorkflowRequestUserInputArguments,
  describeMcpElicitation,
  hasConfiguredMcpServer,
  handleWorkflowRequestUserInputToolCall,
  isRecoverableThreadResumeError,
  makeMemoryConsolidationNotificationFilter,
  openCodexThread,
  WORKFLOW_REQUEST_USER_INPUT_TOOL,
  toMcpElicitationResponse,
} from "./CodexSessionRuntime.ts";
const isCodexAppServerRequestError = Schema.is(CodexErrors.CodexAppServerRequestError);

describe("startCodexTurn", () => {
  it.effect("delivers complete developer instructions before starting each workflow stage", () =>
    Effect.gen(function* () {
      for (const [interactionMode, workflowPromptId] of [
        ["planning-workflow", undefined],
        ["planning-workflow", WORKFLOW_PROMPT_IDS.planningGrillStageCodex],
        ["planning-workflow", WORKFLOW_PROMPT_IDS.planningSpecCodex],
        ["planning-workflow", WORKFLOW_PROMPT_IDS.planningTicketsCodex],
        ["default", undefined],
        ["plan", undefined],
      ] as const) {
        const params = yield* buildTurnStartParams({
          threadId: "provider-thread-1",
          runtimeMode: "full-access",
          prompt: "Continue",
          interactionMode,
          ...(workflowPromptId ? { workflowPromptId } : {}),
          workflowUserInputToolAvailable: true,
        });
        const calls: Array<{ method: string; payload: unknown }> = [];
        const result = yield* startCodexTurn((method, payload) => {
          calls.push({ method, payload });
          return Effect.succeed({ turn: { id: "turn-1" } });
        }, params);

        NodeAssert.deepStrictEqual(calls, [
          {
            method: "thread/inject_items",
            payload: {
              threadId: "provider-thread-1",
              items: [
                {
                  type: "message",
                  role: "developer",
                  content: [
                    {
                      type: "input_text",
                      text: params.collaborationMode?.settings.developer_instructions,
                    },
                  ],
                },
              ],
            },
          },
          { method: "turn/start", payload: params },
        ]);
        NodeAssert.deepStrictEqual(result, { turn: { id: "turn-1" } });
      }
    }),
  );

  it.effect("does not start a turn when developer instruction delivery fails", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        interactionMode: "planning-workflow",
      });
      const calls: string[] = [];
      const error = new CodexErrors.CodexAppServerRequestError({
        method: "thread/inject_items",
        code: -32601,
        errorMessage: "Injection unavailable",
      });
      const failure = yield* startCodexTurn((method) => {
        calls.push(method);
        return Effect.fail(error);
      }, params).pipe(Effect.result);
      NodeAssert.equal(failure._tag, "Failure");
      NodeAssert.strictEqual(failure.failure, error);
      NodeAssert.deepStrictEqual(calls, ["thread/inject_items"]);
    }),
  );

  it.effect("keeps turns without instruction overrides unchanged", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Continue",
      });
      const calls: string[] = [];
      yield* startCodexTurn((method) => {
        calls.push(method);
        return Effect.succeed({});
      }, params);
      NodeAssert.deepStrictEqual(calls, ["turn/start"]);
    }),
  );
});

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
        NodeAssert.ok(instructions.startsWith(codexDefaultModeDeveloperInstructions(false)));
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
      NodeAssert.ok(instructions.startsWith(codexPlanModeDeveloperInstructions(false)));
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
          reasoning_effort: "high",
          developer_instructions: buildCodexDeveloperInstructions("default", {
            model: "gpt-5.3-codex",
            reasoningEffort: "high",
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
    NodeAssert.equal(settings?.reasoning_effort, "high");
    NodeAssert.ok(settings?.developer_instructions?.includes(`as ${DEFAULT_MODEL} with high`));
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
  for (const questionCount of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    it.effect(`accepts a natural ${questionCount}-question frontier`, () =>
      Effect.gen(function* () {
        const decoded = yield* decodeWorkflowRequestUserInputArguments({
          questions: Array.from({ length: questionCount }, (_, index) => workflowQuestion(index)),
        });
        NodeAssert.equal(decoded.questions.length, questionCount);
      }),
    );
  }

  for (const questionCount of [0, 11]) {
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
describe("Codex MCP elicitation approvals", () => {
  const request = {
    mode: "form",
    message: "Allow ChatGPT to use Safari?",
    serverName: "computer-use",
    threadId: "provider-thread-1",
    turnId: "turn-1",
    _meta: {
      app_name: "Safari",
      persist: ["session", "always"],
    },
    requestedSchema: {
      type: "object",
      properties: {
        approval: {
          type: "string",
          oneOf: [
            { const: "once", title: "Allow once" },
            { const: "session", title: "Allow for this session" },
            { const: "always", title: "Always allow Safari" },
          ],
        },
      },
      required: ["approval"],
    },
  } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

  it("preserves the app name and advertised persistence choices", () => {
    NodeAssert.deepStrictEqual(describeMcpElicitation(request), {
      appName: "Safari",
      options: [
        { decision: "cancel", label: "Cancel" },
        { decision: "decline", label: "Decline" },
        { decision: "acceptForSession", label: "Allow for this session" },
        { decision: "acceptAlways", label: "Always allow Safari" },
        { decision: "accept", label: "Approve" },
      ],
    });
  });

  it("extracts the app name from a Computer Use request without metadata", () => {
    const { _meta, ...requestWithoutMetadata } = request;

    NodeAssert.equal(describeMcpElicitation(requestWithoutMetadata).appName, "Safari");
  });

  it("returns the accepted form option to Codex", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "accept"), {
      action: "accept",
      content: { approval: "once" },
    });
  });

  it("returns session-scoped approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptForSession"), {
      action: "accept",
      _meta: { persist: "session" },
      content: { approval: "session" },
    });
  });

  it("returns persistent approval in the MCP response", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("returns rejection without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "decline"), {
      action: "decline",
    });
  });

  it("returns cancellation without form content", () => {
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(request, "cancel"), {
      action: "cancel",
    });
  });

  it("supports boolean permanent-approval fields", () => {
    const booleanRequest = {
      ...request,
      _meta: { app_name: "Safari" },
      requestedSchema: {
        type: "object",
        properties: {
          always: { type: "boolean", title: "Always allow Safari" },
        },
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.ok(
      describeMcpElicitation(booleanRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(booleanRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { always: true },
    });
  });

  it("preserves valid nullable MCP form fields and persistence choices", () => {
    const nullableRequest = {
      ...request,
      _meta: {
        app_name: null,
        appName: "Safari",
        connector_name: null,
        persist: null,
        target: null,
        tool_params: null,
      },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            title: null,
            description: null,
            default: null,
            enum: ["once", "always"],
            enumNames: null,
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.equal(describeMcpElicitation(nullableRequest).appName, "Safari");
    NodeAssert.ok(
      describeMcpElicitation(nullableRequest).options.some(
        (option) => option.decision === "acceptAlways",
      ),
    );
    NodeAssert.deepStrictEqual(toMcpElicitationResponse(nullableRequest, "acceptAlways"), {
      action: "accept",
      _meta: { persist: "always" },
      content: { approval: "always" },
    });
  });

  it("declines required form fields that an approval prompt cannot collect", () => {
    const inputRequest = {
      ...request,
      requestedSchema: {
        type: "object",
        properties: {
          email: { type: "string", format: "email" },
        },
        required: ["email"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(inputRequest, "accept"), {
      action: "decline",
    });
  });

  it("does not approve URL elicitations without opening their requested URL", () => {
    const urlRequest = {
      mode: "url",
      message: "Finish signing in to continue.",
      serverName: "computer-use",
      threadId: "provider-thread-1",
      turnId: "turn-1",
      elicitationId: "sign-in-1",
      url: "https://example.com/authorize",
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(toMcpElicitationResponse(urlRequest, "accept"), {
      action: "decline",
    });
  });

  it("omits persistence choices that cannot satisfy required form fields", () => {
    const onceOnlyRequest = {
      ...request,
      _meta: { app_name: "Safari", persist: ["session", "always"] },
      requestedSchema: {
        type: "object",
        properties: {
          approval: {
            type: "string",
            enum: ["once"],
          },
        },
        required: ["approval"],
      },
    } satisfies EffectCodexSchema.McpServerElicitationRequestParams;

    NodeAssert.deepStrictEqual(describeMcpElicitation(onceOnlyRequest).options, [
      { decision: "cancel", label: "Cancel" },
      { decision: "decline", label: "Decline" },
      { decision: "accept", label: "Approve" },
    ]);
  });
});

describe("buildCodexDeveloperInstructions", () => {
  it("appends runtime info after the mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("default", {
      model: "gpt-5.3-codex",
      reasoningEffort: "high",
    });

    NodeAssert.ok(instructions.startsWith(codexDefaultModeDeveloperInstructions(true)));
    NodeAssert.match(instructions, /T3 Code/);
    NodeAssert.match(instructions, /Codex harness/);
    NodeAssert.match(instructions, /as gpt-5\.3-codex with high reasoning effort/);
  });

  it("describes Markdown media support in the runtime context in both modes", () => {
    for (const mode of ["default", "plan"] as const) {
      const instructions = buildCodexDeveloperInstructions(mode, {
        model: "gpt-5.3-codex",
        reasoningEffort: "high",
      });
      NodeAssert.match(
        instructions,
        /<runtime_info>.*embed images and videos.*Markdown.*<\/runtime_info>/,
      );
    }
  });

  it("includes runtime info alongside plan mode instructions", () => {
    const instructions = buildCodexDeveloperInstructions("plan", {
      model: "gpt-5.3-codex",
      reasoningEffort: "medium",
    });

    NodeAssert.ok(instructions.startsWith(codexPlanModeDeveloperInstructions(true)));
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
    NodeAssert.match(instructions, /Grill with Docs workflow prompt/);
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
  it("uses the T3 browser without naming legacy browser tools", () => {
    for (const instructions of [
      codexDefaultModeDeveloperInstructions(true),
      codexPlanModeDeveloperInstructions(true),
    ]) {
      NodeAssert.doesNotMatch(instructions, /Chrome DevTools MCP/);
      NodeAssert.doesNotMatch(instructions, /Agent Browser CLI/);
      NodeAssert.match(instructions, /t3-code/);
      NodeAssert.match(instructions, /preview_status/);
      NodeAssert.match(instructions, /Do not switch to global browser skills/);
    }
    NodeAssert.match(CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS, /workflow-subagent-create/);
    NodeAssert.match(
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      /implementation\.browser-app-review\.codex/,
    );
    NodeAssert.match(
      CODEX_DEFAULT_MODE_DEVELOPER_INSTRUCTIONS,
      /Do not use this one-shot launch as a substitute for an active Fix, Fast Feature/,
    );
    NodeAssert.doesNotMatch(CODEX_PLAN_MODE_DEVELOPER_INSTRUCTIONS, /workflow-subagent-create/);
  });

  it("defines browser QA developer instructions for Browser App Review only", () => {
    NodeAssert.match(CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS, /preview_open/);
    NodeAssert.match(CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS, /preview_navigate/);
    NodeAssert.match(CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS, /app_review_recording_start/);
    NodeAssert.match(CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS, /app_review_capture_screenshot/);
    NodeAssert.match(CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS, /t3-code/);
    NodeAssert.doesNotMatch(CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS, /agent-browser/i);
    NodeAssert.doesNotMatch(CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS, /rrweb/i);
    NodeAssert.doesNotMatch(CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS, /Chrome DevTools MCP/);
    NodeAssert.match(CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS, /Browser App Review QA role only/);
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

  it.effect("includes browser tooling only for Browser App Review turns", () =>
    Effect.gen(function* () {
      const params = yield* buildTurnStartParams({
        threadId: "provider-thread-1",
        runtimeMode: "full-access",
        prompt: "Review in browser",
        model: "gpt-5.3-codex",
        interactionMode: "implementation-workflow",
        workflowPromptId: WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
      });

      const instructions = params.collaborationMode?.settings.developer_instructions ?? "";
      NodeAssert.match(instructions, /Browser App Review QA tools/);
      NodeAssert.match(instructions, /preview_open/);
      NodeAssert.match(instructions, /preview_snapshot/);
      NodeAssert.match(instructions, /app_review_recording_start/);
      NodeAssert.match(instructions, /app_review_capture_screenshot/);
      NodeAssert.match(instructions, /preview-browser-qa\.md/);
      NodeAssert.match(instructions, /never a third verdict/);
      NodeAssert.doesNotMatch(instructions, /Agent Browser CLI/);
      NodeAssert.doesNotMatch(instructions, /agent-browser/);
      NodeAssert.doesNotMatch(instructions, /rrweb/i);
      NodeAssert.doesNotMatch(instructions, /Chrome DevTools MCP/);
      NodeAssert.doesNotMatch(instructions, /chrome-devtools-mcp/);
    }),
  );
});

describe("Codex developer instructions availability", () => {
  it("omits the browser block entirely when the preview tools are not attached", () => {
    for (const instructions of [
      codexDefaultModeDeveloperInstructions(false),
      codexPlanModeDeveloperInstructions(false),
    ]) {
      NodeAssert.doesNotMatch(instructions, /preview_status/);
      NodeAssert.doesNotMatch(instructions, /preview_open/);
      NodeAssert.doesNotMatch(instructions, /T3 Code collaborative browser/);
      // Steering away from other browser automation must go with the tools;
      // keeping it would leave the model talked out of its only option.
      NodeAssert.doesNotMatch(instructions, /Do not switch to global browser skills/);
      // The rest of the collaboration mode is untouched.
      NodeAssert.match(instructions, /<collaboration_mode>/);
      NodeAssert.match(instructions, /<\/collaboration_mode>/);
    }
  });

  it("tracks the turn's MCP configuration rather than defaulting to on", () => {
    const runtime = { model: "gpt-5.3-codex", reasoningEffort: "high" };
    NodeAssert.match(buildCodexDeveloperInstructions("default", runtime, true), /preview_open/);
    NodeAssert.doesNotMatch(
      buildCodexDeveloperInstructions("default", runtime, false),
      /preview_open/,
    );
  });
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

function makeThreadStartedNotification(
  threadId: string,
  source: EffectCodexSchema.V2ThreadStartedNotification["thread"]["source"],
  threadSource?: string,
) {
  return {
    method: "thread/started" as const,
    params: {
      thread: {
        cliVersion: "0.0.0",
        createdAt: 0,
        cwd: "/tmp/project",
        ephemeral: true,
        id: threadId,
        modelProvider: "openai",
        preview: "",
        sessionId: threadId,
        source,
        status: { type: "idle" as const },
        ...(threadSource ? { threadSource } : {}),
        turns: [],
        updatedAt: 0,
      },
    },
  };
}

describe("makeMemoryConsolidationNotificationFilter", () => {
  it("suppresses memory consolidation without hiding other Codex subagents", () => {
    const shouldSuppress = makeMemoryConsolidationNotificationFilter();

    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification("memory-thread", "unknown", "memory_consolidation"),
      ),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "internal memory update",
          itemId: "memory-message",
          threadId: "memory-thread",
          turnId: "memory-turn",
        },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "serverRequest/resolved",
        params: {
          requestId: "memory-approval",
          threadId: "memory-thread",
        },
      }),
      false,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "warning",
        params: {
          message: "internal warning",
          threadId: "memory-thread",
        },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "normal reply",
          itemId: "root-message",
          threadId: "root-thread",
          turnId: "root-turn",
        },
      }),
      false,
    );

    NodeAssert.equal(
      shouldSuppress(
        makeThreadStartedNotification("legacy-memory-thread", {
          subAgent: "memory_consolidation",
        }),
      ),
      true,
    );

    for (const source of [
      { subAgent: "review" as const },
      { subAgent: "compact" as const },
      {
        subAgent: {
          thread_spawn: {
            depth: 1,
            parent_thread_id: "root-thread",
          },
        },
      },
    ]) {
      NodeAssert.equal(
        shouldSuppress(makeThreadStartedNotification("visible-subagent", source)),
        false,
      );
    }
  });

  it("forgets memory consolidation threads after they close", () => {
    const shouldSuppress = makeMemoryConsolidationNotificationFilter();
    shouldSuppress(
      makeThreadStartedNotification("memory-thread", "unknown", "memory_consolidation"),
    );

    NodeAssert.equal(
      shouldSuppress({
        method: "thread/closed",
        params: { threadId: "memory-thread" },
      }),
      true,
    );
    NodeAssert.equal(
      shouldSuppress({
        method: "item/agentMessage/delta",
        params: {
          delta: "later message",
          itemId: "later-message",
          threadId: "memory-thread",
          turnId: "later-turn",
        },
      }),
      false,
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

  it("matches a missing rollout for a known thread id", () => {
    NodeAssert.equal(
      isRecoverableThreadResumeError(
        new CodexErrors.CodexAppServerRequestError({
          code: -32603,
          errorMessage: "no rollout found for thread id 019fdf74-aaa9-7950-b252-7cc7a8650470",
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
