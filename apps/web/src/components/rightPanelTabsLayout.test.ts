import { describe, expect, it } from "vite-plus/test";

import {
  RIGHT_PANEL_EMPTY_STATE_CLASS_NAME,
  rightPanelTabIconClassNames,
} from "./rightPanelTabsLayout";

describe("right panel tab layout", () => {
  it("lets the surface chooser scroll within a short viewport", () => {
    expect(RIGHT_PANEL_EMPTY_STATE_CLASS_NAME).toContain("min-h-0");
    expect(RIGHT_PANEL_EMPTY_STATE_CLASS_NAME).toContain("overflow-y-auto");
    expect(RIGHT_PANEL_EMPTY_STATE_CLASS_NAME).toContain("overscroll-contain");
  });

  it("keeps close icons visible in sheet mode", () => {
    const classNames = rightPanelTabIconClassNames("sheet");

    expect(classNames.surfaceIcon).toContain("hidden");
    expect(classNames.closeIcon).toContain("block");
    expect(classNames.closeIcon).not.toContain("group-hover");
  });

  it("keeps close icons hover-revealed in inline mode", () => {
    const classNames = rightPanelTabIconClassNames("inline");

    expect(classNames.surfaceIcon).toContain("group-hover/tab:hidden");
    expect(classNames.closeIcon).toContain("group-hover/tab:block");
  });
});
