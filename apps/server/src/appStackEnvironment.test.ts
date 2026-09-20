import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { appStackEnvironment } from "./appStackEnvironment.ts";

describe("App Stack command environment", () => {
  it.effect("passes the controller endpoint and credential to child commands", () =>
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const environment = appStackEnvironment({
        appStackBackendUrl: new URL("https://stacks.example.test/nested?query=ignored"),
        appStackBackendBearerToken: Redacted.make("fixture-token"),
      });

      const output = yield* spawner.string(
        ChildProcess.make(
          process.execPath,
          [
            "-e",
            'process.stdout.write([process.env.APP_DEV_STACK_API_URL, process.env.APP_DEV_STACK_API_TOKEN].join("\\n"))',
          ],
          { env: environment, extendEnv: true },
        ),
      );

      expect(output).toBe("https://stacks.example.test/api/app-dev-stacks\nfixture-token");
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.each([
    undefined,
    { appStackBackendUrl: undefined, appStackBackendBearerToken: undefined },
    {
      appStackBackendUrl: new URL("https://stacks.example.test"),
      appStackBackendBearerToken: undefined,
    },
    {
      appStackBackendUrl: undefined,
      appStackBackendBearerToken: Redacted.make("fixture-token"),
    },
  ])("does not supply incomplete controller credentials, case %#", (config) => {
    expect(appStackEnvironment(config)).toBeUndefined();
  });
});
