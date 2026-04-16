import { describe, expect, it } from "vitest";

import { buildGhosttyThemeConfig, getGitHubTerminalTheme } from "./terminalTheme";

describe("getGitHubTerminalTheme", () => {
  it("returns the GitHub light terminal palette", () => {
    expect(getGitHubTerminalTheme("light")).toMatchObject({
      background: "#ffffff",
      foreground: "#586069",
      cursorForeground: "#005cc5",
      cursorBackground: "#d1d5da",
    });
  });

  it("returns the GitHub dark terminal palette", () => {
    expect(getGitHubTerminalTheme("dark")).toMatchObject({
      background: "#24292e",
      foreground: "#d1d5da",
      cursorForeground: "#79b8ff",
      cursorBackground: "#586069",
    });
  });
});

describe("buildGhosttyThemeConfig", () => {
  it("serializes theme colors into a ghostty config file", () => {
    const config = buildGhosttyThemeConfig(getGitHubTerminalTheme("dark"));

    expect(config).toContain("background = #24292e");
    expect(config).toContain("foreground = #d1d5da");
    expect(config).toContain("cursor-color = #79b8ff");
    expect(config).toContain("palette = 0=#586069");
    expect(config).toContain("palette = 15=#fafbfc");
    expect(config.endsWith("\n")).toBe(true);
  });
});
