import {
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
  PreviewAutomationUnavailableError,
  WORKFLOW_USER_INPUT_MAX_QUESTIONS,
  WorkflowUserInputError,
  WorkflowUserInputQuestions,
  WorkflowUserInputResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as WorkflowUserInputBroker from "../../WorkflowUserInputBroker.ts";
import { OrchestrationEngineService } from "../../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../../orchestration/Services/ProjectionSnapshotQuery.ts";

export const WorkflowRequestUserInputTool = Tool.make("workflow_request_user_input", {
  description: `Ask up to ${WORKFLOW_USER_INPUT_MAX_QUESTIONS} currently unblocked workflow questions as one structured card and wait for the user's answers. Each question carries its own options and a separate recommendation the user sees below the options. The call blocks until the user answers, so ask the whole unblocked frontier at once instead of one question per turn.`,
  parameters: Schema.Struct({ questions: WorkflowUserInputQuestions }),
  success: WorkflowUserInputResult,
  failure: Schema.Union([
    WorkflowUserInputError,
    OrchestrationDispatchCommandError,
    OrchestrationGetSnapshotError,
    PreviewAutomationUnavailableError,
  ]),
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    WorkflowUserInputBroker.WorkflowUserInputBroker,
    OrchestrationEngineService,
    ProjectionSnapshotQuery,
  ],
})
  .annotate(Tool.Title, "Ask the user workflow questions")
  .annotate(Tool.Readonly, false)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, false);

export const WorkflowUserInputToolkit = Toolkit.make(WorkflowRequestUserInputTool);
