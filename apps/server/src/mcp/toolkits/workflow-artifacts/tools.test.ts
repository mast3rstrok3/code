import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import {
  WorkflowContextGetTool,
  WorkflowDevReviewsListTool,
  WorkflowSpecGetTool,
  WorkflowTicketsListTool,
} from "./tools.ts";

it("publishes object parameter schemas for zero-argument workflow artifact tools", () => {
  const tools = [
    WorkflowContextGetTool,
    WorkflowSpecGetTool,
    WorkflowTicketsListTool,
    WorkflowDevReviewsListTool,
  ];

  for (const tool of tools) {
    expect(Tool.getJsonSchema(tool)).toEqual({
      type: "object",
      additionalProperties: false,
    });
  }
});
