import {
  AppReviewWorkflowFixValidation,
  OrchestrationImplementationValidationResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { currentWorkflowValidations, hasPostRepairVerification } from "./workflowValidation.ts";

const red = {
  command: "test writing.test.ts",
  purpose: "reproduction" as const,
  status: "failed" as const,
  outputMarkdown: "The regression fails before the repair.",
  completedAt: "2026-09-07T23:29:04.000Z",
};
const green = {
  command: "test writing.test.ts block-handle.test.ts",
  purpose: "verification" as const,
  status: "passed" as const,
  outputMarkdown: "All eleven tests pass after the repair.",
  completedAt: "2026-09-07T23:29:56.000Z",
};

describe("workflow validation evidence", () => {
  it("accepts broader post-fix verification while preserving the reproduction report", () => {
    const history = [red, green];
    expect(currentWorkflowValidations(history)).toEqual([green]);
    expect(hasPostRepairVerification(history)).toBe(true);
    expect(history).toEqual([red, green]);
  });

  it("requires verification after the latest reproduction", () => {
    expect(hasPostRepairVerification([red])).toBe(false);
    expect(
      hasPostRepairVerification([red, { ...green, completedAt: "2026-09-07T23:28:00.000Z" }]),
    ).toBe(false);
    expect(hasPostRepairVerification([red, { ...green, status: "failed" }])).toBe(false);
  });

  it("keeps unlabelled failures as verification regardless of the report prose", () => {
    const { purpose: _, ...legacyRed } = red;
    expect(currentWorkflowValidations([legacyRed, green])).toEqual([legacyRed, green]);
  });

  it("uses execution time, with failures winning ties, for repeated verification commands", () => {
    const failure = { ...green, status: "failed" as const, completedAt: red.completedAt };
    expect(currentWorkflowValidations([green, failure])).toEqual([green]);
    const tied = { ...failure, completedAt: green.completedAt };
    expect(currentWorkflowValidations([green, tied])).toEqual([tied]);
    expect(currentWorkflowValidations([tied, green])).toEqual([tied]);
  });

  it("round trips the purpose through both persisted validation contracts", () => {
    for (const schema of [
      AppReviewWorkflowFixValidation,
      OrchestrationImplementationValidationResult,
    ]) {
      const decode = Schema.decodeUnknownSync(schema);
      expect(decode(red)).toEqual(red);
      expect(decode(green)).toEqual(green);
      expect(() => decode({ ...red, purpose: "historical" })).toThrow();
    }
  });
});
