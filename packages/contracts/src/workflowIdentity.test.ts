import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { WorkflowPreset } from "./workflowIdentity.ts";

const decodePreset = Schema.decodeUnknownSync(WorkflowPreset);
const encodePreset = Schema.encodeSync(WorkflowPreset);
const isPreset = Schema.is(WorkflowPreset);

describe("WorkflowPreset", () => {
  it("decodes retired Quick presets to their successors and never encodes them", () => {
    expect(decodePreset("quick-plan")).toBe("fast-plan");
    expect(decodePreset("fast-engineering")).toBe("planning");
    expect(decodePreset("fast-plan")).toBe("fast-plan");
    expect(encodePreset("fast-plan")).toBe("fast-plan");
    expect(encodePreset("planning")).toBe("planning");
    expect(isPreset("quick-plan")).toBe(false);
  });
});
