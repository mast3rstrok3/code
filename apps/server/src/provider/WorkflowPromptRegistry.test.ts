import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  isDevReviewMcpWorkflowPromptId,
  isPreviewMcpWorkflowPromptId,
  isRegisteredWorkflowPromptId,
  listWorkflowPromptContracts,
  resolveWorkflowPromptId,
  resolveWorkflowSystemInstructions,
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
    NodeAssert.match(rendered, /Interview me relentlessly/);
    NodeAssert.match(rendered, /Ask the questions one at a time/);
    NodeAssert.match(rendered, /Asking multiple questions at once is bewildering/);
    NodeAssert.match(rendered, /recommended answer/);
    NodeAssert.match(rendered, /exploring the codebase/);
    NodeAssert.match(rendered, /It is a glossary and nothing else/);
    NodeAssert.match(rendered, /Only offer to create an ADR when all three are true/);
    NodeAssert.match(rendered, /Planning artifact writes are allowed/);
    NodeAssert.match(rendered, /CONTEXT\.md Format/);
    NodeAssert.match(rendered, /CONTEXT-MAP\.md/);
    NodeAssert.match(rendered, /_Avoid_/);
    NodeAssert.match(rendered, /ADR Format/);
    NodeAssert.match(rendered, /Hard to reverse/);

    const contextDoc = planningGrill.associatedDocs?.find(
      (doc) => doc.id === "planning.grill-stage.context-format",
    );
    NodeAssert.ok(contextDoc);
    NodeAssert.equal(contextDoc.path, "CONTEXT-FORMAT.md");
    NodeAssert.match(contextDoc.content, /# CONTEXT\.md Format/);
    NodeAssert.match(contextDoc.content, /Be opinionated\./);
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

  it("scopes the Preview Browser QA doc to Browser Dev Review", () => {
    const contracts = listWorkflowPromptContracts();
    const browserReview = contracts.find(
      (contract) => contract.id === WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
    );

    NodeAssert.ok(browserReview);
    const previewQaDoc = browserReview.associatedDocs?.find(
      (doc) => doc.id === "implementation.browser-dev-review.preview-browser-qa",
    );
    NodeAssert.ok(previewQaDoc);
    NodeAssert.equal(previewQaDoc.path, "preview-browser-qa.md");
    NodeAssert.match(previewQaDoc.content, /preview_open/);
    NodeAssert.match(previewQaDoc.content, /preview_navigate/);
    NodeAssert.match(previewQaDoc.content, /preview_snapshot/);
    NodeAssert.match(previewQaDoc.content, /preview_resize/);
    NodeAssert.match(previewQaDoc.content, /preview_evaluate/);
    NodeAssert.match(previewQaDoc.content, /dev_review_recording_start/);
    NodeAssert.match(previewQaDoc.content, /dev_review_capture_screenshot/);
    NodeAssert.match(previewQaDoc.content, /go stale/i);
    NodeAssert.doesNotMatch(previewQaDoc.content, /agent-browser/i);
    NodeAssert.doesNotMatch(previewQaDoc.content, /rrweb/i);
    NodeAssert.doesNotMatch(previewQaDoc.content, /chrome-devtools-mcp/);

    for (const contract of contracts.filter((entry) => entry.id !== browserReview.id)) {
      NodeAssert.equal(
        Boolean(
          contract.associatedDocs?.some(
            (doc) => doc.id === "implementation.browser-dev-review.preview-browser-qa",
          ),
        ),
        false,
      );
    }
  });

  it("prepends shared workflow sub-agent instructions to workflow prompts", () => {
    const rendered =
      resolveWorkflowSystemInstructions({
        workflowPromptId: WORKFLOW_PROMPT_IDS.planningSpecCodex,
      }) ?? "";

    NodeAssert.match(rendered, /T3 Workflow Sub-Agent System/);
    NodeAssert.match(rendered, /Workflow skills are SKILL\.md-backed instructions/);
    NodeAssert.match(rendered, /\.codex\/skills\/\*\*\/SKILL\.md/);
    NodeAssert.match(rendered, /\.agents\/skills\/\*\*\/SKILL\.md/);
    NodeAssert.match(rendered, /product\.workflow\.codex/);
    NodeAssert.match(rendered, /planning\.ticket-reviewer\.codex/);
    NodeAssert.match(rendered, /implementation\.browser-dev-review\.codex/);
    NodeAssert.match(rendered, /workflow-subagent-create/);
    NodeAssert.match(rendered, /durable Dev Review record/);
    NodeAssert.match(rendered, /dev-review-document/);
    NodeAssert.match(rendered, /workflow-agent-message/);
    NodeAssert.match(rendered, /Planning Workflow: Spec/);
  });

  it("renders Browser Dev Review around the preview_* and dev_review_* MCP tools", () => {
    const rendered = resolveWorkflowPromptText(
      WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
    );

    NodeAssert.match(rendered, /<associated-doc/);
    NodeAssert.match(rendered, /preview-browser-qa\.md/);
    NodeAssert.match(rendered, /preview_open/);
    NodeAssert.match(rendered, /dev_review_get/);
    NodeAssert.match(rendered, /preview_navigate/);
    NodeAssert.match(rendered, /dev_review_recording_start/);
    NodeAssert.match(rendered, /dev_review_recording_stop/);
    NodeAssert.match(rendered, /dev_review_capture_screenshot/);
    NodeAssert.match(rendered, /mark the review blocked/i);
    NodeAssert.doesNotMatch(rendered, /agent-browser/i);
    NodeAssert.doesNotMatch(rendered, /rrweb/i);
    NodeAssert.doesNotMatch(rendered, /Chrome DevTools MCP/);
    NodeAssert.doesNotMatch(rendered, /chrome-devtools-mcp/);
    NodeAssert.ok(
      isPreviewMcpWorkflowPromptId(WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex),
    );
    NodeAssert.ok(
      isDevReviewMcpWorkflowPromptId(WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex),
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
      "mocking.md,tests.md,logging.md",
    );

    const rendered = resolveWorkflowPromptText(WORKFLOW_PROMPT_IDS.implementationTddCodex);
    NodeAssert.match(rendered, /name: tdd/);
    NodeAssert.match(rendered, /TDD is the red → green loop/);
    NodeAssert.match(rendered, /Tests verify behavior through public interfaces/);
    NodeAssert.match(rendered, /Test only at pre-agreed seams/);
    NodeAssert.match(rendered, /## Anti-patterns/);
    NodeAssert.match(rendered, /writing all tests first, then all implementation/);
    NodeAssert.match(rendered, /passes by construction/);
    NodeAssert.match(rendered, /Work in \*\*vertical slices\*\* instead/);
    NodeAssert.match(rendered, /tracer bullet/);
    NodeAssert.match(rendered, /One slice at a time/);
    NodeAssert.match(rendered, /Refactoring is not part of the loop/);
    NodeAssert.doesNotMatch(rendered, /deep-modules\.md/);
    NodeAssert.doesNotMatch(rendered, /interface-design\.md/);
    NodeAssert.doesNotMatch(rendered, /refactoring\.md/);
    NodeAssert.match(rendered, /mocking\.md/);
    NodeAssert.match(rendered, /tests\.md/);
    NodeAssert.match(rendered, /See \[logging\.md\]\(logging\.md\)/);
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

    const testsDoc = tdd.associatedDocs?.find((doc) => doc.id === "implementation.tdd.tests");
    NodeAssert.ok(testsDoc);
    NodeAssert.equal(testsDoc.path, "tests.md");
    NodeAssert.match(testsDoc.content, /# Good and Bad Tests/);
    NodeAssert.match(testsDoc.content, /Test through real interfaces/);
    NodeAssert.match(testsDoc.content, /user can checkout with valid cart/);
    NodeAssert.match(testsDoc.content, /Mocking internal collaborators/);
    NodeAssert.match(testsDoc.content, /createUser makes user retrievable/);
    NodeAssert.match(testsDoc.content, /Tautological tests/);
    NodeAssert.match(testsDoc.content, /calculateTotal sums line items/);
    NodeAssert.match(testsDoc.content, /Expected value is an independent, known literal/);

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

  it("renders Planning Spec with to-spec synthesis and publishing instructions", () => {
    const rendered = resolveWorkflowPromptText(WORKFLOW_PROMPT_IDS.planningSpecCodex);

    NodeAssert.match(rendered, /name: to-spec/);
    NodeAssert.match(rendered, /you may know this document as a PRD/);
    NodeAssert.match(rendered, /Do NOT interview the user/);
    NodeAssert.match(rendered, /Sketch out the seams at which you're going to test the feature/);
    NodeAssert.match(rendered, /Check with the user that these seams match their expectations/);
    NodeAssert.match(rendered, /publish it to the project issue tracker/);
    NodeAssert.match(rendered, /`ready-for-agent`/);
    NodeAssert.match(rendered, /## Problem Statement/);
    NodeAssert.match(rendered, /## User Stories/);
    NodeAssert.match(rendered, /## Testing Decisions/);
  });

  it("renders Planning Tickets with to-tickets vertical-slice drafting instructions", () => {
    const rendered = resolveWorkflowPromptText(WORKFLOW_PROMPT_IDS.planningTicketsCodex);

    NodeAssert.match(rendered, /name: to-tickets/);
    NodeAssert.match(rendered, /tracer-bullet vertical slices/);
    NodeAssert.match(rendered, /fetch it from the ticket tracker and read its full body/);
    NodeAssert.match(rendered, /thin vertical slice that cuts through ALL integration layers/);
    NodeAssert.match(rendered, /<vertical-slice-rules>/);
    NodeAssert.match(rendered, /schema, API, UI, tests/);
    NodeAssert.match(rendered, /Stop after drafting the proposed ticket set/);
    NodeAssert.match(rendered, /Do not quiz the user and do not publish/);
    NodeAssert.match(rendered, /The Ticket Review stage owns completeness review/);
    NodeAssert.doesNotMatch(rendered, /Does the granularity feel right/);
    NodeAssert.doesNotMatch(rendered, /Publish tickets in dependency order/);
    NodeAssert.doesNotMatch(rendered, /<ticket-template>/);
  });

  it("renders Planning Ticket Review with Spec completeness, vertical-slice review, and final quiz instructions", () => {
    const rendered = resolveWorkflowPromptText(WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex);

    NodeAssert.match(rendered, /Review the Spec, conversation context, durable project context/);
    NodeAssert.match(rendered, /whether the ticket set is complete/);
    NodeAssert.match(rendered, /vertical slices are correct tracer bullets/);
    NodeAssert.match(rendered, /cover the Spec's user stories/);
    NodeAssert.match(rendered, /not a horizontal layer-only task/);
    NodeAssert.match(rendered, /call `workflow_tickets_list`/);
    NodeAssert.match(rendered, /retrieve every ticket with `workflow_ticket_get`/);
    NodeAssert.match(rendered, /review only the failed, reworked, or replacement tickets/);
    NodeAssert.match(rendered, /A clean targeted pass completes ticket review/);
    NodeAssert.match(
      rendered,
      /Do not quiz the user while the ticket set still needs review corrections/,
    );
    NodeAssert.match(rendered, /The reviewer subagent should not quiz the user/);
    NodeAssert.match(
      rendered,
      /After the subagent tickets reviewer has completed all review cycles/,
    );
    NodeAssert.match(rendered, /Does the granularity feel right/);
    NodeAssert.match(rendered, /Are the dependency relationships correct/);
    NodeAssert.match(rendered, /Should any slices be merged or split further/);
    NodeAssert.match(rendered, /Publish tickets in dependency order/);
    NodeAssert.match(rendered, /<ticket-template>/);
    NodeAssert.match(rendered, /## What to build/);
    NodeAssert.match(rendered, /None - can start immediately/);
    NodeAssert.match(rendered, /Do NOT close or modify any parent ticket/);
  });

  it("renders Implementation Code Review with the two-axis parallel sub-agent process", () => {
    const contracts = listWorkflowPromptContracts();
    const codeReview = contracts.find(
      (contract) => contract.id === WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex,
    );

    NodeAssert.ok(codeReview);
    NodeAssert.equal(codeReview.workflow, "implementation");
    NodeAssert.equal(codeReview.stage, "code-review");
    NodeAssert.equal(codeReview.role, "implementation-code-reviewer");
    NodeAssert.equal(codeReview.title, "6. Code Review");
    NodeAssert.equal(codeReview.associatedDocs, undefined);

    const rendered = resolveWorkflowPromptText(WORKFLOW_PROMPT_IDS.implementationCodeReviewCodex);
    NodeAssert.match(rendered, /name: code-review/);
    NodeAssert.match(rendered, /Two-axis review of the diff/);
    NodeAssert.match(rendered, /parallel sub-agents/);
    NodeAssert.match(rendered, /### 1\. Pin the fixed point/);
    NodeAssert.match(rendered, /git diff <fixed-point>\.\.\.HEAD/);
    NodeAssert.match(rendered, /### 2\. Identify the spec source/);
    NodeAssert.match(rendered, /no spec available/);
    NodeAssert.match(rendered, /smell baseline/);
    NodeAssert.match(rendered, /The repo overrides\./);
    NodeAssert.match(rendered, /Mysterious Name/);
    NodeAssert.match(rendered, /Refused Bequest/);
    NodeAssert.match(rendered, /Standards sub-agent prompt/);
    NodeAssert.match(rendered, /Spec sub-agent prompt/);
    NodeAssert.match(rendered, /Do \*\*not\*\* merge or rerank findings/);
    NodeAssert.match(rendered, /## Why two axes/);
    NodeAssert.match(rendered, /## Orchestrated Code Review Result/);
    NodeAssert.match(rendered, /"type": "implementation-code-review-result"/);
    NodeAssert.match(rendered, /Use status "clean" when neither axis has findings/);
    // Code Review is the last automated pass: it must land its own fixes and name the commit.
    NodeAssert.match(rendered, /single review-and-fix pass/);
    NodeAssert.match(rendered, /"commitSha"/);
    NodeAssert.match(rendered, /"validations"/);
    NodeAssert.match(rendered, /do not use it to hand unfixed findings back/);
  });

  it("registers the legacy Product prompt and all authoritative preset grills", () => {
    const contracts = listWorkflowPromptContracts();
    const product = contracts.find(
      (contract) => contract.id === WORKFLOW_PROMPT_IDS.productWorkflowCodex,
    );

    NodeAssert.ok(product);
    NodeAssert.equal(product.workflow, "product");
    NodeAssert.equal(product.stage, "intent");
    NodeAssert.equal(product.title, "Full feature workflow (legacy)");
    NodeAssert.deepEqual(
      contracts
        .filter((contract) => contract.workflow === "product")
        .map((contract) => contract.id),
      [
        WORKFLOW_PROMPT_IDS.productWorkflowCodex,
        WORKFLOW_PROMPT_IDS.productFixCodex,
        WORKFLOW_PROMPT_IDS.productFastFeatureCodex,
        WORKFLOW_PROMPT_IDS.productFullFeatureCodex,
      ],
    );
    for (const id of [
      WORKFLOW_PROMPT_IDS.productFixCodex,
      WORKFLOW_PROMPT_IDS.productFastFeatureCodex,
      WORKFLOW_PROMPT_IDS.productFullFeatureCodex,
    ]) {
      const preset = contracts.find((contract) => contract.id === id);
      NodeAssert.ok(preset);
      NodeAssert.doesNotMatch(preset.promptText, /Fix-or-feature classification \(hard gate\)/);
      NodeAssert.match(preset.promptText, /Never ask whether the request is a feature or a fix/);
    }
    // Domain-model maintenance (CONTEXT.md/ADR) is owned by the Planning
    // Workflow: the product grill stays product-only and carries no format docs.
    NodeAssert.equal(product.associatedDocs, undefined);

    const planningSpec = contracts.find(
      (contract) => contract.id === WORKFLOW_PROMPT_IDS.planningSpecCodex,
    );
    NodeAssert.ok(planningSpec);
    const specContextDoc = planningSpec.associatedDocs?.find(
      (doc) => doc.id === "planning.spec.context-format",
    );
    NodeAssert.ok(specContextDoc);
    NodeAssert.equal(specContextDoc.path, "CONTEXT-FORMAT.md");
    NodeAssert.match(specContextDoc.content, /# CONTEXT\.md Format/);

    const specAdrDoc = planningSpec.associatedDocs?.find(
      (doc) => doc.id === "planning.spec.adr-format",
    );
    NodeAssert.ok(specAdrDoc);
    NodeAssert.equal(specAdrDoc.path, "ADR-FORMAT.md");
    NodeAssert.match(specAdrDoc.content, /# ADR Format/);

    const renderedSpec = resolveWorkflowPromptText(WORKFLOW_PROMPT_IDS.planningSpecCodex);
    NodeAssert.match(renderedSpec, /Domain model maintenance/);
    NodeAssert.match(renderedSpec, /locked Product Workflow intent, there is no user to ask/);

    const renderedProduct = resolveWorkflowPromptText(WORKFLOW_PROMPT_IDS.productWorkflowCodex);
    NodeAssert.match(renderedProduct, /single human gate/);
    NodeAssert.match(
      renderedProduct,
      /Interview me relentlessly about every aspect of this product intent/,
    );
    NodeAssert.match(renderedProduct, /Ask the questions one at a time/);
    NodeAssert.match(renderedProduct, /recommended answer/);
    NodeAssert.match(renderedProduct, /look it up rather than asking me/);
    NodeAssert.match(renderedProduct, /Do not lock intent until I confirm/);
    NodeAssert.match(renderedProduct, /Grill product questions only/);
    NodeAssert.match(
      renderedProduct,
      /Do not grill implementation, architecture, or testing decisions/,
    );
    NodeAssert.doesNotMatch(renderedProduct, /Create or update CONTEXT\.md lazily/);
    NodeAssert.doesNotMatch(renderedProduct, /docs\/adr\/000N-slug\.md lazily/);
    NodeAssert.match(
      renderedProduct,
      /Do not create or edit CONTEXT\.md glossaries, CONTEXT-MAP\.md, or ADR files during the grill/,
    );
    NodeAssert.match(renderedProduct, /"type": "product-intent-locked"/);

    NodeAssert.equal(resolveWorkflowPromptId({ interactionMode: "product-workflow" }), product.id);
    NodeAssert.equal(isRegisteredWorkflowPromptId("yolo.grill-stage.codex"), false);
    NodeAssert.equal(isRegisteredWorkflowPromptId("implementation.qna-dev-review.codex"), false);
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
