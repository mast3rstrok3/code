import { describe, expect, it } from "vite-plus/test";

import { getThreadDeleteConfirmationMessage } from "./threadDeleteConfirmation";

describe("getThreadDeleteConfirmationMessage", () => {
  it("warns that sub-threads and terminal history are deleted", () => {
    const message = getThreadDeleteConfirmationMessage("Parent thread");

    expect(message).toContain("all sub-threads");
    expect(message).toContain("terminal history");
  });
});
