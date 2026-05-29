import * as Context from "effect/Context";
import type * as DateTime from "effect/DateTime";
import * as Schema from "effect/Schema";
import * as HttpApi from "effect/unstable/httpapi/HttpApi";
import * as HttpApiEndpoint from "effect/unstable/httpapi/HttpApiEndpoint";
import * as HttpApiGroup from "effect/unstable/httpapi/HttpApiGroup";
import * as HttpApiMiddleware from "effect/unstable/httpapi/HttpApiMiddleware";
import * as HttpApiSchema from "effect/unstable/httpapi/HttpApiSchema";

import {
  AuthBearerBootstrapResult,
  AuthBootstrapInput,
  AuthBootstrapResult,
  AuthClientSession,
  AuthCreatePairingCredentialInput,
  AuthPairingCredentialResult,
  AuthPairingLink,
  AuthRevokeClientSessionInput,
  AuthRevokePairingLinkInput,
  AuthSessionRole,
  AuthSessionState,
  AuthWebSocketTokenResult,
  ServerAuthSessionMethod,
} from "./auth.ts";
import { AuthSessionId } from "./baseSchemas.ts";
import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import {
  ClientOrchestrationCommand,
  DispatchResult,
  OrchestrationReadModel,
} from "./orchestration.ts";

const OptionalBearerHeaders = Schema.Struct({
  authorization: Schema.optionalKey(Schema.String),
});

export class EnvironmentHttpBadRequestError extends Schema.TaggedErrorClass<EnvironmentHttpBadRequestError>()(
  "EnvironmentHttpBadRequestError",
  {
    message: Schema.String,
  },
) {}

export class EnvironmentHttpUnauthorizedError extends Schema.TaggedErrorClass<EnvironmentHttpUnauthorizedError>()(
  "EnvironmentHttpUnauthorizedError",
  {
    message: Schema.String,
  },
) {}

export class EnvironmentHttpForbiddenError extends Schema.TaggedErrorClass<EnvironmentHttpForbiddenError>()(
  "EnvironmentHttpForbiddenError",
  {
    message: Schema.String,
  },
) {}

export class EnvironmentHttpInternalServerError extends Schema.TaggedErrorClass<EnvironmentHttpInternalServerError>()(
  "EnvironmentHttpInternalServerError",
  {
    message: Schema.String,
  },
) {}

export const EnvironmentHttpCommonError = Schema.Union([
  EnvironmentHttpBadRequestError,
  EnvironmentHttpUnauthorizedError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
]);
export type EnvironmentHttpCommonError = typeof EnvironmentHttpCommonError.Type;

const EnvironmentHttpBadRequestErrorResponse = EnvironmentHttpBadRequestError.pipe(
  HttpApiSchema.status("BadRequest"),
);
const EnvironmentHttpUnauthorizedErrorResponse = EnvironmentHttpUnauthorizedError.pipe(
  HttpApiSchema.status("Unauthorized"),
);
const EnvironmentHttpForbiddenErrorResponse = EnvironmentHttpForbiddenError.pipe(
  HttpApiSchema.status("Forbidden"),
);
const EnvironmentHttpInternalServerErrorResponse = EnvironmentHttpInternalServerError.pipe(
  HttpApiSchema.status("InternalServerError"),
);

const EnvironmentHttpAuthErrors = [
  EnvironmentHttpBadRequestErrorResponse,
  EnvironmentHttpUnauthorizedErrorResponse,
  EnvironmentHttpForbiddenErrorResponse,
  EnvironmentHttpInternalServerErrorResponse,
] as const;

const EnvironmentHttpOrchestrationErrors = [
  EnvironmentHttpBadRequestErrorResponse,
  EnvironmentHttpUnauthorizedErrorResponse,
  EnvironmentHttpForbiddenErrorResponse,
  EnvironmentHttpInternalServerErrorResponse,
] as const;

export interface EnvironmentSessionPrincipalShape {
  readonly sessionId: AuthSessionId;
  readonly subject: string;
  readonly method: ServerAuthSessionMethod;
  readonly role: AuthSessionRole;
  readonly expiresAt?: DateTime.DateTime;
}

export class EnvironmentSessionPrincipal extends Context.Service<
  EnvironmentSessionPrincipal,
  EnvironmentSessionPrincipalShape
>()("@t3tools/contracts/environmentHttp/EnvironmentSessionPrincipal") {}

export class EnvironmentOwnerPrincipal extends Context.Service<
  EnvironmentOwnerPrincipal,
  EnvironmentSessionPrincipalShape & { readonly role: "owner" }
>()("@t3tools/contracts/environmentHttp/EnvironmentOwnerPrincipal") {}

export class EnvironmentSessionAuth extends HttpApiMiddleware.Service<
  EnvironmentSessionAuth,
  { provides: EnvironmentSessionPrincipal }
>()("EnvironmentSessionAuth", {
  error: EnvironmentHttpAuthErrors,
}) {}

export class EnvironmentOwnerAuth extends HttpApiMiddleware.Service<
  EnvironmentOwnerAuth,
  { provides: EnvironmentOwnerPrincipal }
>()("EnvironmentOwnerAuth", {
  error: EnvironmentHttpAuthErrors,
}) {}

export const AuthPairingLinkRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthPairingLinkRevokeResult = typeof AuthPairingLinkRevokeResult.Type;

export const AuthClientSessionRevokeResult = Schema.Struct({
  revoked: Schema.Boolean,
});
export type AuthClientSessionRevokeResult = typeof AuthClientSessionRevokeResult.Type;

export const AuthOtherClientSessionsRevokeResult = Schema.Struct({
  revokedCount: Schema.Number,
});
export type AuthOtherClientSessionsRevokeResult = typeof AuthOtherClientSessionsRevokeResult.Type;

export class EnvironmentMetadataHttpApi extends HttpApiGroup.make("metadata").add(
  HttpApiEndpoint.get("descriptor", "/.well-known/t3/environment", {
    success: ExecutionEnvironmentDescriptor,
  }),
) {}

export class EnvironmentAuthHttpApi extends HttpApiGroup.make("auth")
  .add(
    HttpApiEndpoint.get("session", "/api/auth/session", {
      headers: OptionalBearerHeaders,
      success: AuthSessionState,
    }),
  )
  .add(
    HttpApiEndpoint.post("bootstrap", "/api/auth/bootstrap", {
      payload: AuthBootstrapInput,
      success: AuthBootstrapResult,
      error: EnvironmentHttpAuthErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("bootstrapBearer", "/api/auth/bootstrap/bearer", {
      payload: AuthBootstrapInput,
      success: AuthBearerBootstrapResult,
      error: EnvironmentHttpAuthErrors,
    }),
  )
  .add(
    HttpApiEndpoint.post("webSocketToken", "/api/auth/ws-token", {
      headers: OptionalBearerHeaders,
      success: AuthWebSocketTokenResult,
      error: EnvironmentHttpAuthErrors,
    }).middleware(EnvironmentSessionAuth),
  )
  .add(
    HttpApiEndpoint.post("pairingCredential", "/api/auth/pairing-token", {
      headers: OptionalBearerHeaders,
      payload: AuthCreatePairingCredentialInput,
      success: AuthPairingCredentialResult,
      error: EnvironmentHttpAuthErrors,
    }).middleware(EnvironmentOwnerAuth),
  )
  .add(
    HttpApiEndpoint.get("pairingLinks", "/api/auth/pairing-links", {
      headers: OptionalBearerHeaders,
      success: Schema.Array(AuthPairingLink),
      error: EnvironmentHttpAuthErrors,
    }).middleware(EnvironmentOwnerAuth),
  )
  .add(
    HttpApiEndpoint.post("revokePairingLink", "/api/auth/pairing-links/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokePairingLinkInput,
      success: AuthPairingLinkRevokeResult,
      error: EnvironmentHttpAuthErrors,
    }).middleware(EnvironmentOwnerAuth),
  )
  .add(
    HttpApiEndpoint.get("clients", "/api/auth/clients", {
      headers: OptionalBearerHeaders,
      success: Schema.Array(AuthClientSession),
      error: EnvironmentHttpAuthErrors,
    }).middleware(EnvironmentOwnerAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeClient", "/api/auth/clients/revoke", {
      headers: OptionalBearerHeaders,
      payload: AuthRevokeClientSessionInput,
      success: AuthClientSessionRevokeResult,
      error: EnvironmentHttpAuthErrors,
    }).middleware(EnvironmentOwnerAuth),
  )
  .add(
    HttpApiEndpoint.post("revokeOtherClients", "/api/auth/clients/revoke-others", {
      headers: OptionalBearerHeaders,
      success: AuthOtherClientSessionsRevokeResult,
      error: EnvironmentHttpAuthErrors,
    }).middleware(EnvironmentOwnerAuth),
  ) {}

export class EnvironmentOrchestrationHttpApi extends HttpApiGroup.make("orchestration")
  .add(
    HttpApiEndpoint.get("snapshot", "/api/orchestration/snapshot", {
      headers: OptionalBearerHeaders,
      success: OrchestrationReadModel,
      error: EnvironmentHttpOrchestrationErrors,
    }).middleware(EnvironmentOwnerAuth),
  )
  .add(
    HttpApiEndpoint.post("dispatch", "/api/orchestration/dispatch", {
      headers: OptionalBearerHeaders,
      payload: ClientOrchestrationCommand,
      success: DispatchResult,
      error: EnvironmentHttpOrchestrationErrors,
    }).middleware(EnvironmentOwnerAuth),
  ) {}

export class EnvironmentHttpApi extends HttpApi.make("environment")
  .add(EnvironmentMetadataHttpApi)
  .add(EnvironmentAuthHttpApi)
  .add(EnvironmentOrchestrationHttpApi) {}
