import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  isPreviewMcpWorkflowPromptId,
  listWorkflowPromptContracts,
  normalizeWorkflowPromptId,
  resolveWorkflowPromptId,
  resolveWorkflowPromptText,
  WORKFLOW_PROMPT_IDS,
} from "./WorkflowPromptRegistry.ts";

describe("WorkflowPromptRegistry", () => {
  it("renders Planning Workflow Grill with fused domain-modeling instructions and docs", () => {
    const contracts = listWorkflowPromptContracts();
    const planningGrill = contracts.find(
      (contract) => contract.id === WORKFLOW_PROMPT_IDS.planningGrillStageCodex,
    );

    NodeAssert.ok(planningGrill);
    NodeAssert.equal(planningGrill.workflow, "planning");
    NodeAssert.equal(planningGrill.stage, "grill");
    NodeAssert.equal(planningGrill.title, "1. Grill");

    const rendered = resolveWorkflowPromptText(WORKFLOW_PROMPT_IDS.planningGrillStageCodex);
    NodeAssert.match(rendered, /Planning Workflow: Grill With Domain Modeling/);
    NodeAssert.match(rendered, /Ask exactly one question at a time/);
    NodeAssert.match(rendered, /recommended answer/);
    NodeAssert.match(rendered, /exploring the repository/);
    NodeAssert.match(rendered, /CONTEXT\.md is a glossary for domain language only/);
    NodeAssert.match(rendered, /Offer an ADR only when/);
    NodeAssert.match(rendered, /Planning artifact writes are allowed/);
    NodeAssert.match(rendered, /CONTEXT\.md Format/);
    NodeAssert.match(rendered, /glossary for domain language only/);
    NodeAssert.match(rendered, /CONTEXT-MAP\.md/);
    NodeAssert.match(rendered, /_Avoid_/);
    NodeAssert.match(rendered, /ADR Format/);
    NodeAssert.match(rendered, /hard to reverse/);

    const contextDoc = planningGrill.associatedDocs?.find(
      (doc) => doc.id === "planning.grill-stage.context-format",
    );
    NodeAssert.ok(contextDoc);
    NodeAssert.equal(contextDoc.path, "CONTEXT-FORMAT.md");
    NodeAssert.match(contextDoc.content, /CONTEXT\.md is a glossary for domain language only/);
    NodeAssert.match(contextDoc.content, /## Structure/);
    NodeAssert.match(contextDoc.content, /## Language/);
    NodeAssert.match(contextDoc.content, /_Avoid_: Purchase, transaction/);
    NodeAssert.match(contextDoc.content, /Only include terms specific to this project's context/);
    NodeAssert.match(contextDoc.content, /## Single vs multi-context repos/);
    NodeAssert.match(contextDoc.content, /# Context Map/);

    const adrDoc = planningGrill.associatedDocs?.find(
      (doc) => doc.id === "planning.grill-stage.adr-format",
    );
    NodeAssert.ok(adrDoc);
    NodeAssert.equal(adrDoc.path, "ADR-FORMAT.md");
    NodeAssert.match(adrDoc.content, /ADRs live in `docs\/adr\/`/);
    NodeAssert.match(adrDoc.content, /Create the `docs\/adr\/` directory lazily/);
    NodeAssert.match(adrDoc.content, /# \{Short title of the decision\}/);
    NodeAssert.match(adrDoc.content, /An ADR can be a single paragraph/);
    NodeAssert.match(adrDoc.content, /Only include these when they add genuine value/);
    NodeAssert.match(adrDoc.content, /Scan `docs\/adr\/` for the highest existing number/);
    NodeAssert.match(adrDoc.content, /All three of these must be true/);
    NodeAssert.match(adrDoc.content, /Rejected alternatives when the rejection is non-obvious/);
    NodeAssert.doesNotMatch(adrDoc.content, /# ADR NNNN: Title/);
    NodeAssert.doesNotMatch(adrDoc.content, /## Validation/);
  });

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

    for (const contract of contracts.filter((entry) => entry.id !== browserReview.id)) {
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
    NodeAssert.match(rendered, /dev_review_get/);
    NodeAssert.match(rendered, /dev_review_replay_start/);
    NodeAssert.match(rendered, /dev_review_replay_stop/);
    NodeAssert.match(rendered, /preview_/);
    NodeAssert.ok(
      isPreviewMcpWorkflowPromptId(WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex),
    );
  });

  it("renders TDD Implementation with tracer-bullet vertical-slice guidance", () => {
    const contracts = listWorkflowPromptContracts();
    const tdd = contracts.find(
      (contract) => contract.id === WORKFLOW_PROMPT_IDS.implementationTddCodex,
    );

    NodeAssert.ok(tdd);
    NodeAssert.equal(tdd.workflow, "implementation");
    NodeAssert.equal(tdd.stage, "tdd");
    NodeAssert.equal(tdd.title, "2. TDD Implementation");
    NodeAssert.equal(
      tdd.associatedDocs?.map((doc) => doc.path).join(","),
      "mocking.md,refactoring.md,tests.md,logging.md",
    );

    const rendered = resolveWorkflowPromptText(WORKFLOW_PROMPT_IDS.implementationTddCodex);
    NodeAssert.match(rendered, /name: tdd/);
    NodeAssert.match(rendered, /Tests should verify behavior through public interfaces/);
    NodeAssert.match(rendered, /Anti-Pattern: Horizontal Slices/);
    NodeAssert.match(rendered, /DO NOT write all tests first, then all implementation/);
    NodeAssert.match(rendered, /Correct approach.*Vertical slices via tracer bullets/s);
    NodeAssert.match(rendered, /### 2\. Tracer Bullet/);
    NodeAssert.match(rendered, /Write ONE test that confirms ONE thing about the system/);
    NodeAssert.match(rendered, /One test at a time/);
    NodeAssert.match(rendered, /Never refactor while RED/);
    NodeAssert.doesNotMatch(rendered, /deep-modules\.md/);
    NodeAssert.doesNotMatch(rendered, /interface-design\.md/);
    NodeAssert.match(rendered, /mocking\.md/);
    NodeAssert.match(rendered, /# Refactor Candidates/);
    NodeAssert.match(rendered, /Primitive obsession.*Introduce value objects/);
    NodeAssert.match(rendered, /Existing code.*reveals as problematic/);
    NodeAssert.match(rendered, /tests\.md/);
    NodeAssert.match(rendered, /logging\.md/);
    NodeAssert.match(rendered, /Logging for TDD/);
    NodeAssert.match(rendered, /wide event/);
    NodeAssert.match(rendered, /canonical log line/);
    NodeAssert.match(rendered, /high-cardinality/);
    NodeAssert.match(rendered, /Effect\.annotateCurrentSpan/);
    NodeAssert.match(rendered, /Effect\.log/);
    NodeAssert.match(rendered, /Always keep errors/);

    const mockingDoc = tdd.associatedDocs?.find((doc) => doc.id === "implementation.tdd.mocking");
    NodeAssert.ok(mockingDoc);
    NodeAssert.equal(mockingDoc.path, "mocking.md");
    NodeAssert.match(mockingDoc.content, /Mock at \*\*system boundaries\*\* only/);
    NodeAssert.match(mockingDoc.content, /External APIs \(payment, email, etc\.\)/);
    NodeAssert.match(mockingDoc.content, /Don't mock:/);
    NodeAssert.match(mockingDoc.content, /Your own classes\/modules/);
    NodeAssert.match(mockingDoc.content, /Use dependency injection/);
    NodeAssert.match(mockingDoc.content, /Prefer SDK-style interfaces over generic fetchers/);
    NodeAssert.match(mockingDoc.content, /No conditional logic in test setup/);

    const refactoringDoc = tdd.associatedDocs?.find(
      (doc) => doc.id === "implementation.tdd.refactoring",
    );
    NodeAssert.ok(refactoringDoc);
    NodeAssert.equal(refactoringDoc.path, "refactoring.md");
    NodeAssert.match(refactoringDoc.content, /# Refactor Candidates/);
    NodeAssert.match(refactoringDoc.content, /Duplication.*Extract function\/class/);
    NodeAssert.match(refactoringDoc.content, /Long methods.*private helpers/);
    NodeAssert.match(refactoringDoc.content, /Shallow modules.*Combine or deepen/);
    NodeAssert.match(refactoringDoc.content, /Feature envy.*where data lives/);
    NodeAssert.match(refactoringDoc.content, /Primitive obsession.*value objects/);
    NodeAssert.match(refactoringDoc.content, /Existing code.*reveals as problematic/);

    const testsDoc = tdd.associatedDocs?.find((doc) => doc.id === "implementation.tdd.tests");
    NodeAssert.ok(testsDoc);
    NodeAssert.equal(testsDoc.path, "tests.md");
    NodeAssert.match(testsDoc.content, /# Good and Bad Tests/);
    NodeAssert.match(testsDoc.content, /Test through real interfaces/);
    NodeAssert.match(testsDoc.content, /user can checkout with valid cart/);
    NodeAssert.match(testsDoc.content, /Mocking internal collaborators/);
    NodeAssert.match(testsDoc.content, /createUser makes user retrievable/);

    const loggingDoc = tdd.associatedDocs?.find((doc) => doc.id === "implementation.tdd.logging");
    NodeAssert.ok(loggingDoc);
    NodeAssert.equal(loggingDoc.path, "logging.md");
    NodeAssert.match(loggingDoc.content, /# Logging for TDD Implementation/);
    NodeAssert.match(loggingDoc.content, /Structured logging/);
    NodeAssert.match(loggingDoc.content, /wide event/);
    NodeAssert.match(loggingDoc.content, /canonical log line/);
    NodeAssert.match(loggingDoc.content, /Effect\.annotateCurrentSpan/);
    NodeAssert.match(loggingDoc.content, /Always keep errors/);
  });

  it("renders Planning PRD with to-prd synthesis and publishing instructions", () => {
    const rendered = resolveWorkflowPromptText(WORKFLOW_PROMPT_IDS.planningPrdCodex);

    NodeAssert.match(rendered, /name: to-prd/);
    NodeAssert.match(rendered, /Do NOT interview the user/);
    NodeAssert.match(rendered, /Sketch out the seams at which you're going to test the feature/);
    NodeAssert.match(rendered, /Check with the user that these seams match their expectations/);
    NodeAssert.match(rendered, /publish it to the project issue tracker/);
    NodeAssert.match(rendered, /`ready-for-agent`/);
    NodeAssert.match(rendered, /## Problem Statement/);
    NodeAssert.match(rendered, /## User Stories/);
    NodeAssert.match(rendered, /## Testing Decisions/);
  });

  it("renders Planning Issues with to-issues vertical-slice drafting instructions", () => {
    const rendered = resolveWorkflowPromptText(WORKFLOW_PROMPT_IDS.planningIssuesCodex);

    NodeAssert.match(rendered, /name: to-issues/);
    NodeAssert.match(rendered, /tracer-bullet vertical slices/);
    NodeAssert.match(rendered, /fetch it from the issue tracker and read its full body/);
    NodeAssert.match(rendered, /thin vertical slice that cuts through ALL integration layers/);
    NodeAssert.match(rendered, /<vertical-slice-rules>/);
    NodeAssert.match(rendered, /schema, API, UI, tests/);
    NodeAssert.match(rendered, /Stop after drafting the proposed issue set/);
    NodeAssert.match(rendered, /Do not quiz the user and do not publish/);
    NodeAssert.match(rendered, /The Issues Review stage owns completeness review/);
    NodeAssert.doesNotMatch(rendered, /Does the granularity feel right/);
    NodeAssert.doesNotMatch(rendered, /Publish issues in dependency order/);
    NodeAssert.doesNotMatch(rendered, /<issue-template>/);
  });

  it("renders Planning Issue Review with PRD completeness, vertical-slice review, and final quiz instructions", () => {
    const rendered = resolveWorkflowPromptText(WORKFLOW_PROMPT_IDS.planningIssueReviewerCodex);

    NodeAssert.match(rendered, /Review the PRD, conversation context, durable project context/);
    NodeAssert.match(rendered, /whether the issue set is complete/);
    NodeAssert.match(rendered, /vertical slices are correct tracer bullets/);
    NodeAssert.match(rendered, /cover the PRD's user stories/);
    NodeAssert.match(rendered, /not a horizontal layer-only task/);
    NodeAssert.match(rendered, /Repeat review after issue adjustments/);
    NodeAssert.match(
      rendered,
      /Do not quiz the user while the issue set still needs review corrections/,
    );
    NodeAssert.match(rendered, /The reviewer subagent should not quiz the user/);
    NodeAssert.match(
      rendered,
      /After the subagent issues reviewer has completed all review cycles/,
    );
    NodeAssert.match(rendered, /Does the granularity feel right/);
    NodeAssert.match(rendered, /Are the dependency relationships correct/);
    NodeAssert.match(rendered, /Should any slices be merged or split further/);
    NodeAssert.match(rendered, /Publish issues in dependency order/);
    NodeAssert.match(rendered, /<issue-template>/);
    NodeAssert.match(rendered, /## What to build/);
    NodeAssert.match(rendered, /None - can start immediately/);
    NodeAssert.match(rendered, /Do NOT close or modify any parent issue/);
  });

  it("registers Product Grill and normalizes legacy prompt ids", () => {
    const contracts = listWorkflowPromptContracts();
    const product = contracts.find(
      (contract) => contract.id === WORKFLOW_PROMPT_IDS.productGrillStageCodex,
    );

    NodeAssert.ok(product);
    NodeAssert.equal(product.workflow, "product");
    NodeAssert.equal(product.title, "Product Grill");
    NodeAssert.deepEqual(
      contracts
        .filter((contract) => contract.workflow === "product")
        .map((contract) => contract.stage),
      ["grill"],
    );
    const contextDoc = product.associatedDocs?.find(
      (doc) => doc.id === "product.grill-stage.context-format",
    );
    NodeAssert.ok(contextDoc);
    NodeAssert.equal(contextDoc.path, "CONTEXT-FORMAT.md");
    NodeAssert.match(contextDoc.content, /# CONTEXT\.md Format/);
    NodeAssert.match(contextDoc.content, /CONTEXT-MAP\.md/);
    NodeAssert.match(contextDoc.content, /If neither exists, create a root `CONTEXT\.md` lazily/);

    const adrDoc = product.associatedDocs?.find(
      (doc) => doc.id === "product.grill-stage.adr-format",
    );
    NodeAssert.ok(adrDoc);
    NodeAssert.equal(adrDoc.path, "ADR-FORMAT.md");
    NodeAssert.match(adrDoc.content, /# ADR Format/);

    const renderedProduct = resolveWorkflowPromptText(WORKFLOW_PROMPT_IDS.productGrillStageCodex);
    NodeAssert.match(
      renderedProduct,
      /Ask exactly one product-alignment question at a time|Ask exactly one product-alignment question|Ask exactly one .*question at a time/s,
    );
    NodeAssert.match(renderedProduct, /recommended answer/);
    NodeAssert.match(renderedProduct, /Explore repository facts before asking/);
    NodeAssert.match(renderedProduct, /Create or update CONTEXT\.md lazily/);
    NodeAssert.match(renderedProduct, /docs\/adr\/000N-slug\.md lazily/);
    NodeAssert.match(renderedProduct, /"type": "product-intent-locked"/);

    NodeAssert.equal(resolveWorkflowPromptId({ interactionMode: "product-workflow" }), product.id);
    NodeAssert.equal(normalizeWorkflowPromptId("yolo.grill-stage.codex"), product.id);
    NodeAssert.equal(
      normalizeWorkflowPromptId("implementation.qna-dev-review.codex"),
      WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
    );
    NodeAssert.equal(
      contracts.some((contract) => contract.id === "implementation.qna-dev-review.codex"),
      false,
    );
    NodeAssert.equal(
      contracts.some((contract) => (contract.workflow as string) === "yolo"),
      false,
    );
  });
});
