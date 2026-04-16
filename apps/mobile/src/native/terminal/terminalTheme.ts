export type TerminalAppearanceScheme = "light" | "dark";

export interface TerminalTheme {
  readonly background: string;
  readonly foreground: string;
  readonly mutedForeground: string;
  readonly border: string;
  readonly cursorForeground: string;
  readonly cursorBackground: string;
  readonly palette: readonly string[];
}

const GITHUB_LIGHT_THEME: TerminalTheme = {
  // Sourced from GitHub's official VS Code theme terminal palette.
  background: "#ffffff",
  foreground: "#586069",
  mutedForeground: "#6a737d",
  border: "rgba(27,31,35,0.12)",
  cursorForeground: "#005cc5",
  cursorBackground: "#d1d5da",
  palette: [
    "#24292e",
    "#d73a49",
    "#28a745",
    "#dbab09",
    "#0366d6",
    "#5a32a3",
    "#1b7c83",
    "#6a737d",
    "#959da5",
    "#cb2431",
    "#22863a",
    "#b08800",
    "#005cc5",
    "#5a32a3",
    "#3192aa",
    "#d1d5da",
  ],
};

const GITHUB_DARK_THEME: TerminalTheme = {
  background: "#24292e",
  foreground: "#d1d5da",
  mutedForeground: "#959da5",
  border: "rgba(240,246,252,0.12)",
  cursorForeground: "#79b8ff",
  cursorBackground: "#586069",
  palette: [
    "#586069",
    "#ea4a5a",
    "#34d058",
    "#ffea7f",
    "#2188ff",
    "#b392f0",
    "#39c5cf",
    "#d1d5da",
    "#959da5",
    "#f97583",
    "#85e89d",
    "#ffea7f",
    "#79b8ff",
    "#b392f0",
    "#56d4dd",
    "#fafbfc",
  ],
};

export function getGitHubTerminalTheme(scheme: TerminalAppearanceScheme): TerminalTheme {
  return scheme === "light" ? GITHUB_LIGHT_THEME : GITHUB_DARK_THEME;
}

export function buildGhosttyThemeConfig(theme: TerminalTheme): string {
  const lines = [
    `background = ${theme.background}`,
    `foreground = ${theme.foreground}`,
    `cursor-color = ${theme.cursorForeground}`,
    `cursor-text = ${theme.cursorBackground}`,
  ];

  for (const [index, color] of theme.palette.entries()) {
    lines.push(`palette = ${index}=${color}`);
  }

  return `${lines.join("\n")}\n`;
}
