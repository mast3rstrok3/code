import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as HttpRouter from "effect/http/HttpRouter";

import * as WizardHttp from "./http.ts";
import { WizardConfig, WizardService } from "./WizardService.ts";

const TOKEN = "wizard-test-token-0123456789";

const handlerFor = (token: string | null, calls: string[] = []) =>
  HttpRouter.toWebHandler(
    WizardHttp.layer.pipe(
      Layer.provide(
        Layer.mock(WizardService)({
          models: Effect.sync(() => {
            calls.push("models");
            return { models: [], default: { provider: "codex", model: "gpt-5.4" } };
          }),
          transcript: (input) =>
            Effect.sync(() => {
              calls.push(`transcript:${input.threadId}:${input.after}:${input.waitMs}`);
              return { items: [], cursor: input.after, thread: {} as never };
            }),
        }),
      ),
      Layer.provide(
        Layer.succeed(WizardConfig, {
          token: token === null ? null : Redacted.make(token),
          projectPath: "/project",
          baseBranch: "origin/dev",
          publicUrl: "https://wizard.example",
        }),
      ),
    ),
    { disableLogger: true },
  );

const get = (path: string, authorization?: string) =>
  new Request(`http://127.0.0.1${path}`, {
    headers: authorization === undefined ? {} : { authorization },
  });

it.effect("answers 404 on every route while no token is configured", () =>
  Effect.acquireUseRelease(
    Effect.sync(() => handlerFor(null)),
    ({ handler }) =>
      Effect.promise(async () => {
        const response = await handler(get("/api/wizard/models", `Bearer ${TOKEN}`));
        expect(response.status).toBe(404);
        const create = await handler(
          new Request("http://127.0.0.1/api/wizard/threads", { method: "POST", body: "{}" }),
        );
        expect(create.status).toBe(404);
      }),
    ({ dispose }) => Effect.promise(dispose),
  ),
);

it.effect("refuses a missing or wrong bearer token before reaching the service", () => {
  const calls: string[] = [];
  return Effect.acquireUseRelease(
    Effect.sync(() => handlerFor(TOKEN, calls)),
    ({ handler }) =>
      Effect.promise(async () => {
        for (const authorization of [undefined, "Bearer wrong", `Bearer ${TOKEN}x`, TOKEN]) {
          const response = await handler(get("/api/wizard/models", authorization));
          expect(response.status).toBe(401);
          expect(await response.json()).toEqual({ error: "unauthorized" });
        }
        expect(calls).toEqual([]);
        const ok = await handler(get("/api/wizard/models", `Bearer ${TOKEN}`));
        expect(ok.status).toBe(200);
        expect(calls).toEqual(["models"]);
      }),
    ({ dispose }) => Effect.promise(dispose),
  );
});

it.effect("rejects an invalid body or cursor with 400", () => {
  const calls: string[] = [];
  return Effect.acquireUseRelease(
    Effect.sync(() => handlerFor(TOKEN, calls)),
    ({ handler }) =>
      Effect.promise(async () => {
        const create = await handler(
          new Request("http://127.0.0.1/api/wizard/threads", {
            method: "POST",
            headers: { authorization: `Bearer ${TOKEN}`, "content-type": "application/json" },
            body: JSON.stringify({ wizard: { id: "u1" }, message: "hi" }),
          }),
        );
        expect(create.status).toBe(400);
        expect(await create.json()).toMatchObject({ error: "invalid_request" });
        const badCursor = await handler(
          get("/api/wizard/threads/t1/transcript?after=-1", `Bearer ${TOKEN}`),
        );
        expect(badCursor.status).toBe(400);
        const transcript = await handler(
          get("/api/wizard/threads/t1/transcript?after=7&waitMs=100", `Bearer ${TOKEN}`),
        );
        expect(transcript.status).toBe(200);
        expect(calls).toEqual(["transcript:t1:7:100"]);
      }),
    ({ dispose }) => Effect.promise(dispose),
  );
});
