import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  isAppReviewMcpWorkflowPromptId,
  isPreviewMcpWorkflowPromptId,
  isRegisteredWorkflowPromptId,
  listWorkflowCatalog,
  listWorkflowPromptContracts,
  resolveWorkflowDoc,
  resolveWorkflowPromptId,
  resolveWorkflowSystemInstructions,
  resolveWorkflowPromptText,
  WORKFLOW_PROMPT_IDS,
} from "./WorkflowPromptRegistry.ts";

const GRILLING_BLUEPRINT = [
  "---",
  "name: grilling",
  "description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.",
  "---",
  "",
  "Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.",
  "",
  "Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled — the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.",
  "",
  "Each question should be formatted like so:",
  "",
  "```",
  "❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>",
  "",
  "➡️ <your recommended answer>",
  "```",
  "",
  "Each round the user answers reshapes the tree — settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.",
  "",
  "Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent to find it — don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report — ask the rest of the frontier now. The _decisions_ are the user's — put each to them and wait.",
  "",
  "The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.",
].join("\n");

describe("WorkflowPromptRegistry", () => {
  it("builds a validated, deduplicated workflow catalog", () => {
    const catalog = listWorkflowCatalog();
    NodeAssert.deepEqual(
      catalog.workflows.map((workflow) => workflow.id),
      ["fast-feature", "full-feature", "wayfinder", "planning", "implementation"],
    );
    NodeAssert.equal(
      catalog.skills.filter((skill) => skill.id.startsWith("matt-pocock.")).length,
      18,
    );
    NodeAssert.deepEqual(
      catalog.skills.map((skill) => skill.title),
      catalog.skills
        .map((skill) => skill.title)
        .toSorted((left, right) => left.localeCompare(right)),
    );
    for (const skill of catalog.skills.filter((candidate) =>
      candidate.id.startsWith("matt-pocock."),
    )) {
      NodeAssert.deepEqual(skill.buildModes, ["build"]);
      NodeAssert.match(skill.sourceUrl ?? "", /github\.com\/mattpocock\/skills/);
      NodeAssert.equal(isRegisteredWorkflowPromptId(skill.id), true);
    }
    NodeAssert.equal(catalog.docs.filter((doc) => doc.id === "context-format").length, 1);
    NodeAssert.match(resolveWorkflowDoc("app-dev-stack")?.content ?? "", /Kubernetes-backed/);
    NodeAssert.match(resolveWorkflowDoc("app-dev-stack")?.content ?? "", /mount.*`\/app`/);
    NodeAssert.match(resolveWorkflowDoc("app-dev-stack")?.content ?? "", /separate pod volumes/);
    NodeAssert.match(resolveWorkflowDoc("app-dev-stack")?.content ?? "", /after integration/);
    NodeAssert.match(resolveWorkflowDoc("app-dev-stack")?.content ?? "", /host dependency install/);
    NodeAssert.deepEqual(resolveWorkflowDoc("context-format")?.skillIds, [
      "matt-pocock.grill-with-docs",
      "matt-pocock.domain-modeling",
      "matt-pocock.to-spec",
    ]);
    NodeAssert.equal(resolveWorkflowDoc("missing"), undefined);
    const wayfinder = catalog.skills.find((skill) => skill.id === "matt-pocock.wayfinder");
    NodeAssert.deepEqual(wayfinder?.workflowIds, ["wayfinder"]);
    NodeAssert.match(wayfinder?.promptText ?? "", /## Fog of war/);
    NodeAssert.match(wayfinder?.promptText ?? "", /never resolve more than one ticket per session/);
    NodeAssert.ok((wayfinder?.promptText.length ?? 0) > 12_000);
    const grillWithDocs = catalog.skills.find(
      (skill) => skill.id === "matt-pocock.grill-with-docs",
    );
    NodeAssert.equal(grillWithDocs?.title, "Grill with Docs");
    NodeAssert.deepEqual(grillWithDocs?.workflowIds, ["full-feature", "wayfinder", "planning"]);
    const directGrillWithDocs = resolveWorkflowPromptText("matt-pocock.grill-with-docs");
    NodeAssert.match(directGrillWithDocs, /T3 direct Build adapter/);
    NodeAssert.match(directGrillWithDocs, /Map this as a \*\*design tree\*\*/);
    NodeAssert.match(directGrillWithDocs, /Most repos have a single context/);
    NodeAssert.match(directGrillWithDocs, /supporting-skill-docs/);
    NodeAssert.match(directGrillWithDocs, /# CONTEXT\.md Format/);
    NodeAssert.deepEqual(
      catalog.skills.find((skill) => skill.id === "matt-pocock.domain-modeling")?.workflowIds,
      ["full-feature", "wayfinder", "planning"],
    );
    NodeAssert.match(resolveWorkflowPromptText("matt-pocock.tdd"), /supporting-skill-docs/);
    NodeAssert.match(resolveWorkflowPromptText("matt-pocock.tdd"), /# When to Mock/);
    const renderedDomainModeling = resolveWorkflowPromptText(
      WORKFLOW_PROMPT_IDS.planningDomainModelingCodex,
    );
    NodeAssert.match(renderedDomainModeling, /Most repos have a single context/);
    NodeAssert.match(renderedDomainModeling, /├── CONTEXT-MAP\.md/);
    NodeAssert.match(
      renderedDomainModeling,
      /Your glossary defines 'cancellation' as X, but you seem to mean Y/,
    );
    NodeAssert.match(
      renderedDomainModeling,
      /do you mean the Customer or the User\? Those are different things/,
    );
    NodeAssert.match(
      renderedDomainModeling,
      /Your code cancels entire Orders, but you just said partial cancellation is possible/,
    );
    NodeAssert.match(renderedDomainModeling, /It is a glossary and nothing else/);
    const prototypeLogic = resolveWorkflowDoc("prototype-logic");
    NodeAssert.match(prototypeLogic?.content ?? "", /Isolate the logic in a portable module/);
    NodeAssert.match(prototypeLogic?.content ?? "", /Wire it into the real application/);
    NodeAssert.match(prototypeLogic?.content ?? "", /Don't downgrade to a toy/);
    const prototypeUi = resolveWorkflowDoc("prototype-ui");
    NodeAssert.match(prototypeUi?.content ?? "", /Two sub-shapes — strongly prefer sub-shape A/);
    NodeAssert.match(prototypeUi?.content ?? "", /Build the floating switcher/);
    NodeAssert.ok((prototypeLogic?.content.length ?? 0) > 5_500);
    NodeAssert.ok((prototypeUi?.content.length ?? 0) > 6_800);
    NodeAssert.ok((resolveWorkflowDoc("context-format")?.content.length ?? 0) > 2_200);
    NodeAssert.ok((resolveWorkflowDoc("adr-format")?.content.length ?? 0) > 2_700);
    NodeAssert.deepEqual(resolveWorkflowDoc("domain-docs")?.skillIds, [
      "matt-pocock.to-spec",
      "matt-pocock.to-tickets",
    ]);
    NodeAssert.match(resolveWorkflowDoc("domain-docs")?.content ?? "", /proceed silently/);
    NodeAssert.deepEqual(resolveWorkflowDoc("agent-brief")?.skillIds, [
      "matt-pocock.to-tickets",
      WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex,
    ]);
    NodeAssert.match(resolveWorkflowDoc("agent-brief")?.content ?? "", /Durability over precision/);
    NodeAssert.match(resolveWorkflowDoc("agent-brief")?.content ?? "", /T3 adaptation/);
    NodeAssert.equal(
      catalog.skills.some((skill) => skill.id === WORKFLOW_PROMPT_IDS.workflowAgentCommunications),
      false,
    );
    NodeAssert.deepEqual(
      catalog.skills.find((skill) => skill.id === WORKFLOW_PROMPT_IDS.implementationFixCodex)
        ?.workflowIds,
      ["fast-feature", "full-feature", "implementation"],
    );
    const fastFeature = catalog.workflows.find((workflow) => workflow.id === "fast-feature");
    NodeAssert.ok(
      fastFeature?.steps.some((step) => step.label === "TDD" && step.skillId === "matt-pocock.tdd"),
    );
    const fullFeature = catalog.workflows.find((workflow) => workflow.id === "full-feature");
    NodeAssert.ok(
      fullFeature?.steps.some(
        (step) =>
          step.label === "Ticket Review" &&
          step.skillId === WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex,
      ),
    );
    NodeAssert.ok(
      fullFeature?.steps.some(
        (step) =>
          step.label === "Merge Gate" &&
          step.skillId === WORKFLOW_PROMPT_IDS.implementationMergeGateCodex,
      ),
    );
    for (const workflow of catalog.workflows) {
      for (const step of workflow.steps) {
        if (step.skillId !== undefined) {
          NodeAssert.ok(catalog.skills.some((skill) => skill.id === step.skillId));
        }
      }
    }
  });

  it("registers the independent Grilling primitive outside the workflow catalog", () => {
    const grilling = listWorkflowPromptContracts().find(
      (contract) => contract.id === WORKFLOW_PROMPT_IDS.sharedGrillingCodex,
    );
    NodeAssert.ok(grilling);
    NodeAssert.equal(grilling.title, "Grilling");
    NodeAssert.equal(grilling.promptText, GRILLING_BLUEPRINT);
    NodeAssert.equal(
      listWorkflowCatalog().skills.some(
        (skill) => skill.id === WORKFLOW_PROMPT_IDS.sharedGrillingCodex,
      ),
      false,
    );
  });

  it("renders the Engineering Grill from Grilling plus domain modeling", () => {
    const contracts = listWorkflowPromptContracts();
    const planningGrill = contracts.find(
      (contract) => contract.id === WORKFLOW_PROMPT_IDS.planningGrillStageCodex,
    );

    NodeAssert.ok(planningGrill);
    NodeAssert.equal(planningGrill.workflow, "planning");
    NodeAssert.equal(planningGrill.stage, "grill");
    NodeAssert.equal(planningGrill.title, "1. Engineering Grill");

    const rendered = resolveWorkflowPromptText(WORKFLOW_PROMPT_IDS.planningGrillStageCodex);
    NodeAssert.match(rendered, /# Engineering Grill/);
    NodeAssert.ok(rendered.includes(GRILLING_BLUEPRINT));
    NodeAssert.match(rendered, /name: grilling/);
    NodeAssert.match(rendered, /Map this as a \*\*design tree\*\*/);
    NodeAssert.match(rendered, /Ask the whole frontier in one round/);
    NodeAssert.match(rendered, /❓ \*\*Q1\*\* - \*\*<question title>\*\*/);
    NodeAssert.match(rendered, /➡️ <your recommended answer>/);
    NodeAssert.match(rendered, /dispatch a sub-agent to find it/);
    NodeAssert.match(rendered, /frontier is empty/);
    NodeAssert.doesNotMatch(rendered, /one question at a time/);
    NodeAssert.match(rendered, /It is a glossary and nothing else/);
    NodeAssert.match(rendered, /Only offer to create an ADR when all three are true/);
    NodeAssert.match(rendered, /Planning artifact writes during this stage are limited/);
    NodeAssert.match(rendered, /only exception to the Grilling blueprint/);
    NodeAssert.match(rendered, /frontier-round mechanics remain authoritative/);
    NodeAssert.match(rendered, /## T3 structured-question adapter/);
    NodeAssert.match(rendered, /workflow_request_user_input.*every interview round/);
    NodeAssert.match(rendered, /complete result.*outer text\(result\) helper/);
    NodeAssert.match(rendered, /contentItems, not result\.content/);
    NodeAssert.match(rendered, /one through seven questions.*entire frontier/);
    NodeAssert.match(rendered, /Seven is a maximum, never a target/);
    NodeAssert.match(rendered, /first seven in stable design-tree order/);
    NodeAssert.match(rendered, /Never put questions in the same call when one answer depends/);
    NodeAssert.match(rendered, /natural A\/B\/C order/);
    NodeAssert.match(rendered, /Exactly one separate recommendation object/);
    NodeAssert.match(rendered, /neutral, useful impact or tradeoff description/);
    NodeAssert.match(rendered, /Do not append.*\(Recommended\)/);
    NodeAssert.match(rendered, /do not replace or prefix.*Why that\?/);
    NodeAssert.match(rendered, /one.*workflow_request_user_input.*final shared-understanding/);
    NodeAssert.match(rendered, /Keep grilling/);
    NodeAssert.match(rendered, /Do not duplicate or summarize structured questions/);
    NodeAssert.match(rendered, /if and only if.*unavailable.*native.*request_user_input/);
    NodeAssert.match(rendered, /CONTEXT\.md Format/);
    NodeAssert.match(rendered, /CONTEXT-MAP\.md/);
    NodeAssert.match(rendered, /ADR Format/);
    NodeAssert.match(rendered, /Hard to reverse/);
    NodeAssert.match(rendered, /workflow_doc_get/);
    NodeAssert.doesNotMatch(rendered, /_Avoid_: Purchase, transaction/);

    const contextDoc = planningGrill.associatedDocs?.find((doc) => doc.id === "context-format");
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

    const adrDoc = planningGrill.associatedDocs?.find((doc) => doc.id === "adr-format");
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

  it("renders an automatic Engineering Grill for Full Feature", () => {
    const automaticGrill = listWorkflowPromptContracts().find(
      (contract) => contract.id === WORKFLOW_PROMPT_IDS.planningAutomaticEngineeringGrillCodex,
    );

    NodeAssert.ok(automaticGrill);
    NodeAssert.equal(automaticGrill.workflow, "planning");
    NodeAssert.equal(automaticGrill.stage, "grill");
    NodeAssert.equal(automaticGrill.title, "Engineering Grill (Automatic)");

    const rendered = resolveWorkflowPromptText(
      WORKFLOW_PROMPT_IDS.planningAutomaticEngineeringGrillCodex,
    );
    NodeAssert.match(rendered, /# Engineering Grill \(Automatic\)/);
    NodeAssert.ok(rendered.includes(GRILLING_BLUEPRINT));
    NodeAssert.match(rendered, /Challenge against the glossary/);
    NodeAssert.match(rendered, /Only offer to create an ADR when all three are true/);
    NodeAssert.match(rendered, /Product Grill is the Full Feature workflow's only user gate/);
    NodeAssert.match(rendered, /Do not ask the user questions, emit interview rounds/);
    NodeAssert.match(rendered, /choose the recommended answer for every engineering decision/);
    NodeAssert.match(rendered, /recompute the frontier until it is empty/);
    NodeAssert.match(rendered, /overrides the Grilling blueprint's user-question/);
    NodeAssert.doesNotMatch(rendered, /## T3 structured-question adapter/);
    NodeAssert.doesNotMatch(rendered, /request_user_input/);
    NodeAssert.match(rendered, /"type": "planning-grill-complete"/);
    NodeAssert.doesNotMatch(rendered, /After the user explicitly confirms shared understanding/);
    NodeAssert.ok(automaticGrill.associatedDocs?.some((doc) => doc.id === "context-format"));
    NodeAssert.ok(automaticGrill.associatedDocs?.some((doc) => doc.id === "adr-format"));
  });

  it("scopes the Preview Browser QA doc to Browser App Review", () => {
    const contracts = listWorkflowPromptContracts();
    const browserReview = contracts.find(
      (contract) => contract.id === WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
    );

    NodeAssert.ok(browserReview);
    NodeAssert.equal(browserReview.workflow, "app-review");
    NodeAssert.equal(browserReview.role, "app-review-reviewer");
    const previewQaDoc = browserReview.associatedDocs?.find(
      (doc) => doc.id === "preview-browser-qa",
    );
    NodeAssert.ok(previewQaDoc);
    NodeAssert.equal(previewQaDoc.path, "preview-browser-qa.md");
    NodeAssert.match(previewQaDoc.content, /preview_open/);
    NodeAssert.match(previewQaDoc.content, /preview_navigate/);
    NodeAssert.match(previewQaDoc.content, /preview_snapshot/);
    NodeAssert.match(previewQaDoc.content, /preview_resize/);
    NodeAssert.match(previewQaDoc.content, /preview_evaluate/);
    NodeAssert.match(previewQaDoc.content, /app_review_recording_start/);
    NodeAssert.match(previewQaDoc.content, /app_review_capture_screenshot/);
    NodeAssert.match(previewQaDoc.content, /Do not erase evidenced defects/);
    NodeAssert.match(previewQaDoc.content, /go stale/i);
    NodeAssert.doesNotMatch(previewQaDoc.content, /agent-browser/i);
    NodeAssert.doesNotMatch(previewQaDoc.content, /rrweb/i);
    NodeAssert.doesNotMatch(previewQaDoc.content, /chrome-devtools-mcp/);
    NodeAssert.ok(browserReview.associatedDocs?.some((doc) => doc.id === "app-dev-stack"));

    for (const contract of contracts.filter((entry) => entry.id !== browserReview.id)) {
      NodeAssert.equal(
        Boolean(contract.associatedDocs?.some((doc) => doc.id === "preview-browser-qa")),
        false,
      );
    }
  });

  it("scopes system instructions to the selected workflow skill", () => {
    const rendered =
      resolveWorkflowSystemInstructions({
        workflowPromptId: WORKFLOW_PROMPT_IDS.planningSpecCodex,
      }) ?? "";

    NodeAssert.doesNotMatch(rendered, /T3 Workflow Sub-Agent System/);
    NodeAssert.doesNotMatch(rendered, /workflow-agent-message/);
    NodeAssert.match(rendered, /Planning Workflow: Spec/);
    NodeAssert.equal(
      resolveWorkflowSystemInstructions({
        workflowPromptId: WORKFLOW_PROMPT_IDS.workflowAgentCommunications,
      }),
      undefined,
    );
  });

  it("renders Browser App Review around the preview_* and app_review_* MCP tools", () => {
    const rendered = resolveWorkflowPromptText(
      WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex,
    );

    NodeAssert.match(rendered, /<available-workflow-docs>/);
    NodeAssert.match(rendered, /preview-browser-qa\.md/);
    NodeAssert.match(rendered, /app-dev-stack\.md/);
    NodeAssert.match(rendered, /preview_open/);
    NodeAssert.match(rendered, /app_review_get/);
    NodeAssert.match(rendered, /preview_navigate/);
    NodeAssert.match(rendered, /app_review_recording_start/);
    NodeAssert.match(rendered, /app_review_recording_stop/);
    NodeAssert.match(rendered, /app_review_capture_screenshot/);
    NodeAssert.match(rendered, /Do not turn evidenced product defects into blocked/);
    NodeAssert.doesNotMatch(rendered, /agent-browser/i);
    NodeAssert.doesNotMatch(rendered, /rrweb/i);
    NodeAssert.doesNotMatch(rendered, /Chrome DevTools MCP/);
    NodeAssert.doesNotMatch(rendered, /chrome-devtools-mcp/);
    NodeAssert.ok(
      isPreviewMcpWorkflowPromptId(WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex),
    );
    NodeAssert.ok(
      isAppReviewMcpWorkflowPromptId(WORKFLOW_PROMPT_IDS.implementationBrowserAppReviewCodex),
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
      "app-dev-stack.md,mocking.md,tests.md,logging.md",
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
    NodeAssert.match(rendered, /workflow_doc_get/);
    NodeAssert.match(rendered, /Orchestrated QA Repair Result/);
    NodeAssert.match(rendered, /Load `app-dev-stack\.md`/);
    NodeAssert.match(rendered, /implementation-fix-result/);
    NodeAssert.match(rendered, /one focused failing test before implementation/);
    NodeAssert.match(rendered, /After each behavioral slice, run the relevant focused test/);
    NodeAssert.match(rendered, /affected-file formatting, linting, typing/);
    NodeAssert.match(rendered, /sub-minute fast check/);
    NodeAssert.match(rendered, /final gate after Code Review owns complete validation/);
    NodeAssert.doesNotMatch(rendered, /canonical log line/);

    const mockingDoc = tdd.associatedDocs?.find((doc) => doc.id === "tdd-mocking");
    NodeAssert.ok(mockingDoc);
    NodeAssert.equal(mockingDoc.path, "mocking.md");
    NodeAssert.match(mockingDoc.content, /Mock at \*\*system boundaries\*\* only/);
    NodeAssert.match(mockingDoc.content, /External APIs \(payment, email, etc\.\)/);
    NodeAssert.match(mockingDoc.content, /Don't mock:/);
    NodeAssert.match(mockingDoc.content, /Your own classes\/modules/);
    NodeAssert.match(mockingDoc.content, /Use dependency injection/);
    NodeAssert.match(mockingDoc.content, /Prefer SDK-style interfaces over generic fetchers/);
    NodeAssert.match(mockingDoc.content, /No conditional logic in test setup/);

    const testsDoc = tdd.associatedDocs?.find((doc) => doc.id === "tdd-tests");
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

    const loggingDoc = tdd.associatedDocs?.find((doc) => doc.id === "tdd-logging");
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
    // The T3 adapter overrides upstream tracker publication with the durable artifact.
    NodeAssert.match(rendered, /## T3 workflow adapter/);
    NodeAssert.match(rendered, /durable artifact in T3's application state/);
    NodeAssert.match(rendered, /planning-spec-artifact/);
    NodeAssert.match(rendered, /workflow_wayfinder_map_get/);
    NodeAssert.match(rendered, /Engineering Grill is Planning's only user-interactive stage/);
    NodeAssert.match(rendered, /Do not ask the user to confirm seams during Spec authoring/);
  });

  it("renders Implementation Orchestrator with the upstream implement body and run adapter", () => {
    const rendered = resolveWorkflowPromptText(
      WORKFLOW_PROMPT_IDS.implementationOrchestratorPlanningCodex,
    );

    NodeAssert.match(rendered, /# Implementation Workflow: Orchestrator Start/);
    NodeAssert.match(rendered, /name: implement/);
    NodeAssert.match(rendered, /Use \/tdd where possible, at pre-agreed seams/);
    NodeAssert.match(rendered, /use \/code-review to review the work/);
    NodeAssert.match(rendered, /## T3 workflow adapter/);
    NodeAssert.match(rendered, /worktree and branch created from the branch the user selected/);
    NodeAssert.match(rendered, /app dev stack is provisioned after integration/);
    NodeAssert.match(rendered, /app-dev-stack\.md/);
    NodeAssert.match(rendered, /worker branches from its blocker's worker branch/);
    NodeAssert.match(rendered, /global budget of ten fresh .* repair agents/);
    NodeAssert.match(rendered, /do not consume repair slots/);
    NodeAssert.match(rendered, /Code Review starts with one comprehensive review-and-fix pass/);
    NodeAssert.match(rendered, /cycles are capped at three/);
    NodeAssert.match(rendered, /fresh TDD repair thread on the already-integrated orchestrator/);
    NodeAssert.match(rendered, /start the next Browser App Review directly/);
    NodeAssert.match(rendered, /do not rerun the Merge Gate between review cycles/);
    NodeAssert.match(rendered, /never run launch-level complete validation commands/);
    NodeAssert.match(rendered, /sub-minute fast checks/);
    NodeAssert.match(rendered, /final gate runs each launch validation command once/);
    NodeAssert.match(rendered, /after Code Review/);
  });

  it("renders Planning Tickets with to-tickets vertical-slice drafting instructions", () => {
    const rendered = resolveWorkflowPromptText(WORKFLOW_PROMPT_IDS.planningTicketsCodex);

    NodeAssert.match(rendered, /# To Tickets/);
    NodeAssert.match(rendered, /tracer bullet/);
    NodeAssert.match(rendered, /fetch it and read its full body and comments/);
    NodeAssert.match(rendered, /narrow but COMPLETE path through every layer/);
    NodeAssert.match(rendered, /<vertical-slice-rules>/);
    NodeAssert.match(rendered, /Wide refactors are the exception to vertical slicing/);
    NodeAssert.match(rendered, /expand–contract/);
    NodeAssert.match(rendered, /Does the granularity feel right/);
    NodeAssert.match(rendered, /<local-ticket-template>/);
    NodeAssert.match(rendered, /<issue-template>/);
    NodeAssert.match(rendered, /Store tickets through the planning-tickets-artifact/);
    NodeAssert.match(rendered, /actual compile-time, data, or behavioral prerequisites/);
    NodeAssert.match(rendered, /dependency frontier as wide as correctness allows/);
    NodeAssert.match(rendered, /extension-point\/foundation ticket/);
    NodeAssert.match(rendered, /parallel feature-module tickets with isolated tests/);
    NodeAssert.match(rendered, /one small final assembly ticket/);
    NodeAssert.match(rendered, /justify every edge/);
    NodeAssert.match(
      rendered,
      /The separate automatic Ticket Review stage owns completeness review/,
    );
    NodeAssert.match(rendered, /Do not quiz or ask the user/);
  });

  it("renders Planning Ticket Review with automatic completeness and vertical-slice approval", () => {
    const rendered = resolveWorkflowPromptText(WORKFLOW_PROMPT_IDS.planningTicketReviewerCodex);

    NodeAssert.match(rendered, /Review the Spec, conversation context, durable project context/);
    NodeAssert.match(rendered, /whether the ticket set is complete/);
    NodeAssert.match(rendered, /vertical slices are correct tracer bullets/);
    NodeAssert.match(rendered, /cover the Spec's user stories/);
    NodeAssert.match(rendered, /not a horizontal layer-only task/);
    NodeAssert.match(rendered, /dependency frontier and planned-file overlap/);
    NodeAssert.match(rendered, /Remove serial edges/);
    NodeAssert.match(rendered, /central registry or service seam/);
    NodeAssert.match(rendered, /Reject any remaining long serial chain/);
    NodeAssert.match(rendered, /call `workflow_tickets_list`/);
    NodeAssert.match(rendered, /retrieve every ticket with `workflow_ticket_get`/);
    NodeAssert.match(rendered, /review only the failed, reworked, or replacement tickets/);
    NodeAssert.match(rendered, /A clean targeted pass completes ticket review/);
    NodeAssert.match(
      rendered,
      /Do not quiz the user while the ticket set still needs review corrections/,
    );
    NodeAssert.match(rendered, /## Automatic approval/);
    NodeAssert.match(rendered, /Do not quiz or ask the user/);
    NodeAssert.match(rendered, /A clean reviewer verdict automatically finalizes/);
    NodeAssert.doesNotMatch(rendered, /## User quiz/);
    NodeAssert.doesNotMatch(rendered, /Iterate until the user approves/);
    // The reviewer edits tickets directly through the verdict's ticketEdits array.
    NodeAssert.match(rendered, /Apply corrections directly/);
    NodeAssert.match(rendered, /`ticketEdits` array of your planning-reviewer-verdict/);
    NodeAssert.match(rendered, /`replacesPlanningTicketIds` when splitting or replacing/);
    NodeAssert.match(rendered, /at most three cycles/);
    NodeAssert.match(rendered, /each cycle runs in its own reviewer sub-thread/);
    // Publication happened at drafting time; approval finalizes the durable set.
    NodeAssert.match(rendered, /already stored through planning-tickets-artifact/);
    NodeAssert.match(rendered, /no separate publication step, external tracker, or triage label/);
    NodeAssert.doesNotMatch(rendered, /Publish tickets in dependency order/);
    NodeAssert.doesNotMatch(rendered, /<ticket-template>/);
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
    NodeAssert.match(rendered, /launch message defines the complete review scope/);
    NodeAssert.match(rendered, /do not reopen unchanged code/);
    NodeAssert.match(rendered, /"commitSha"/);
    NodeAssert.match(rendered, /"validations"/);
    NodeAssert.match(rendered, /do not use it to hand unfixed findings back/);
  });

  it("registers only the authoritative preset Product grills", () => {
    const contracts = listWorkflowPromptContracts();
    NodeAssert.deepEqual(
      contracts
        .filter((contract) => contract.workflow === "product")
        .map((contract) => contract.id),
      [
        WORKFLOW_PROMPT_IDS.productFixCodex,
        WORKFLOW_PROMPT_IDS.productFastFeatureCodex,
        WORKFLOW_PROMPT_IDS.productFullFeatureCodex,
      ],
    );
    for (const [id, intentKind] of [
      [WORKFLOW_PROMPT_IDS.productFixCodex, "fix"],
      [WORKFLOW_PROMPT_IDS.productFastFeatureCodex, "feature"],
      [WORKFLOW_PROMPT_IDS.productFullFeatureCodex, "feature"],
    ] as const) {
      const preset = contracts.find((contract) => contract.id === id);
      NodeAssert.ok(preset);
      NodeAssert.ok(preset.promptText.includes(GRILLING_BLUEPRINT));
      NodeAssert.match(preset.promptText, /# Product Grill/);
      NodeAssert.doesNotMatch(preset.promptText, /Fix-or-feature classification \(hard gate\)/);
      NodeAssert.match(preset.promptText, /ground yourself in the codebase/);
      NodeAssert.match(preset.promptText, /resolve facts and answer anything already clear/);
      NodeAssert.match(
        preset.promptText,
        /only where product clarity, preference, or alignment is needed/,
      );
      NodeAssert.match(preset.promptText, /selected product workflow is authoritative/);
      NodeAssert.match(preset.promptText, /Do not perform that work during Product Grill/);
      NodeAssert.match(preset.promptText, /never silently treat apparent clarity as confirmation/);
      NodeAssert.match(preset.promptText, /Treat every answer .* as settled/);
      NodeAssert.match(preset.promptText, /Never repeat its question/);
      NodeAssert.match(preset.promptText, /Interview the user relentlessly/);
      NodeAssert.match(preset.promptText, /Ask the whole frontier in one round/);
      NodeAssert.match(preset.promptText, /❓ \*\*Q1\*\* - \*\*<question title>\*\*/);
      NodeAssert.match(preset.promptText, /➡️ <your recommended answer>/);
      NodeAssert.match(preset.promptText, /dispatch a sub-agent to find it/);
      NodeAssert.match(preset.promptText, /frontier is empty/);
      NodeAssert.doesNotMatch(preset.promptText, /one question at a time/);
      NodeAssert.match(preset.promptText, /Cover product direction only/);
      NodeAssert.match(preset.promptText, /product-scope adaptation to the Grilling blueprint/);
      NodeAssert.match(preset.promptText, /dependency-frontier mechanics remain authoritative/);
      NodeAssert.match(preset.promptText, /## T3 structured-question adapter/);
      NodeAssert.match(preset.promptText, /workflow_request_user_input.*every interview round/);
      NodeAssert.match(preset.promptText, /complete result.*outer text\(result\) helper/);
      NodeAssert.match(preset.promptText, /contentItems, not result\.content/);
      NodeAssert.match(preset.promptText, /one through seven questions.*entire frontier/);
      NodeAssert.match(preset.promptText, /Seven is a maximum, never a target/);
      NodeAssert.match(preset.promptText, /first seven in stable design-tree order/);
      NodeAssert.match(preset.promptText, /natural A\/B\/C order/);
      NodeAssert.match(preset.promptText, /Exactly one separate recommendation object/);
      NodeAssert.match(preset.promptText, /neutral, useful impact or tradeoff description/);
      NodeAssert.match(preset.promptText, /Do not append.*\(Recommended\)/);
      NodeAssert.match(preset.promptText, /do not replace or prefix.*Why that\?/);
      NodeAssert.match(
        preset.promptText,
        /one.*workflow_request_user_input.*final shared-understanding/,
      );
      NodeAssert.match(preset.promptText, /Keep grilling/);
      NodeAssert.match(preset.promptText, /Do not duplicate or summarize structured questions/);
      NodeAssert.match(
        preset.promptText,
        /if and only if.*unavailable.*native.*request_user_input/,
      );
      NodeAssert.match(preset.promptText, /Do not ask about implementation, architecture, testing/);
      NodeAssert.match(preset.promptText, /until the user confirms/);
      NodeAssert.match(preset.promptText, new RegExp(`intentKind.*"${intentKind}"`));
      NodeAssert.match(preset.promptText, /"type": "product-intent-locked"/);
      NodeAssert.equal(preset.associatedDocs, undefined);
      NodeAssert.equal(
        resolveWorkflowPromptId({
          interactionMode: "product-workflow",
          workflowPromptId: id,
        }),
        id,
      );
      for (const downstreamOverview of [
        /single human gate/i,
        /CLI Plan/i,
        /Build child/i,
        /worktree/i,
        /app dev stack/i,
        /App Review/i,
        /Code Review/i,
        /Planning workflow/i,
        /Implementation workflow/i,
        /change request/i,
      ]) {
        NodeAssert.doesNotMatch(preset.promptText, downstreamOverview);
      }
    }
    const planningSpec = contracts.find(
      (contract) => contract.id === WORKFLOW_PROMPT_IDS.planningSpecCodex,
    );
    NodeAssert.ok(planningSpec);
    const specContextDoc = planningSpec.associatedDocs?.find((doc) => doc.id === "context-format");
    NodeAssert.ok(specContextDoc);
    NodeAssert.equal(specContextDoc.path, "CONTEXT-FORMAT.md");
    NodeAssert.match(specContextDoc.content, /# CONTEXT\.md Format/);

    const specAdrDoc = planningSpec.associatedDocs?.find((doc) => doc.id === "adr-format");
    NodeAssert.ok(specAdrDoc);
    NodeAssert.equal(specAdrDoc.path, "ADR-FORMAT.md");
    NodeAssert.match(specAdrDoc.content, /# ADR Format/);

    const renderedSpec = resolveWorkflowPromptText(WORKFLOW_PROMPT_IDS.planningSpecCodex);
    NodeAssert.match(renderedSpec, /Domain model maintenance/);
    NodeAssert.match(renderedSpec, /Do not ask the user to confirm seams during Spec authoring/);

    NodeAssert.equal(resolveWorkflowPromptId({ interactionMode: "product-workflow" }), undefined);
    NodeAssert.equal(isRegisteredWorkflowPromptId("product.workflow.codex"), false);
    NodeAssert.equal(isRegisteredWorkflowPromptId("yolo.grill-stage.codex"), false);
    NodeAssert.equal(isRegisteredWorkflowPromptId("implementation.qna-app-review.codex"), false);
    NodeAssert.equal(
      contracts.some((contract) => contract.id === "implementation.qna-app-review.codex"),
      false,
    );
    NodeAssert.equal(
      contracts.some((contract) => (contract.workflow as string) === "yolo"),
      false,
    );
  });
});
