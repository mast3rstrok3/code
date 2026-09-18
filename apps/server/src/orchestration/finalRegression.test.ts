import { describe, expect, it } from "vite-plus/test";
import type {
  FinalRegressionState,
  OrchestrationImplementationValidationResult,
} from "@t3tools/contracts";
import {
  recoverLegacyRegression,
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
  it("keeps unaffected passes when an invalidated passing check gets a corrected command", () => {
    const first = record(initial(), [
      result("check", "passed"),
      result("e2e", "failed", "e2e failed"),
    ]);
    const state = {
      ...first,
      checks: [...first.checks, { command: "mobile", result: result("mobile", "passed") }],
    };
    const reviewed = invalidateRegressionChecks(
      state,
      ["check", "e2e"],
      "Shared browser setup changed; mobile is unaffected.",
      [
        { command: "check", retryCommand: "env -u REPORT check" },
        { command: "e2e", retryCommand: "NO_RETRY=1 e2e" },
      ],
    );
    expect(regressionCommands(reviewed)).toEqual(["env -u REPORT check", "NO_RETRY=1 e2e"]);
    expect(reviewed.checks[0]?.result).toBeNull();
    expect(reviewed.checks[2]).toBe(state.checks[2]);
    expect(reviewed.cycles).toBe(state.cycles);
    expect(regressionPassed(reviewed, ["check", "e2e", "mobile"])).toBe(false);
    const rerun = record(reviewed, [
      result("env -u REPORT check", "passed"),
      result("NO_RETRY=1 e2e", "failed", "e2e remaining"),
    ]);
    expect(regressionCommands(rerun)).toEqual(["e2e remaining"]);
    expect(rerun.checks[2]).toBe(state.checks[2]);
    expect(
      regressionPassed(record(rerun, [result("e2e remaining", "passed")]), [
        "check",
        "e2e",
        "mobile",
      ]),
    ).toBe(true);
  });

  it.each([
    [{ command: "unknown", retryCommand: "test" }],
    [
      { command: "check", retryCommand: "one" },
      { command: "check", retryCommand: "two" },
    ],
    [{ command: "check", retryCommand: " " }],
  ])("invalid retry mappings retain all required work", (...selection) => {
    const state = record(initial(), [result("check", "passed"), result("e2e", "failed")]);
    const reviewed = invalidateRegressionChecks(
      state,
      ["check"],
      "Check inputs changed.",
      selection,
    );
    expect(regressionCommands(reviewed)).toEqual(["check", "e2e"]);
    expect(regressionPassed(reviewed, ["check", "e2e"])).toBe(false);
  });

  it("recovers corrected passes and retains every unresolved legacy check", () => {
    const validations = [
      result("check", "failed"),
      {
        ...result("env check", "passed"),
        supersedesCommand: "check",
        completedAt: "2026-09-18T00:00:01.000Z",
      },
      result("e2e", "failed"),
      result("extra", "failed"),
    ];
    const recovered = recoverLegacyRegression({
      requiredCommands: ["check", "e2e", "missing"],
      validations,
      headSha: "head",
      completedAt: at,
    });
    expect(regressionCommands(recovered)).toEqual(["e2e", "missing", "extra"]);
    expect(recovered.cycles[0]?.validations).toEqual(validations);
    expect(recovered.reviewBaseSha).toBe("head");
    const selected = invalidateRegressionChecks(
      recovered,
      [],
      "Completed E2E report contains exactly this failure.",
      [{ command: "e2e", retryCommand: "e2e failure.spec" }],
    );
    expect(regressionCommands(selected)).toEqual(["e2e failure.spec", "missing", "extra"]);
    const invalidated = invalidateRegressionChecks(recovered, ["e2e"], "Shared fixtures changed.", [
      { command: "e2e", retryCommand: "e2e failure.spec" },
    ]);
    expect(regressionCommands(invalidated)).toContain("e2e failure.spec");
  });
  it("accepts explicit newer setup corrections in a test cycle", () => {
    const state = record(initial(), [
      result("check", "failed"),
      result("e2e", "passed"),
      {
        ...result("env check", "passed"),
        supersedesCommand: "check",
        completedAt: "2026-09-18T00:00:01.000Z",
      },
    ]);
    expect(regressionPassed(state, ["check", "e2e"])).toBe(true);
    expect(state.cycles[0]?.validations).toHaveLength(3);
  });
  it("does not accept a correction without the original failure evidence", () => {
    const state = record(initial(), [
      result("e2e", "passed"),
      { ...result("env check", "passed"), supersedesCommand: "check" },
    ]);
    expect(regressionPassed(state, ["check", "e2e"])).toBe(false);
  });
  it("does not publish when a newly required command lacks evidence", () => {
    const passed = record(initial(), [result("check", "passed"), result("e2e", "passed")]);
    expect(regressionPassed(passed, ["check", "e2e", "mobile"])).toBe(false);
  });
});
