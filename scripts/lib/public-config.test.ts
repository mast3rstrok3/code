// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  loadRepoEnv,
  resolvePublicConfig,
  resolveWebPrimaryEnvironmentBuildConfig,
} from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_root\nT3CODE_CLERK_JWT_TEMPLATE=template_root\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_root\nT3CODE_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_local\nT3CODE_CLERK_JWT_TEMPLATE=template_local\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nT3CODE_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).T3CODE_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
          T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          T3CODE_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "template_ci",
      T3CODE_RELAY_URL: "https://ci.example.test",
      VITE_T3CODE_RELAY_URL: "https://ci.example.test",
    });
  });
});

describe("resolveWebPrimaryEnvironmentBuildConfig", () => {
  it("strips configured primary environment URLs from production builds by default", () => {
    expect(
      resolveWebPrimaryEnvironmentBuildConfig({
        command: "build",
        env: {
          VITE_HTTP_URL: " https://code-dev.nightingale-ai.com ",
          VITE_WS_URL: " wss://code-dev.nightingale-ai.com ",
          VITE_DEV_SERVER_URL: " https://code-dev.nightingale-ai.com ",
        },
      }),
    ).toEqual({
      httpUrl: "",
      wsUrl: "",
      devServerUrl: "",
    });
  });

  it("preserves configured primary environment URLs while serving locally", () => {
    expect(
      resolveWebPrimaryEnvironmentBuildConfig({
        command: "serve",
        env: {
          VITE_HTTP_URL: " http://localhost:3773 ",
          VITE_WS_URL: " ws://localhost:3773 ",
          VITE_DEV_SERVER_URL: " http://localhost:5733 ",
        },
      }),
    ).toEqual({
      httpUrl: "http://localhost:3773",
      wsUrl: "ws://localhost:3773",
      devServerUrl: "http://localhost:5733",
    });
  });

  it("supports an explicit production static-backend opt-in without exposing dev server URLs", () => {
    expect(
      resolveWebPrimaryEnvironmentBuildConfig({
        command: "build",
        env: {
          T3CODE_WEB_EMBED_PRIMARY_ENVIRONMENT: "1",
          VITE_HTTP_URL: " https://backend.example.test ",
          VITE_WS_URL: " wss://backend.example.test ",
          VITE_DEV_SERVER_URL: " https://dev-ui.example.test ",
        },
      }),
    ).toEqual({
      httpUrl: "https://backend.example.test",
      wsUrl: "wss://backend.example.test",
      devServerUrl: "",
    });
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
