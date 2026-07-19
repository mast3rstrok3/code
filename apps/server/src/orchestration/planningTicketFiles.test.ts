import { describe, expect, it } from "vite-plus/test";

import { validatePlanningTicketFileChanges } from "./planningTicketFiles.ts";

describe("validatePlanningTicketFileChanges", () => {
  it("accepts exact repository-relative files and preserves action coverage", () => {
    expect(
      validatePlanningTicketFileChanges([
        { path: "src/new.ts", action: "create" },
        { path: "src/current.ts", action: "update" },
        { path: "src/old.ts", action: "delete" },
      ]),
    ).toBeNull();
  });

  it.each([
    [[], "at least one"],
    [[{ path: "/src/file.ts", action: "update" as const }], "repository-relative"],
    [[{ path: "C:/src/file.ts", action: "update" as const }], "repository-relative"],
    [[{ path: "~/src/file.ts", action: "update" as const }], "repository-relative"],
    [[{ path: "src\\file.ts", action: "update" as const }], "POSIX"],
    [[{ path: "src/file\0.ts", action: "update" as const }], "null bytes"],
    [[{ path: "src/../file.ts", action: "update" as const }], "traversal"],
    [[{ path: "src/", action: "update" as const }], "exact file"],
    [[{ path: "src/*.ts", action: "update" as const }], "glob"],
    [
      [
        { path: "src/file.ts", action: "update" as const },
        { path: "src/file.ts", action: "delete" as const },
      ],
      "duplicated",
    ],
  ])("rejects invalid planned-file lists %#", (changes, expected) => {
    expect(validatePlanningTicketFileChanges(changes)).toContain(expected);
  });
});
