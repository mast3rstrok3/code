import {
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
  EnvironmentOwnerAuth,
  EnvironmentOwnerPrincipal,
  EnvironmentSessionAuth,
  EnvironmentSessionPrincipal,
  EnvironmentHttpUnauthorizedError,
} from "@t3tools/contracts";
import type {
  AuthBootstrapInput,
  AuthCreatePairingCredentialInput,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Cookies from "effect/unstable/http/Cookies";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { AuthError, ServerAuth } from "./Services/ServerAuth.ts";
import { SessionCredentialService } from "./Services/SessionCredentialService.ts";
import { deriveAuthClientMetadata } from "./utils.ts";

export const respondToAuthError = (error: AuthError) =>
  Effect.gen(function* () {
    if ((error.status ?? 500) >= 500) {
      yield* Effect.logError("auth route failed", {
        message: error.message,
        cause: error.cause,
      });
    }
    return HttpServerResponse.jsonUnsafe(
      {
        error: error.message,
      },
      { status: error.status ?? 500 },
    );
  });

export const failEnvironmentHttpAuthError = (error: AuthError) =>
  Effect.gen(function* () {
    if ((error.status ?? 500) >= 500) {
      yield* Effect.logError("auth route failed", {
        message: error.message,
        cause: error.cause,
      });
    }

    switch (error.status) {
      case 400:
        return yield* new EnvironmentHttpBadRequestError({ message: error.message });
      case 401:
        return yield* new EnvironmentHttpUnauthorizedError({ message: error.message });
      case 403:
        return yield* new EnvironmentHttpForbiddenError({ message: error.message });
      default:
        return yield* new EnvironmentHttpInternalServerError({ message: error.message });
    }
  });

export const environmentSessionAuthLayer = Layer.effect(
  EnvironmentSessionAuth,
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* serverAuth.authenticateHttpRequest(request);
        return yield* httpEffect.pipe(Effect.provideService(EnvironmentSessionPrincipal, session));
      }).pipe(Effect.catchTag("AuthError", failEnvironmentHttpAuthError));
  }),
);

export const environmentOwnerAuthLayer = Layer.effect(
  EnvironmentOwnerAuth,
  Effect.gen(function* () {
    const serverAuth = yield* ServerAuth;
    return (httpEffect) =>
      Effect.gen(function* () {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const session = yield* serverAuth.authenticateHttpRequest(request);
        if (session.role !== "owner") {
          return yield* new AuthError({
            message: "Only owner sessions can manage network access.",
            status: 403,
          });
        }
        return yield* httpEffect.pipe(
          Effect.provideService(EnvironmentOwnerPrincipal, { ...session, role: "owner" }),
        );
      }).pipe(Effect.catchTag("AuthError", failEnvironmentHttpAuthError));
  }),
);

export const authHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "auth",
  Effect.fnUntraced(function* (handlers) {
    const serverAuth = yield* ServerAuth;
    const sessions = yield* SessionCredentialService;

    const sessionHandler = Effect.fn("environment.auth.session")(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      return yield* serverAuth.getSessionState(request);
    });

    const bootstrapHandler = Effect.fn("environment.auth.bootstrap")(
      function* (input: { readonly payload: AuthBootstrapInput }) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        const result = yield* serverAuth.exchangeBootstrapCredential(
          input.payload.credential,
          deriveAuthClientMetadata({ request }),
        );
        const sessionCookies = yield* Effect.fromResult(
          Cookies.set(Cookies.empty, sessions.cookieName, result.sessionToken, {
            expires: DateTime.toDate(result.response.expiresAt),
            httpOnly: true,
            path: "/",
            sameSite: "lax",
          }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new AuthError({
                message: "Failed to create browser session response.",
                status: 500,
                cause,
              }),
          ),
        );

        yield* HttpEffect.appendPreResponseHandler((_request, response) =>
          Effect.succeed(HttpServerResponse.mergeCookies(response, sessionCookies)),
        );
        return result.response;
      },
      Effect.catchTag("AuthError", failEnvironmentHttpAuthError),
    );

    const bootstrapBearerHandler = Effect.fn("environment.auth.bootstrapBearer")(
      function* (input: { readonly payload: AuthBootstrapInput }) {
        const request = yield* HttpServerRequest.HttpServerRequest;
        return yield* serverAuth.exchangeBootstrapCredentialForBearerSession(
          input.payload.credential,
          deriveAuthClientMetadata({ request }),
        );
      },
      Effect.catchTag("AuthError", failEnvironmentHttpAuthError),
    );

    const webSocketTokenHandler = Effect.fn("environment.auth.webSocketToken")(
      function* () {
        const session = yield* EnvironmentSessionPrincipal;
        return yield* serverAuth.issueWebSocketToken(session);
      },
      Effect.catchTag("AuthError", failEnvironmentHttpAuthError),
    );

    const pairingCredentialHandler = Effect.fn("environment.auth.pairingCredential")(
      function* (input: { readonly payload: AuthCreatePairingCredentialInput }) {
        return yield* serverAuth.issuePairingCredential(input.payload);
      },
      Effect.catchTag("AuthError", failEnvironmentHttpAuthError),
    );

    const pairingLinksHandler = Effect.fn("environment.auth.pairingLinks")(
      function* () {
        return yield* serverAuth.listPairingLinks();
      },
      Effect.catchTag("AuthError", failEnvironmentHttpAuthError),
    );

    const revokePairingLinkHandler = Effect.fn("environment.auth.revokePairingLink")(
      function* (input: { readonly payload: AuthRevokePairingLinkInput }) {
        const revoked = yield* serverAuth.revokePairingLink(input.payload.id);
        return { revoked };
      },
      Effect.catchTag("AuthError", failEnvironmentHttpAuthError),
    );

    const clientsHandler = Effect.fn("environment.auth.clients")(
      function* () {
        const session = yield* EnvironmentOwnerPrincipal;
        return yield* serverAuth.listClientSessions(session.sessionId);
      },
      Effect.catchTag("AuthError", failEnvironmentHttpAuthError),
    );

    const revokeClientHandler = Effect.fn("environment.auth.revokeClient")(
      function* (input: { readonly payload: AuthRevokeClientSessionInput }) {
        const session = yield* EnvironmentOwnerPrincipal;
        const revoked = yield* serverAuth.revokeClientSession(
          session.sessionId,
          input.payload.sessionId,
        );
        return { revoked };
      },
      Effect.catchTag("AuthError", failEnvironmentHttpAuthError),
    );

    const revokeOtherClientsHandler = Effect.fn("environment.auth.revokeOtherClients")(
      function* () {
        const session = yield* EnvironmentOwnerPrincipal;
        const revokedCount = yield* serverAuth.revokeOtherClientSessions(session.sessionId);
        return { revokedCount };
      },
      Effect.catchTag("AuthError", failEnvironmentHttpAuthError),
    );

    return handlers
      .handle("session", sessionHandler)
      .handle("bootstrap", bootstrapHandler)
      .handle("bootstrapBearer", bootstrapBearerHandler)
      .handle("webSocketToken", webSocketTokenHandler)
      .handle("pairingCredential", pairingCredentialHandler)
      .handle("pairingLinks", pairingLinksHandler)
      .handle("revokePairingLink", revokePairingLinkHandler)
      .handle("clients", clientsHandler)
      .handle("revokeClient", revokeClientHandler)
      .handle("revokeOtherClients", revokeOtherClientsHandler);
  }),
);
