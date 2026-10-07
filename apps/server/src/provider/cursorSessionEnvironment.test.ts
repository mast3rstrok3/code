// @effect-diagnostics nodeBuiltinImport:off -- Exercise the SDK's shell launch boundary with real child processes.
import * as NodeModule from "node:module";
import { describe, expect, it } from "vite-plus/test";
import { WORKSPACE_USER_PATH_PREFIX } from "../workspaceUserCredentials.ts";
import { withCursorSessionEnvironment } from "./cursorSessionEnvironment.ts";

const childProcess = NodeModule.createRequire(import.meta.url)(
  "node:child_process",
) as typeof import("node:child_process");
function launch() {
  return new Promise<string>((resolve, reject) => {
    const child = childProcess.spawn(
      process.execPath,
      ["-e", "process.stdout.write(JSON.stringify([process.env.T3_TEST_OWNER, process.env.PATH]))"],
      {
        env: { T3_TEST_OWNER: "host", PATH: "/base" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk: Buffer) => {
      output += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (code) =>
      code === 0 ? resolve(output) : reject(new Error(`Child exited ${code}`)),
    );
  });
}

describe("Cursor session environment", () => {
  it("keeps concurrent owners and unrelated shell launches separate", async () => {
    const owner = (id: string) =>
      withCursorSessionEnvironment(
        { T3_TEST_OWNER: id, [WORKSPACE_USER_PATH_PREFIX]: `/tools/${id}` },
        async () => {
          await Promise.resolve();
          return launch();
        },
      );
    const result = await Promise.all([owner("alice"), owner("bob"), launch()]);
    expect(result.map((value) => JSON.parse(value))).toEqual([
      ["alice", "/tools/alice:/base"],
      ["bob", "/tools/bob:/base"],
      ["host", "/base"],
    ]);
    expect(JSON.parse(await launch())).toEqual(["host", "/base"]);
  });
});
