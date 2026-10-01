import type { AppStackBundlePlan } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { bundledApps, setBundledApp, setServiceOmitted } from "./TicketAppStackPicker.logic";

const plan: AppStackBundlePlan = {
  app: "rudi",
  branch: "feature",
  members: ["rudi", "cortex", "medical-repository"].map((app) => ({
    app,
    repository: app,
    found: app === "rudi",
    baseBranch: "dev",
  })),
};

describe("ticket App Stack picker", () => {
  it("expands every app into a list once one is unchecked", () => {
    expect([...bundledApps({ bundle: "all" }, plan)]).toEqual(["cortex", "medical-repository"]);
    expect(setBundledApp({ bundle: "all" }, plan, "cortex", false)).toEqual({
      bundle: ["medical-repository"],
    });
  });

  it("keeps the planned order and drops the left-out services of an unbundled app", () => {
    const shape = setBundledApp(
      {
        bundle: ["medical-repository"],
        omitServices: { rudi: ["codex-runner"], "medical-repository": ["seaweedfs"] },
      },
      plan,
      "cortex",
      true,
    );
    expect(shape.bundle).toEqual(["cortex", "medical-repository"]);
    expect(setBundledApp(shape, plan, "medical-repository", false)).toEqual({
      bundle: ["cortex"],
      omitServices: { rudi: ["codex-runner"] },
    });
    expect(setBundledApp({ bundle: ["cortex"] }, plan, "cortex", false)).toEqual({});
  });

  it("leaves services out and puts them back until the shape is empty again", () => {
    const omitted = setServiceOmitted({}, "rudi", "python-sandbox", true);
    expect(setServiceOmitted(omitted, "rudi", "codex-runner", true)).toEqual({
      omitServices: { rudi: ["codex-runner", "python-sandbox"] },
    });
    expect(setServiceOmitted(omitted, "rudi", "python-sandbox", false)).toEqual({});
  });
});
