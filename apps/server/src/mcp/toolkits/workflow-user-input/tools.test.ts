import { expect, it } from "@effect/vitest";
import { WORKFLOW_USER_INPUT_MAX_QUESTIONS } from "@t3tools/contracts";
import { Tool } from "effect/unstable/ai";

import { WorkflowRequestUserInputTool } from "./tools.ts";

it("publishes the same question shape the clients render", () => {
  const schema = Tool.getJsonSchema(WorkflowRequestUserInputTool) as {
    readonly properties: {
      readonly questions: {
        readonly allOf: ReadonlyArray<Record<string, number>>;
        readonly items: { readonly required: ReadonlyArray<string> };
      };
    };
  };

  expect(WorkflowRequestUserInputTool.name).toBe("workflow_request_user_input");
  expect(schema.properties.questions.allOf).toEqual([
    { minItems: 1 },
    { maxItems: WORKFLOW_USER_INPUT_MAX_QUESTIONS },
  ]);
  // The recommendation is what the card renders below the options, so it is
  // required rather than optional.
  expect(schema.properties.questions.items.required).toContain("recommendation");
});
