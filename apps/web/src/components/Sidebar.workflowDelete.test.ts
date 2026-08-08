import { expect, it } from "vite-plus/test";

import {
  getMultiThreadDeleteConfirmationText,
  getThreadDeleteConfirmationText,
} from "./Sidebar.logic";

it("warns that deleting a workflow tree cancels its running work", () => {
  expect(getThreadDeleteConfirmationText("Workflow")).toContain("running work");
  expect(getThreadDeleteConfirmationText("Workflow")).toContain("all sub-threads");
  expect(getMultiThreadDeleteConfirmationText(2)).toContain("running work");
  expect(getMultiThreadDeleteConfirmationText(2)).toContain("all their descendants");
});
