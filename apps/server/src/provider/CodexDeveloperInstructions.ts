import type { V2TurnStartParams__AdditionalContextEntry } from "effect-codex-app-server/schema";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";

import {
  T3_CODE_BROWSER_TOOL_INSTRUCTIONS,
  T3_CODE_DEVICE_TOOL_INSTRUCTIONS,
  T3_CODE_ORCHESTRATION_SECTIONS,
} from "@t3tools/provider-core/server/orchestrationInstructions";
import { BROWSER_APP_REVIEW_LAUNCH_DIRECTIVE_INSTRUCTIONS } from "./WorkflowSubagentInstructions.ts";

export const CODEX_BROWSER_QA_DEVELOPER_INSTRUCTIONS = `
## Browser App Review QA tools

This browser tooling context is scoped to the Implementation Workflow Browser App Review QA role only. It is not available in ordinary implementation, planning, Product Workflow, or default sessions.

Use the \`t3-code\` MCP server for all browser work. Drive the browser with the \`preview_*\` tools (\`preview_open\`, \`preview_navigate\`, \`preview_snapshot\`, \`preview_click\`, \`preview_type\`, \`preview_press\`, \`preview_scroll\`, \`preview_wait_for\`, \`preview_resize\`) and coordinate the durable App Review record with \`app_review_get\`, \`app_review_recording_start\`, \`app_review_capture_screenshot\`, \`app_review_recording_stop\`, and \`app_review_update\`. Do not use external browsers, browser MCP servers, or standalone Playwright scripts.

Evidence is required. A passed verdict needs a saved screen recording plus at least one captioned screenshot. A failed verdict normally uses the same evidence, but if recording finalization fails after product testing, preserve the failure when there is at least one failed check and every actionable finding references a captured screenshot. Tooling, preview, and evidence problems are failed reviews with concrete diagnostic detail, never a third verdict. See \`preview-browser-qa.md\` for the full workflow.`;

/** Codex silently truncates additionalContext values over 1,000 tokens, counted as UTF-8 bytes / 4. */
export const CODEX_ADDITIONAL_CONTEXT_VALUE_MAX_BYTES = 4_000;

export interface T3CodeToolAvailability {
  readonly browser: boolean;
  readonly device: boolean;
}

const normalizeAvailability = (
  availability: boolean | T3CodeToolAvailability,
): T3CodeToolAvailability =>
  typeof availability === "boolean" ? { browser: availability, device: false } : availability;

/** Instructions for unavailable tools would steer the model away from its remaining automation. */
const toolInstructions = (availability: boolean | T3CodeToolAvailability): string => {
  const tools = normalizeAvailability(availability);
  return [
    tools.browser ? T3_CODE_BROWSER_TOOL_INSTRUCTIONS : "",
    tools.device ? T3_CODE_DEVICE_TOOL_INSTRUCTIONS : "",
  ]
    .filter(Boolean)
    .join("\n\n");
};

export interface CodexRuntimeInfo {
  readonly model: string;
  readonly modelName?: string | undefined;
  readonly reasoningEffort?: string | undefined;
}

/** Keep this outside collaboration mode; model-catalog mode text overrides client developer_instructions. */
export function buildCodexAdditionalContext(
  runtime: CodexRuntimeInfo,
  toolsAvailable: boolean | T3CodeToolAvailability = true,
): Record<string, V2TurnStartParams__AdditionalContextEntry> {
  const tools = toolInstructions(toolsAvailable);
  // Split values to fit per-entry caps; number keys because Codex emits them in key order.
  return {
    ...Object.fromEntries(
      T3_CODE_ORCHESTRATION_SECTIONS.map((section, index) => [
        `t3_code_orchestration_${String(index + 1).padStart(2, "0")}`,
        { kind: "application" as const, value: section },
      ]),
    ),
    t3_code_runtime: {
      kind: "application",
      value: buildRuntimeInstructions({ harness: "Codex", ...runtime }),
    },
    ...(tools ? { t3_code_tools: { kind: "application", value: tools } } : {}),
    // Codex now uses its native mode prompts, so this rides with the T3 context instead of
    // developer_instructions, which model-catalog mode text would drop anyway.
    t3_code_browser_app_review_launch: {
      kind: "application",
      value: BROWSER_APP_REVIEW_LAUNCH_DIRECTIVE_INSTRUCTIONS,
    },
  };
}
