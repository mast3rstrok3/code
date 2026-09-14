import { expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";
import { ReviewTestPlatforms } from "./reviewPlatforms.ts";
import { OrchestrationCommand } from "./orchestration.ts";

const decode = Schema.decodeUnknownSync(ReviewTestPlatforms);
const decodeCommand = Schema.decodeUnknownSync(OrchestrationCommand);

it("requires a supported non-empty platform selection", () => {
  expect(decode(["web", "windows", "android", "ios", "macos"])).toHaveLength(5);
  expect(() => decode([])).toThrow();
  expect(() => decode(["linux"])).toThrow();
});

it("retains platform choices through the workflow settings command schema", () => {
  const parts = {
    e2e: true,
    browser: true,
    testPlatforms: ["web", "windows"],
    ticketTestPlatforms: [{ ticketId: "ticket-1", platforms: ["ios"] }],
  };
  const command = decodeCommand({
    type: "thread.workflow.step-review-parts.set",
    commandId: "cmd-platforms",
    threadId: "thread-root",
    workflowPromptId: "implementation.browser-app-review.codex",
    parts,
    createdAt: "2026-09-12T00:00:00.000Z",
  });
  expect(command.type === "thread.workflow.step-review-parts.set" && command.parts).toEqual(parts);
});
