// Runs eas-cli as the fork. Only `eas build` applies a build profile's env, so
// without this `eas submit`, `eas build:list` and `eas update` would resolve the
// T3 Tools project from app.config.ts instead of the fork's.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const mobileRoot = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const easConfig = JSON.parse(NodeFS.readFileSync(NodePath.join(mobileRoot, "eas.json"), "utf8"));
const forkEnv: Record<string, string> = easConfig.build.fork.env;

const result = NodeChildProcess.spawnSync(
  "npx",
  ["--yes", "eas-cli@latest", ...process.argv.slice(2)],
  { cwd: mobileRoot, stdio: "inherit", env: { ...process.env, ...forkEnv } },
);
process.exit(result.status ?? 1);
