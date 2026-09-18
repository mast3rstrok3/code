import { describe, expect, it } from "vite-plus/test";
import type {
  FinalRegressionState,
  OrchestrationImplementationValidationResult,
} from "@t3tools/contracts";
import {
  invalidateRegressionChecks,
  recordRegressionCycle,
  regressionCommands,
  regressionPassed,
} from "./finalRegression.ts";

const at = "2026-09-18T00:00:00.000Z";
const result = (
  command: string,
  status: "passed" | "failed",
  retryCommand?: string,
): OrchestrationImplementationValidationResult => ({
  command,
  status,
  completedAt: at,
  outputMarkdown: "runner output",
  ...(retryCommand ? { retryCommand } : {}),
});
const initial = (): FinalRegressionState => ({
  checks: ["check", "e2e"].map((command) => ({ command, result: null })),
  cycles: [],
  reviewBaseSha: null,
});
const record = (
  state: FinalRegressionState,
  validations: OrchestrationImplementationValidationResult[],
) => recordRegressionCycle({ state, validations, headSha: "head", completedAt: at });

describe("final regression selections", () => {
  it("runs the full gate once, then only the failed tests and retains actual command evidence", () => {
    const first = record(initial(), [
      result("check", "passed"),
      result("e2e", "failed", "e2e failing.spec"),
    ]);
    expect(regressionCommands(first)).toEqual(["e2e failing.spec"]);
    const second = record(first, [result("e2e failing.spec", "passed")]);
    expect(regressionPassed(second, ["check", "e2e"])).toBe(true);
    expect(second.checks[0]?.result).toEqual(first.checks[0]?.result);
    expect(second.checks[1]?.result?.command).toBe("e2e failing.spec");
    expect(second.cycles).toHaveLength(2);
    expect(second.cycles[0]?.validations[1]?.status).toBe("failed");
  });
  it("narrows a failed selection again when the runner reports remaining failures", () => {
    const first = record(initial(), [
      result("check", "passed"),
      result("e2e", "failed", "e2e a b"),
    ]);
    const second = record(first, [result("e2e a b", "failed", "e2e b")]);
    expect(regressionCommands(second)).toEqual(["e2e b"]);
    expect(regressionPassed(second, ["check", "e2e"])).toBe(false);
  });
  it("reruns the failed command when failed-test selection is unavailable", () => {
    const failed = record(initial(), [result("check", "passed"), result("e2e", "failed")]);
    expect(regressionCommands(failed)).toEqual(["e2e"]);
  });
  it.each([
    [result("unrelated", "passed")],
    [result("check", "passed"), result("e2e", "passed"), result("e2e", "failed")],
    [result("check", "passed"), result("e2e", "passed"), result("other", "failed")],
  ])("rejects incomplete, conflicting, or unresolved evidence", (...validations) => {
    expect(regressionPassed(record(initial(), validations), ["check", "e2e"])).toBe(false);
  });
  it("invalidates affected checks and retains only explicitly reviewed evidence", () => {
    const first = record(initial(), [result("check", "passed"), result("e2e", "failed", "e2e a")]);
    expect(
      regressionCommands(
        invalidateRegressionChecks(first, [], "Only a changed; check and other cases unaffected."),
      ),
    ).toEqual(["e2e a"]);
    expect(
      regressionCommands(invalidateRegressionChecks(first, ["check"], "Build changed.")),
    ).toEqual(["check", "e2e a"]);
    expect(
      regressionCommands(invalidateRegressionChecks(first, ["e2e"], "Shared fixtures changed.")),
    ).toEqual(["e2e"]);
    expect(regressionCommands(invalidateRegressionChecks(first, undefined, undefined))).toEqual([
      "check",
      "e2e",
    ]);
    expect(
      regressionCommands(invalidateRegressionChecks(first, ["typo"], "Invalid selection.")),
    ).toEqual(["check", "e2e"]);
  });
  it("does not publish when a newly required command lacks evidence", () => {
    const passed = record(initial(), [result("check", "passed"), result("e2e", "passed")]);
    expect(regressionPassed(passed, ["check", "e2e", "mobile"])).toBe(false);
  });
});
