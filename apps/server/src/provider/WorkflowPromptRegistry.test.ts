import * as NodeAssert from "node:assert/strict";

import { describe, it } from "vite-plus/test";

import {
  isDevReviewMcpWorkflowPromptId,
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
      ["fix", "fast-feature", "full-feature", "wayfinder", "planning", "implementation"],
    );
    NodeAssert.equal(catalog.docs.filter((doc) => doc.id === "context-format").length, 1);
    NodeAssert.deepEqual(resolveWorkflowDoc("context-format")?.skillIds, [
      WORKFLOW_PROMPT_IDS.planningGrillStageCodex,
      WORKFLOW_PROMPT_IDS.planningAutomaticEngineeringGrillCodex,
      WORKFLOW_PROMPT_IDS.planningSpecCodex,
    ]);
    NodeAssert.equal(resolveWorkflowDoc("missing"), undefined);
    const wayfinder = catalog.skills.find(
      (skill) => skill.id === WORKFLOW_PROMPT_IDS.planningWayfinderCodex,
    );
    NodeAssert.deepEqual(wayfinder?.workflowIds, ["wayfinder"]);
    NodeAssert.match(wayfinder?.promptText ?? "", /wayfinder-map-artifact/);
    NodeAssert.match(wayfinder?.promptText ?? "", /## Fog of war/);
    NodeAssert.match(wayfinder?.promptText ?? "", /never resolve more than one ticket per session/);
    NodeAssert.ok((wayfinder?.promptText.length ?? 0) > 12_000);
    const grillWithDocs = catalog.skills.find(
      (skill) => skill.id === WORKFLOW_PROMPT_IDS.planningGrillStageCodex,
    );
    NodeAssert.equal(grillWithDocs?.title, "1. Engineering Grill");
    NodeAssert.match(grillWithDocs?.promptText ?? "", /Challenge against the glossary/);
    NodeAssert.match(grillWithDocs?.promptText ?? "", /Offer ADRs sparingly/);
    NodeAssert.match(grillWithDocs?.promptText ?? "", /Most repos have a single context/);
    NodeAssert.deepEqual(grillWithDocs?.workflowIds, ["wayfinder", "planning"]);
    const automaticGrill = catalog.skills.find(
      (skill) => skill.id === WORKFLOW_PROMPT_IDS.planningAutomaticEngineeringGrillCodex,
    );
    NodeAssert.equal(automaticGrill?.title, "Engineering Grill (Automatic)");
    NodeAssert.deepEqual(automaticGrill?.workflowIds, ["full-feature"]);
    NodeAssert.equal(
      catalog.skills.some((skill) => skill.id === WORKFLOW_PROMPT_IDS.planningDomainModelingCodex),
      false,
    );
    // The standalone Domain Modeling prompt carries the upstream skill verbatim.
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
    const prototype = catalog.skills.find(
      (skill) => skill.id === WORKFLOW_PROMPT_IDS.planningPrototypeCodex,
    );
    NodeAssert.match(
      prototype?.promptText ?? "",
      /The two branches produce very different artifacts/,
    );
    NodeAssert.match(prototype?.promptText ?? "", /Capture it when done/);
    // Prototypes are full-fidelity: real-app worktree + app dev stack, no toy stand-ins.
    NodeAssert.match(prototype?.promptText ?? "", /## Full fidelity on the real application/);
    NodeAssert.match(prototype?.promptText ?? "", /app dev stack/);
    NodeAssert.doesNotMatch(prototype?.promptText ?? "", /tiny interactive terminal app/);
    const prototypeLogic = resolveWorkflowDoc("prototype-logic");
    NodeAssert.match(prototypeLogic?.content ?? "", /Isolate the logic in a portable module/);
    NodeAssert.match(prototypeLogic?.content ?? "", /Wire it into the real application/);
    NodeAssert.match(prototypeLogic?.content ?? "", /Don't downgrade to a toy/);
    const prototypeUi = resolveWorkflowDoc("prototype-ui");
    NodeAssert.match(prototypeUi?.content ?? "", /Two sub-shapes — strongly prefer sub-shape A/);
    NodeAssert.match(prototypeUi?.content ?? "", /Build the floating switcher/);
    NodeAssert.ok((prototypeLogic?.content.length ?? 0) > 5_500);
    NodeAssert.ok((prototypeUi?.content.length ?? 0) > 6_800);
    const research = catalog.skills.find(
      (skill) => skill.id === WORKFLOW_PROMPT_IDS.planningResearchCodex,
    );
    NodeAssert.match(research?.promptText ?? "", /Spin up a \*\*background agent\*\*/);
    NodeAssert.match(research?.promptText ?? "", /primary sources/);
    NodeAssert.match(research?.promptText ?? "", /workflow-subagent-result/);
    NodeAssert.ok((resolveWorkflowDoc("context-format")?.content.length ?? 0) > 2_200);
    NodeAssert.ok((resolveWorkflowDoc("adr-format")?.content.length ?? 0) > 2_700);
    NodeAssert.deepEqual(resolveWorkflowDoc("domain-docs")?.skillIds, [
      WORKFLOW_PROMPT_IDS.planningSpecCodex,
      WORKFLOW_PROMPT_IDS.planningTicketsCodex,
    ]);
    NodeAssert.match(resolveWorkflowDoc("domain-docs")?.content ?? "", /proceed silently/);
    NodeAssert.deepEqual(resolveWorkflowDoc("agent-brief")?.skillIds, [
      WORKFLOW_PROMPT_IDS.planningTicketsCodex,
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
    NodeAssert.match(rendered, /request_user_input.*every interview round/);
    NodeAssert.match(rendered, /at most three currently unblocked frontier questions/);
    NodeAssert.match(rendered, /natural A\/B\/C order/);
    NodeAssert.match(rendered, /Exactly one recommended choice/);
    NodeAssert.match(rendered, /Never omit the recommendation from any question/);
    NodeAssert.match(rendered, /\(Recommended\).*exactly once/);
    NodeAssert.match(rendered, /Why that\? /);
    NodeAssert.match(rendered, /impact or tradeoff text in every choice's description/);
    NodeAssert.match(rendered, /Lock it in \(Recommended\)/);
    NodeAssert.match(rendered, /Keep grilling/);
    NodeAssert.match(rendered, /overrides the Grilling blueprint's Markdown question format/);
    NodeAssert.match(rendered, /Do not duplicate or summarize the questions/);
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

  it("scopes the Preview Browser QA doc to Browser Dev Review", () => {
    const contracts = listWorkflowPromptContracts();
    const browserReview = contracts.find(
      (contract) => contract.id === WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
    );

    NodeAssert.ok(browserReview);
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
    NodeAssert.match(previewQaDoc.content, /dev_review_recording_start/);
    NodeAssert.match(previewQaDoc.content, /dev_review_capture_screenshot/);
    NodeAssert.match(previewQaDoc.content, /go stale/i);
    NodeAssert.doesNotMatch(previewQaDoc.content, /agent-browser/i);
    NodeAssert.doesNotMatch(previewQaDoc.content, /rrweb/i);
    NodeAssert.doesNotMatch(previewQaDoc.content, /chrome-devtools-mcp/);

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

  it("renders Browser Dev Review around the preview_* and dev_review_* MCP tools", () => {
    const rendered = resolveWorkflowPromptText(
      WORKFLOW_PROMPT_IDS.implementationBrowserDevReviewCodex,
    );

    NodeAssert.match(rendered, /<available-workflow-docs>/);
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
    NodeAssert.match(rendered, /workflow_doc_get/);
    NodeAssert.match(rendered, /Orchestrated QA Repair Result/);
    NodeAssert.match(rendered, /implementation-fix-result/);
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
    NodeAssert.match(rendered, /app dev stack/);
    NodeAssert.match(rendered, /worker branches from its blocker's worker branch/);
    NodeAssert.match(rendered, /up to ten QA cycles/);
    NodeAssert.match(rendered, /fresh TDD repair thread/);
    NodeAssert.match(rendered, /single review-and-fix pass/);
    NodeAssert.match(rendered, /never run repo-wide suites/);
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
    NodeAssert.match(rendered, /single review-and-fix pass/);
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
      NodeAssert.match(preset.promptText, /request_user_input.*every interview round/);
      NodeAssert.match(preset.promptText, /at most three currently unblocked frontier questions/);
      NodeAssert.match(preset.promptText, /preserve their stable design-tree order/);
      NodeAssert.match(preset.promptText, /natural A\/B\/C order/);
      NodeAssert.match(preset.promptText, /Exactly one recommended choice/);
      NodeAssert.match(preset.promptText, /Never omit the recommendation from any question/);
      NodeAssert.match(preset.promptText, /\(Recommended\).*exactly once/);
      NodeAssert.match(preset.promptText, /Why that\? /);
      NodeAssert.match(preset.promptText, /impact or tradeoff text in every choice's description/);
      NodeAssert.match(preset.promptText, /Lock it in \(Recommended\)/);
      NodeAssert.match(preset.promptText, /Keep grilling/);
      NodeAssert.match(
        preset.promptText,
        /overrides the Grilling blueprint's Markdown question format/,
      );
      NodeAssert.match(preset.promptText, /Do not duplicate or summarize the questions/);
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
        /Dev Review/i,
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
