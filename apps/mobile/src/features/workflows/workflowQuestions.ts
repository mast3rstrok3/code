import {
  ApprovalRequestId,
  UserInputRequestedPayload,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

const QuestionPayload = Schema.Struct({
  ...UserInputRequestedPayload.fields,
  requestId: Schema.String,
});
const ResolvedPayload = Schema.Struct({ requestId: Schema.String });
const decodeQuestionPayload = Schema.decodeUnknownOption(QuestionPayload);
const decodeResolvedPayload = Schema.decodeUnknownOption(ResolvedPayload);

export type WorkflowPendingQuestion = {
  readonly requestId: ApprovalRequestId;
  readonly questions: (typeof QuestionPayload.Type)["questions"];
};

/**
 * Questions a workflow asked that nothing has answered. Providers that ask
 * through the T3 MCP server only post these as activities, so the sheet is
 * where mobile can answer them.
 */
export function pendingWorkflowQuestions(
  activities: readonly OrchestrationThreadActivity[],
): readonly WorkflowPendingQuestion[] {
  const resolved = new Set(
    activities.flatMap((activity) => {
      if (activity.kind !== "user-input.resolved") return [];
      const payload = decodeResolvedPayload(activity.payload);
      return Option.isSome(payload) ? [payload.value.requestId] : [];
    }),
  );
  return activities.flatMap((activity) => {
    if (activity.kind !== "user-input.requested") return [];
    const decoded = decodeQuestionPayload(activity.payload);
    return Option.isSome(decoded) && !resolved.has(decoded.value.requestId)
      ? [
          {
            requestId: ApprovalRequestId.make(decoded.value.requestId),
            questions: decoded.value.questions,
          },
        ]
      : [];
  });
}
