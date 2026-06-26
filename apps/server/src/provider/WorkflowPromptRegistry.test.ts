import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  listWorkflowPromptContracts,
  resolveWorkflowPromptText,
  WORKFLOW_PROMPT_IDS,
} from "./WorkflowPromptRegistry.ts";

describe("WorkflowPromptRegistry", () => {
  it("scopes Chrome DevTools MCP docs to Browser Dev Review", () => {
    const contracts = listWorkflowPromptContracts();
    const browserReview = contracts.find(
      (contract) => contract.id === WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
    );

    NodeAssert.ok(browserReview);
    const chromeDoc = browserReview.associatedDocs?.find(
      (doc) => doc.id === "implementation.browser-dev-review.chrome-devtools-mcp",
    );
    NodeAssert.ok(chromeDoc);
    NodeAssert.equal(chromeDoc.path, "chrome-devtools-mcp.md");
    NodeAssert.match(chromeDoc.content, /Browser Dev Review QA role only/);
    NodeAssert.match(chromeDoc.content, /npx -y chrome-devtools-mcp@latest/);
    NodeAssert.match(chromeDoc.content, /--screenshot-format=webp/);
    NodeAssert.match(chromeDoc.content, /list_console_messages/);

    for (const promptId of [
      WORKFLOW_PROMPT_IDS.implementationOrchestratorPlanningCodex,
      WORKFLOW_PROMPT_IDS.implementationTddCodex,
      WORKFLOW_PROMPT_IDS.implementationMergeGateCodex,
    ]) {
      const contract = contracts.find((entry) => entry.id === promptId);
      NodeAssert.ok(contract);
      NodeAssert.equal(
        Boolean(
          contract.associatedDocs?.some(
            (doc) => doc.id === "implementation.browser-dev-review.chrome-devtools-mcp",
          ),
        ),
        false,
      );
    }
  });

  it("renders Browser Dev Review with its Chrome DevTools MCP associated doc", () => {
    const rendered = resolveWorkflowPromptText(
      WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
    );

    NodeAssert.match(rendered, /<associated-doc/);
    NodeAssert.match(rendered, /chrome-devtools-mcp\.md/);
    NodeAssert.match(rendered, /--redact-network-headers/);
  });
});
