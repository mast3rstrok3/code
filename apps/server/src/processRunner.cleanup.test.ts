import * as NodeNet from "node:net";
import { describe, expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import { TestClock } from "effect/testing";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ProcessRunner from "./processRunner.ts";

const acceptsConnections = (port: number) =>
  Effect.promise(
    () =>
      new Promise<boolean>((resolve) => {
        const socket = NodeNet.connect({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve(true);
        });
        socket.once("error", () => resolve(false));
      }),
  );

const descendantScript = `
  process.on("SIGTERM", () => {});
  const server = require("node:net").createServer(socket => socket.destroy());
  server.listen(0, "127.0.0.1", () => {
    process.stdout.write("READY " + process.pid + " " + server.address().port + "\\n");
  });
`;

const leaderScript = `
  require("node:child_process").spawn(process.execPath, ["-e", ${JSON.stringify(descendantScript)}], {
    stdio: ["ignore", "inherit", "inherit"]
  });
`;

const windowsHost = HostProcessPlatform.defaultValue() === "win32";

describe("process cleanup", () => {
  for (const interruption of ["timeout", "cancellation"] as const) {
    it.effect.skipIf(windowsHost)(
      `stops a descendant that ignores SIGTERM after ${interruption}`,
      () =>
        Effect.gen(function* () {
          const runner = yield* ProcessRunner.ProcessRunner;
          const ready = yield* Deferred.make<{ pid: number; port: number }>();
          let stdout = "";
          const running = yield* runner
            .run({
              command: process.execPath,
              args: ["-e", leaderScript],
              timeout: "1 second",
              timeoutBehavior: "timedOutResult",
              onOutputChunk: (stream, chunk) =>
                Effect.gen(function* () {
                  if (stream !== "stdout") return;
                  stdout += Buffer.from(chunk).toString("utf8");
                  const match = /READY (\d+) (\d+)/.exec(stdout);
                  if (match) {
                    yield* Deferred.succeed(ready, {
                      pid: Number(match[1]),
                      port: Number(match[2]),
                    });
                  }
                }),
            })
            .pipe(Effect.forkScoped);
          const { pid, port } = yield* Deferred.await(ready);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              try {
                process.kill(pid, "SIGKILL");
              } catch {}
            }),
          );
          expect(yield* acceptsConnections(port)).toBe(true);
          if (interruption === "timeout") {
            yield* TestClock.adjust("1 second");
            expect((yield* Fiber.join(running)).timedOut).toBe(true);
          } else {
            yield* Fiber.interrupt(running);
          }
          expect(yield* acceptsConnections(port)).toBe(false);
        }).pipe(
          Effect.scoped,
          Effect.provide(ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer))),
        ),
      { timeout: 15_000 },
    );
  }
});
