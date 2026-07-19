import type { OrchestrationPlanningFileChange } from "@t3tools/contracts";

const VALID_ACTIONS = new Set(["create", "update", "delete"]);
const GLOB_PATTERN = /[*?[\]{}]/;
const WINDOWS_DRIVE_PATTERN = /^[a-zA-Z]:/;

export function validatePlanningTicketFileChanges(
  changes: ReadonlyArray<OrchestrationPlanningFileChange>,
): string | null {
  if (changes.length === 0) {
    return "Planning Tickets must include at least one planned file change.";
  }

  const paths = new Set<string>();
  for (const change of changes) {
    if (!VALID_ACTIONS.has(change.action)) {
      return `Planned file '${change.path}' has invalid action '${change.action}'.`;
    }

    const filePath = change.path;
    if (filePath !== filePath.trim() || filePath.length === 0) {
      return "Planned file paths must be trimmed non-empty strings.";
    }
    if (
      filePath.startsWith("/") ||
      filePath.startsWith("~") ||
      WINDOWS_DRIVE_PATTERN.test(filePath)
    ) {
      return `Planned file path '${filePath}' must be repository-relative.`;
    }
    if (filePath.includes("\0")) {
      return "Planned file paths must not contain null bytes.";
    }
    if (filePath.includes("\\")) {
      return `Planned file path '${filePath}' must use POSIX separators.`;
    }
    if (filePath.endsWith("/") || filePath.includes("//")) {
      return `Planned file path '${filePath}' must identify an exact file.`;
    }
    const segments = filePath.split("/");
    if (segments.some((segment) => segment === "." || segment === "..")) {
      return `Planned file path '${filePath}' must not contain traversal segments.`;
    }
    if (GLOB_PATTERN.test(filePath)) {
      return `Planned file path '${filePath}' must not contain glob syntax.`;
    }
    if (paths.has(filePath)) {
      return `Planned file path '${filePath}' is duplicated within the ticket.`;
    }
    paths.add(filePath);
  }

  return null;
}
