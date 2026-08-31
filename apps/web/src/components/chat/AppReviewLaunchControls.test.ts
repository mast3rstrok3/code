import { describe, expect, it } from "vite-plus/test";

import { appReviewLaunchSummary, appReviewTargetLabel } from "./AppReviewLaunchControls";

describe("appReviewTargetLabel", () => {
  it("names the host a launch will drive", () => {
    expect(appReviewTargetLabel("localhost:5173")).toBe("localhost:5173");
    expect(appReviewTargetLabel("https://staging.example.test/app")).toBe("staging.example.test");
  });

  it("falls back to the worktree's App Stack without a usable URL", () => {
    expect(appReviewTargetLabel("")).toBe("App Stack");
    expect(appReviewTargetLabel("not a url")).toBe("App Stack");
  });
});

describe("appReviewLaunchSummary", () => {
  it("counts cycles for a run that repairs", () => {
    expect(appReviewLaunchSummary({ cycleBudget: 10, reviewUrl: "", reviewOnly: false })).toBe(
      "10 cycles · App Stack",
    );
    expect(appReviewLaunchSummary({ cycleBudget: 1, reviewUrl: "", reviewOnly: false })).toBe(
      "1 cycle · App Stack",
    );
  });

  it("drops the count when nothing will be repaired", () => {
    expect(
      appReviewLaunchSummary({ cycleBudget: 10, reviewUrl: "localhost:5173", reviewOnly: true }),
    ).toBe("Review only · localhost:5173");
  });
});
