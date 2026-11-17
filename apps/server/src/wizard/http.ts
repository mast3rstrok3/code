// @effect-diagnostics-next-line nodeBuiltinImport:off -- a plain hash keeps the token compare constant-time.
import * as NodeCrypto from "node:crypto";

import { WizardCreateThreadRequest, WizardSendMessageRequest } from "@t3tools/contracts";
import * as ByteSize from "effect/ByteSize";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";
import * as HttpIncomingMessage from "effect/http/HttpIncomingMessage";

import { WizardApiError, WizardConfig, WizardService } from "./WizardService.ts";

const WIZARD_ROUTE_PREFIX = "/api/wizard";
const isWizardApiError = Schema.is(WizardApiError);
const JSON_MAX_BODY_BYTES = 512 * 1024;
const NO_STORE = { "cache-control": "no-store" };

const json = (status: number, body: unknown) =>
  HttpServerResponse.jsonUnsafe(body, { status, headers: NO_STORE });
const errorResponse = (status: number, error: string, message?: string) =>
  json(status, message === undefined ? { error } : { error, message });

const digest = (value: string) => NodeCrypto.createHash("sha256").update(value).digest();

/** Compares fixed-length digests, so neither the token nor its length leaks through timing. */
function bearerMatches(header: string | undefined, token: string): boolean {
  const match = /^Bearer\s+(.+)$/i.exec(header?.trim() ?? "");
  const presented = match?.[1]?.trim() ?? "";
  return NodeCrypto.timingSafeEqual(digest(presented), digest(token)) && presented !== "";
}

/**
 * Every route answers 404 while the API is off, and 401 without the right bearer token, before
 * the body is read. The token reaches no other route: these routes read no session.
 */
const guarded = Effect.fn("WizardHttp.guarded")(
  function* <E, R>(handler: Effect.Effect<HttpServerResponse.HttpServerResponse, E, R>) {
    const config = yield* WizardConfig;
    if (config.token === null) return errorResponse(404, "not_found");
    const request = yield* HttpServerRequest.HttpServerRequest;
    if (!bearerMatches(request.headers.authorization, Redacted.value(config.token))) {
      return errorResponse(401, "unauthorized");
    }
    return yield* handler;
  },
  Effect.catch((error) =>
    isWizardApiError(error)
      ? Effect.succeed(errorResponse(error.status, error.code, error.message))
      : Effect.logWarning("Wizard API request failed", { cause: error }).pipe(
          Effect.as(errorResponse(500, "internal_error")),
        ),
  ),
  Effect.catchDefect((defect) =>
    Effect.logError("Wizard API request crashed", { defect }).pipe(
      Effect.as(errorResponse(500, "internal_error")),
    ),
  ),
);

const readBody = Effect.fn("WizardHttp.readBody")(function* <S extends Schema.Top>(schema: S) {
  const request = yield* HttpServerRequest.HttpServerRequest;
  if (Number(request.headers["content-length"] ?? "0") > JSON_MAX_BODY_BYTES) {
    return yield* new WizardApiError({
      status: 400,
      code: "too_large",
      message: "The body is too large.",
    });
  }
  const body = yield* request.json.pipe(
    Effect.provideService(HttpIncomingMessage.MaxBodySize, ByteSize.bytes(JSON_MAX_BODY_BYTES)),
    Effect.flatMap(Schema.decodeUnknownEffect(schema)),
    Effect.mapError(
      (cause) =>
        new WizardApiError({
          status: 400,
          code: "invalid_request",
          message: Schema.isSchemaError(cause) ? cause.message : "The body is not valid JSON.",
        }),
    ),
  );
  return body as S["Type"];
});

const searchParams = Effect.map(
  HttpServerRequest.HttpServerRequest,
  (request) => new URLSearchParams(request.url.split("?", 2)[1] ?? ""),
);

const threadIdParam = Effect.map(HttpRouter.params, (params) => params.threadId ?? "");

const route = <R>(
  method: "GET" | "POST",
  path: HttpRouter.PathInput,
  handler: Effect.Effect<HttpServerResponse.HttpServerResponse, never, R>,
) => ({ method, path, handler });

const integerParam = (value: string | null, fallback: number) => {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
};

const modelsRoute = route(
  "GET",
  `${WIZARD_ROUTE_PREFIX}/models`,
  guarded(
    Effect.gen(function* () {
      const wizard = yield* WizardService;
      return json(200, yield* wizard.models);
    }),
  ),
);

const createRoute = route(
  "POST",
  `${WIZARD_ROUTE_PREFIX}/threads`,
  guarded(
    Effect.gen(function* () {
      const body = yield* readBody(WizardCreateThreadRequest);
      const wizard = yield* WizardService;
      return json(201, yield* wizard.createThread(body));
    }),
  ),
);

const listRoute = route(
  "GET",
  `${WIZARD_ROUTE_PREFIX}/threads`,
  guarded(
    Effect.gen(function* () {
      const wizardId = (yield* searchParams).get("wizardId");
      const wizard = yield* WizardService;
      const threads = yield* wizard.listThreads(
        wizardId === null || wizardId === "" ? null : wizardId,
      );
      return json(200, { threads });
    }),
  ),
);

const getRoute = route(
  "GET",
  `${WIZARD_ROUTE_PREFIX}/threads/:threadId`,
  guarded(
    Effect.gen(function* () {
      const wizard = yield* WizardService;
      return json(200, yield* wizard.getThread(yield* threadIdParam));
    }),
  ),
);

const messageRoute = route(
  "POST",
  `${WIZARD_ROUTE_PREFIX}/threads/:threadId/messages`,
  guarded(
    Effect.gen(function* () {
      const threadId = yield* threadIdParam;
      const body = yield* readBody(WizardSendMessageRequest);
      const wizard = yield* WizardService;
      yield* wizard.sendMessage(threadId, body);
      return json(202, { accepted: true });
    }),
  ),
);

const interruptRoute = route(
  "POST",
  `${WIZARD_ROUTE_PREFIX}/threads/:threadId/interrupt`,
  guarded(
    Effect.gen(function* () {
      const wizard = yield* WizardService;
      yield* wizard.interrupt(yield* threadIdParam);
      return json(202, { accepted: true });
    }),
  ),
);

const transcriptRoute = route(
  "GET",
  `${WIZARD_ROUTE_PREFIX}/threads/:threadId/transcript`,
  guarded(
    Effect.gen(function* () {
      const params = yield* searchParams;
      const after = integerParam(params.get("after"), 0);
      const waitMs = integerParam(params.get("waitMs"), 0);
      if (after === null || waitMs === null) {
        return errorResponse(400, "invalid_request", "after and waitMs must be whole numbers.");
      }
      const wizard = yield* WizardService;
      return json(200, yield* wizard.transcript({ threadId: yield* threadIdParam, after, waitMs }));
    }),
  ),
);

const routes = [
  modelsRoute,
  createRoute,
  listRoute,
  getRoute,
  messageRoute,
  interruptRoute,
  transcriptRoute,
];

/** Handlers get the service and config the layer was built with, not per-request context. */
export const layer = HttpRouter.use(
  Effect.fnUntraced(function* (router) {
    const wizard = yield* WizardService;
    const config = yield* WizardConfig;
    for (const { method, path, handler } of routes) {
      yield* router.add(
        method,
        path,
        handler.pipe(
          Effect.provideService(WizardService, wizard),
          Effect.provideService(WizardConfig, config),
        ),
      );
    }
  }),
);
