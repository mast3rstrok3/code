import { expect, it } from "@effect/vitest";
import { Tool } from "effect/unstable/ai";

import {
  WorkflowContextGetTool,
  WorkflowAppReviewsListTool,
  WorkflowSpecGetTool,
  WorkflowTicketsListTool,
  WorkflowWayfinderMapGetTool,
} from "./tools.ts";

it("publishes object parameter schemas for zero-argument workflow artifact tools", () => {
  const tools = [
    WorkflowContextGetTool,
    WorkflowWayfinderMapGetTool,
    WorkflowSpecGetTool,
    WorkflowTicketsListTool,
    WorkflowAppReviewsListTool,
  ];

  for (const tool of tools) {
    expect(Tool.getJsonSchema(tool)).toEqual({
      type: "object",
      additionalProperties: false,
    });
  }
});
