import * as NodeCrypto from "node:crypto";
import {
  EnvironmentCloudEndpointUnavailableError,
  EnvironmentCloudLinkStateResult,
  EnvironmentCloudRelayConfigResult,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpConflictError,
  EnvironmentHttpForbiddenError,
  EnvironmentHttpInternalServerError,
  EnvironmentHttpUnauthorizedError,
} from "@t3tools/contracts";
import {
  RelayCloudEnvironmentHealthProofPayload,
  RelayCloudEnvironmentHealthRequest,
  RelayCloudMintCredentialProofPayload,
  RelayCloudMintCredentialRequest,
  RelayEnvironmentHealthResponseProofPayload,
  type RelayEnvironmentHealthResponse as RelayEnvironmentHealthResponseShape,
  RelayEnvironmentConfigRequest,
  RelayEnvironmentMintResponseProofPayload,
  type RelayEnvironmentMintResponse as RelayEnvironmentMintResponseShape,
  RelayEnvironmentLinkProof,
  RelayEnvironmentLinkProofPayload,
  RelayLinkProofRequest,
  RelayManagedEndpointOrigin,
} from "@t3tools/contracts/relay";
import {
  normalizeRelayIssuer,
  RELAY_HEALTH_REQUEST_TYP,
  RELAY_HEALTH_RESPONSE_TYP,
  RELAY_LINK_PROOF_TYP,
  RELAY_MINT_REQUEST_TYP,
  RELAY_MINT_RESPONSE_TYP,
  signRelayJwt,
  verifyRelayJwt,
} from "@t3tools/shared/relayJwt";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as HttpEffect from "effect/unstable/http/HttpEffect";
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { failEnvironmentHttpAuthError } from "../auth/http.ts";
import { makeServerSecretStore } from "../auth/Layers/ServerSecretStore.ts";
import type { ServerSecretStoreShape } from "../auth/Services/ServerSecretStore.ts";
import { AuthControlPlane, type AuthControlPlaneShape } from "../auth/Services/AuthControlPlane.ts";
import { AuthError } from "../auth/Services/ServerAuth.ts";
import {
  ServerEnvironment,
  type ServerEnvironmentShape,
} from "../environment/Services/ServerEnvironment.ts";
import {
  CloudManagedEndpointRuntime,
  type CloudManagedEndpointRuntimeShape,
} from "./ManagedEndpointRuntime.ts";
import {
  CLOUD_ENDPOINT_RUNTIME_CONFIG,
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  encodeEndpointRuntimeConfigJson,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "./config.ts";

const CLOUD_LINK_PRIVATE_KEY = "cloud-link-ed25519-private-key";
const CLOUD_LINK_PUBLIC_KEY = "cloud-link-ed25519-public-key";
const CLOUD_MINT_NONCE_PREFIX = "cloud-mint-nonce-";
const CLOUD_MINT_JTI_PREFIX = "cloud-mint-jti-";
const CLOUD_HEALTH_NONCE_PREFIX = "cloud-health-nonce-";
const CLOUD_HEALTH_JTI_PREFIX = "cloud-health-jti-";
const CLOUD_PROOF_MAX_LIFETIME_SECONDS = 5 * 60;
const CLOUD_PROOF_CLOCK_SKEW_SECONDS = 60;
const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "::1", "localhost"]);
const CLOUD_CREDENTIAL_RESPONSE_HEADERS = {
  "cache-control": "no-store",
  pragma: "no-cache",
} as const;

const appendCloudCredentialResponseHeaders = HttpEffect.appendPreResponseHandler(
  (_request, response) =>
    Effect.succeed(HttpServerResponse.setHeaders(response, CLOUD_CREDENTIAL_RESPONSE_HEADERS)),
);

type EnvironmentCloudHttpError =
  | EnvironmentHttpBadRequestError
  | EnvironmentHttpConflictError
  | EnvironmentHttpForbiddenError
  | EnvironmentHttpInternalServerError
  | EnvironmentHttpUnauthorizedError;

const failEnvironmentCloudAuthError = (
  error: AuthError,
): Effect.Effect<never, EnvironmentCloudHttpError, HttpServerRequest.HttpServerRequest> => {
  if (error.status === 409) {
    return Effect.fail(new EnvironmentHttpConflictError({ message: error.message }));
  }
  return failEnvironmentHttpAuthError(error);
};

const failEnvironmentCloudInternalError =
  (message: string) =>
  (cause: unknown): Effect.Effect<never, EnvironmentHttpInternalServerError> =>
    Effect.logError(message, { cause }).pipe(
      Effect.flatMap(() => Effect.fail(new EnvironmentHttpInternalServerError({ message }))),
    );

function bytesToString(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes);
}

function stringToBytes(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function normalizePemForSignedPayload(value: string): string {
  return value.trim();
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[(.*)\]$/, "$1");
}

function validateCloudMintPublicKey(publicKey: string): Effect.Effect<void, AuthError> {
  return Effect.try({
    try: () => NodeCrypto.createPublicKey(publicKey.replace(/\\n/g, "\n")),
    catch: (cause) =>
      new AuthError({
        message: "Cloud mint public key must be a valid Ed25519 public key.",
        status: 400,
        cause,
      }),
  }).pipe(
    Effect.flatMap((key) =>
      key.asymmetricKeyType === "ed25519"
        ? Effect.void
        : Effect.fail(
            new AuthError({
              message: "Cloud mint public key must be a valid Ed25519 public key.",
              status: 400,
            }),
          ),
    ),
  );
}

function isSecureRelayUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.username.length === 0 &&
      url.password.length === 0 &&
      url.hash.length === 0
    );
  } catch {
    return false;
  }
}

function validateRelayConfigPayload(
  payload: RelayEnvironmentConfigRequest,
): Effect.Effect<void, AuthError> {
  if (!isSecureRelayUrl(payload.relayUrl)) {
    return Effect.fail(
      new AuthError({
        message: "Relay URL must be a secure absolute HTTPS URL.",
        status: 400,
      }),
    );
  }
  if (payload.relayIssuer !== undefined && !isSecureRelayUrl(payload.relayIssuer)) {
    return Effect.fail(
      new AuthError({
        message: "Relay issuer must be a secure absolute HTTPS URL.",
        status: 400,
      }),
    );
  }
  if (payload.environmentCredential.trim().length === 0) {
    return Effect.fail(
      new AuthError({
        message: "Relay environment credential is required.",
        status: 400,
      }),
    );
  }
  if (payload.cloudUserId.trim().length === 0) {
    return Effect.fail(
      new AuthError({
        message: "Cloud user id is required.",
        status: 400,
      }),
    );
  }
  return Effect.void;
}

function validateLinkedCloudUser(input: {
  readonly secrets: ServerSecretStoreShape;
  readonly cloudUserId: string;
}): Effect.Effect<void, AuthError> {
  return input.secrets.get(CLOUD_LINKED_USER_ID).pipe(
    Effect.flatMap((existing) => {
      if (!existing) {
        return Effect.void;
      }
      const existingCloudUserId = bytesToString(existing);
      return existingCloudUserId === input.cloudUserId
        ? Effect.void
        : Effect.fail(
            new AuthError({
              message:
                "This environment is already linked to a different cloud account. Unlink it before switching accounts.",
              status: 409,
            }),
          );
    }),
    Effect.mapError((cause) =>
      cause instanceof AuthError
        ? cause
        : new AuthError({
            message: "Could not verify the linked cloud account.",
            status: 500,
            cause,
          }),
    ),
  );
}

function readInstalledCloudUserId(
  secrets: ServerSecretStoreShape,
): Effect.Effect<string, AuthError> {
  return secrets.get(CLOUD_LINKED_USER_ID).pipe(
    Effect.flatMap((bytes) =>
      bytes
        ? Effect.succeed(bytesToString(bytes))
        : Effect.fail(
            new AuthError({
              message: "Cloud linked user is not installed for this environment.",
              status: 500,
            }),
          ),
    ),
    Effect.mapError((cause) =>
      cause instanceof AuthError
        ? cause
        : new AuthError({
            message: "Could not read the linked cloud account.",
            status: 500,
            cause,
          }),
    ),
  );
}

function isLoopbackHostname(hostname: string): boolean {
  return LOOPBACK_HOSTNAMES.has(normalizeHostname(hostname));
}

function firstForwardedHeaderValue(value: string | undefined): string | undefined {
  const first = value?.split(",")[0]?.trim();
  return first && first.length > 0 ? first : undefined;
}

function requestAbsoluteUrl(request: HttpServerRequest.HttpServerRequest): string | null {
  try {
    return new URL(request.originalUrl).href;
  } catch {
    const host = firstForwardedHeaderValue(request.headers.host) ?? "127.0.0.1";
    try {
      return new URL(request.originalUrl, `http://${host}`).href;
    } catch {
      return null;
    }
  }
}

function hasForwardedAuthorityHeaders(request: HttpServerRequest.HttpServerRequest): boolean {
  return (
    firstForwardedHeaderValue(request.headers["x-forwarded-host"]) !== undefined ||
    firstForwardedHeaderValue(request.headers["x-forwarded-proto"]) !== undefined
  );
}

function endpointRequestPort(url: URL): number {
  return Number(url.port || (url.protocol === "https:" ? 443 : 80));
}

function isAllowedEndpointOrigin(input: {
  readonly origin: RelayManagedEndpointOrigin;
  readonly requestUrl: string;
}): boolean {
  if (!isLoopbackHostname(input.origin.localHttpHost)) {
    return false;
  }

  const url = new URL(input.requestUrl);
  if (!isLoopbackHostname(url.hostname)) {
    return false;
  }

  return input.origin.localHttpPort === endpointRequestPort(url);
}

function providerKindMatchesRequestedLinkScopes(request: RelayLinkProofRequest): boolean {
  return request.endpoint.providerKind === "cloudflare_tunnel";
}

function hasExactScope(input: {
  readonly scopes: ReadonlyArray<string>;
  readonly expected: string;
}): boolean {
  return input.scopes.length === 1 && input.scopes[0] === input.expected;
}

function hasBoundedCloudProofLifetime(input: {
  readonly iat: number;
  readonly exp: number;
  readonly nowSeconds: number;
}): boolean {
  return (
    input.exp > input.iat &&
    input.exp - input.iat <= CLOUD_PROOF_MAX_LIFETIME_SECONDS &&
    input.iat <= input.nowSeconds + CLOUD_PROOF_CLOCK_SKEW_SECONDS
  );
}

const decodeCloudHealthProof = Schema.decodeUnknownEffect(RelayCloudEnvironmentHealthProofPayload);
const decodeCloudMintProof = Schema.decodeUnknownEffect(RelayCloudMintCredentialProofPayload);

export const getOrCreateEnvironmentKeyPairFromSecretStore = Effect.fn(function* (
  secrets: ServerSecretStoreShape,
) {
  const existingPrivate = yield* secrets.get(CLOUD_LINK_PRIVATE_KEY);
  const existingPublic = yield* secrets.get(CLOUD_LINK_PUBLIC_KEY);
  if (existingPrivate && existingPublic) {
    return {
      privateKey: bytesToString(existingPrivate),
      publicKey: bytesToString(existingPublic),
    };
  }

  const keyPair = NodeCrypto.generateKeyPairSync("ed25519", {
    privateKeyEncoding: { format: "pem", type: "pkcs8" },
    publicKeyEncoding: { format: "pem", type: "spki" },
  });
  yield* secrets.set(CLOUD_LINK_PRIVATE_KEY, stringToBytes(keyPair.privateKey));
  yield* secrets.set(CLOUD_LINK_PUBLIC_KEY, stringToBytes(keyPair.publicKey));
  return {
    privateKey: keyPair.privateKey,
    publicKey: keyPair.publicKey,
  };
});

interface CloudHttpDependencies {
  readonly secrets: ServerSecretStoreShape;
  readonly environment: ServerEnvironmentShape;
  readonly endpointRuntime: CloudManagedEndpointRuntimeShape;
  readonly authControlPlane: AuthControlPlaneShape;
}

const cloudLinkProofHandler = Effect.fn("environment.cloud.linkProof")(
  function* (dependencies: CloudHttpDependencies, request: RelayLinkProofRequest) {
    const httpRequest = yield* HttpServerRequest.HttpServerRequest;
    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(dependencies.secrets);
    const requestUrl = requestAbsoluteUrl(httpRequest);
    if (
      requestUrl === null ||
      hasForwardedAuthorityHeaders(httpRequest) ||
      !providerKindMatchesRequestedLinkScopes(request) ||
      !isAllowedEndpointOrigin({
        origin: request.origin,
        requestUrl,
      })
    ) {
      return yield* new AuthError({
        message: "Invalid managed endpoint origin.",
        status: 400,
      });
    }
    const now = yield* DateTime.now;
    const expiresAt = DateTime.add(now, { minutes: 5 });
    const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const descriptor = yield* dependencies.environment.getDescriptor;
    const payload = {
      iss: `t3-env:${descriptor.environmentId}`,
      aud: normalizeRelayIssuer(request.relayIssuer),
      sub: descriptor.environmentId,
      jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
      iat: nowSeconds,
      exp: Math.floor(expiresAt.epochMilliseconds / 1_000),
      challenge: request.challenge,
      descriptor,
      environmentId: descriptor.environmentId,
      environmentPublicKey: normalizePemForSignedPayload(keyPair.publicKey),
      endpoint: request.endpoint,
      origin: request.origin,
      scopes: ["agent_activity_notifications", "managed_tunnels"],
    } satisfies RelayEnvironmentLinkProofPayload;
    const proof = yield* signRelayJwt({
      privateKey: keyPair.privateKey,
      typ: RELAY_LINK_PROOF_TYP,
      payload,
    }).pipe(
      Effect.mapError(
        (cause) => new AuthError({ message: "Failed to sign cloud link JWT.", status: 500, cause }),
      ),
    );
    yield* appendCloudCredentialResponseHeaders;
    return proof satisfies RelayEnvironmentLinkProof;
  },
  Effect.catchTag("AuthError", failEnvironmentCloudAuthError),
  Effect.catchTags({
    PlatformError: failEnvironmentCloudInternalError("Could not generate environment link proof."),
    SecretStoreError: failEnvironmentCloudInternalError(
      "Could not generate environment link proof.",
    ),
  }),
);

const cloudRelayConfigHandler = Effect.fn("environment.cloud.relayConfig")(
  function* (dependencies: CloudHttpDependencies, payload: RelayEnvironmentConfigRequest) {
    yield* validateRelayConfigPayload(payload);
    yield* validateLinkedCloudUser({
      secrets: dependencies.secrets,
      cloudUserId: payload.cloudUserId,
    });
    yield* validateCloudMintPublicKey(payload.cloudMintPublicKey);
    const endpointRuntimeStatus = yield* dependencies.endpointRuntime.applyConfig(
      payload.endpointRuntime,
    );
    const ok =
      endpointRuntimeStatus.status === "disabled" || endpointRuntimeStatus.status === "running";
    if (!ok) {
      return yield* new EnvironmentCloudEndpointUnavailableError({
        message: "Managed endpoint runtime could not be started.",
        endpointRuntimeStatus,
      });
    }

    yield* dependencies.secrets.set(RELAY_URL_SECRET, stringToBytes(payload.relayUrl));
    yield* dependencies.secrets.set(
      RELAY_ISSUER_SECRET,
      stringToBytes(payload.relayIssuer ?? payload.relayUrl),
    );
    yield* dependencies.secrets.set(CLOUD_LINKED_USER_ID, stringToBytes(payload.cloudUserId));
    yield* dependencies.secrets.set(
      RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
      stringToBytes(payload.environmentCredential),
    );
    yield* dependencies.secrets.set(
      CLOUD_MINT_PUBLIC_KEY,
      stringToBytes(payload.cloudMintPublicKey),
    );
    if (payload.endpointRuntime) {
      const endpointRuntimeJson = yield* encodeEndpointRuntimeConfigJson(payload.endpointRuntime);
      yield* dependencies.secrets.set(
        CLOUD_ENDPOINT_RUNTIME_CONFIG,
        stringToBytes(endpointRuntimeJson),
      );
    } else {
      yield* dependencies.secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG);
    }
    return { ok, endpointRuntimeStatus } satisfies EnvironmentCloudRelayConfigResult;
  },
  Effect.catchTag("AuthError", failEnvironmentCloudAuthError),
  Effect.catchTags({
    SchemaError: failEnvironmentCloudInternalError(
      "Could not persist environment relay configuration.",
    ),
    SecretStoreError: failEnvironmentCloudInternalError(
      "Could not persist environment relay configuration.",
    ),
  }),
);

const cloudLinkStateHandler = Effect.fn("environment.cloud.linkState")(
  function* (dependencies: CloudHttpDependencies) {
    const [cloudUserId, relayUrl, relayIssuer] = yield* Effect.all(
      [
        dependencies.secrets.get(CLOUD_LINKED_USER_ID),
        dependencies.secrets.get(RELAY_URL_SECRET),
        dependencies.secrets.get(RELAY_ISSUER_SECRET),
      ],
      { concurrency: 3 },
    );
    const response = {
      linked: cloudUserId !== null,
      cloudUserId: cloudUserId ? bytesToString(cloudUserId) : null,
      relayUrl: relayUrl ? bytesToString(relayUrl) : null,
      relayIssuer: relayIssuer ? bytesToString(relayIssuer) : null,
    } satisfies EnvironmentCloudLinkStateResult;
    return response;
  },
  Effect.catchTag(
    "SecretStoreError",
    failEnvironmentCloudInternalError("Could not read environment relay configuration."),
  ),
);

const cloudUnlinkHandler = Effect.fn("environment.cloud.unlink")(
  function* (dependencies: CloudHttpDependencies) {
    const endpointRuntimeStatus = yield* dependencies.endpointRuntime.applyConfig(null);
    yield* Effect.all(
      [
        dependencies.secrets.remove(CLOUD_LINKED_USER_ID),
        dependencies.secrets.remove(RELAY_URL_SECRET),
        dependencies.secrets.remove(RELAY_ISSUER_SECRET),
        dependencies.secrets.remove(RELAY_ENVIRONMENT_CREDENTIAL_SECRET),
        dependencies.secrets.remove(CLOUD_MINT_PUBLIC_KEY),
        dependencies.secrets.remove(CLOUD_ENDPOINT_RUNTIME_CONFIG),
      ],
      { concurrency: 6 },
    );
    return { ok: true, endpointRuntimeStatus } satisfies EnvironmentCloudRelayConfigResult;
  },
  Effect.catchTag(
    "SecretStoreError",
    failEnvironmentCloudInternalError("Could not remove environment relay configuration."),
  ),
);

const cloudEnvironmentHealthHandler = Effect.fn("environment.cloud.health")(
  function* (dependencies: CloudHttpDependencies, request: RelayCloudEnvironmentHealthRequest) {
    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(dependencies.secrets);
    const cloudMintPublicKey = yield* dependencies.secrets.get(CLOUD_MINT_PUBLIC_KEY).pipe(
      Effect.flatMap((bytes) =>
        bytes
          ? Effect.succeed(bytesToString(bytes))
          : Effect.fail(
              new AuthError({
                message: "Cloud mint public key is not installed for this environment.",
                status: 500,
              }),
            ),
      ),
    );
    const relayIssuer = yield* dependencies.secrets.get(RELAY_ISSUER_SECRET).pipe(
      Effect.flatMap((bytes) =>
        bytes
          ? Effect.succeed(bytesToString(bytes))
          : dependencies.secrets.get(RELAY_URL_SECRET).pipe(
              Effect.flatMap((fallbackBytes) =>
                fallbackBytes
                  ? Effect.succeed(bytesToString(fallbackBytes))
                  : Effect.fail(
                      new AuthError({
                        message: "Cloud relay issuer is not installed for this environment.",
                        status: 500,
                      }),
                    ),
              ),
            ),
      ),
    );
    const environmentId = yield* dependencies.environment.getEnvironmentId;
    const linkedCloudUserId = yield* readInstalledCloudUserId(dependencies.secrets);
    const now = yield* DateTime.now;
    const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const proofOption = yield* verifyRelayJwt({
      publicKey: cloudMintPublicKey,
      token: request.proof,
      typ: RELAY_HEALTH_REQUEST_TYP,
      issuer: normalizeRelayIssuer(relayIssuer),
      audience: `t3-env:${environmentId}`,
      nowEpochSeconds: nowSeconds,
    }).pipe(Effect.flatMap(decodeCloudHealthProof), Effect.option);
    if (
      Option.isNone(proofOption) ||
      proofOption.value.environmentId !== environmentId ||
      proofOption.value.sub !== linkedCloudUserId ||
      !hasBoundedCloudProofLifetime({ ...proofOption.value, nowSeconds }) ||
      !hasExactScope({ scopes: proofOption.value.scope, expected: "environment:status" })
    ) {
      return yield* new AuthError({
        message: "Invalid cloud health request.",
        status: 401,
      });
    }
    const proof = proofOption.value;

    const jtiSecretName = `${CLOUD_HEALTH_JTI_PREFIX}${proof.jti}`;
    const nonceSecretName = `${CLOUD_HEALTH_NONCE_PREFIX}${proof.nonce}`;
    const consumedReplayGuards = yield* Effect.all(
      [
        dependencies.secrets.create(jtiSecretName, stringToBytes(DateTime.formatIso(now))),
        dependencies.secrets.create(nonceSecretName, stringToBytes(DateTime.formatIso(now))),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.as(true),
      Effect.catchTag("SecretStoreError", () => Effect.succeed(false)),
    );
    if (!consumedReplayGuards) {
      return yield* new AuthError({
        message: "Cloud health request was already consumed.",
        status: 409,
      });
    }

    const descriptor = yield* dependencies.environment.getDescriptor;
    const responseExpiresAt = DateTime.add(now, { minutes: 5 });
    const responsePayload = {
      iss: `t3-env:${environmentId}`,
      aud: normalizeRelayIssuer(relayIssuer),
      sub: environmentId,
      jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
      iat: nowSeconds,
      exp: Math.floor(responseExpiresAt.epochMilliseconds / 1_000),
      environmentId,
      requestNonce: proof.nonce,
      status: "online",
      descriptor,
      checkedAt: DateTime.formatIso(now),
    } satisfies RelayEnvironmentHealthResponseProofPayload;
    const responseProof = yield* signRelayJwt({
      privateKey: keyPair.privateKey,
      typ: RELAY_HEALTH_RESPONSE_TYP,
      payload: responsePayload,
    }).pipe(
      Effect.mapError(
        (cause) =>
          new AuthError({ message: "Failed to sign cloud health JWT.", status: 500, cause }),
      ),
    );
    const response = {
      environmentId,
      status: "online",
      descriptor,
      checkedAt: responsePayload.checkedAt,
      proof: responseProof,
    } satisfies RelayEnvironmentHealthResponseShape;

    yield* appendCloudCredentialResponseHeaders;
    return response;
  },
  Effect.catchTag("AuthError", failEnvironmentCloudAuthError),
  Effect.catchTags({
    PlatformError: failEnvironmentCloudInternalError("Could not answer cloud health request."),
    SecretStoreError: failEnvironmentCloudInternalError("Could not answer cloud health request."),
  }),
);

const cloudMintCredentialHandler = Effect.fn("environment.cloud.mintCredential")(
  function* (dependencies: CloudHttpDependencies, request: RelayCloudMintCredentialRequest) {
    const keyPair = yield* getOrCreateEnvironmentKeyPairFromSecretStore(dependencies.secrets);
    const cloudMintPublicKey = yield* dependencies.secrets.get(CLOUD_MINT_PUBLIC_KEY).pipe(
      Effect.flatMap((bytes) =>
        bytes
          ? Effect.succeed(bytesToString(bytes))
          : Effect.fail(
              new AuthError({
                message: "Cloud mint public key is not installed for this environment.",
                status: 500,
              }),
            ),
      ),
    );
    const relayIssuer = yield* dependencies.secrets.get(RELAY_ISSUER_SECRET).pipe(
      Effect.flatMap((bytes) =>
        bytes
          ? Effect.succeed(bytesToString(bytes))
          : dependencies.secrets.get(RELAY_URL_SECRET).pipe(
              Effect.flatMap((fallbackBytes) =>
                fallbackBytes
                  ? Effect.succeed(bytesToString(fallbackBytes))
                  : Effect.fail(
                      new AuthError({
                        message: "Cloud relay issuer is not installed for this environment.",
                        status: 500,
                      }),
                    ),
              ),
            ),
      ),
    );
    const environmentId = yield* dependencies.environment.getEnvironmentId;
    const linkedCloudUserId = yield* readInstalledCloudUserId(dependencies.secrets);
    const now = yield* DateTime.now;
    const nowSeconds = Math.floor(now.epochMilliseconds / 1_000);
    const proofOption = yield* verifyRelayJwt({
      publicKey: cloudMintPublicKey,
      token: request.proof,
      typ: RELAY_MINT_REQUEST_TYP,
      issuer: normalizeRelayIssuer(relayIssuer),
      audience: `t3-env:${environmentId}`,
      nowEpochSeconds: nowSeconds,
    }).pipe(Effect.flatMap(decodeCloudMintProof), Effect.option);
    if (
      Option.isNone(proofOption) ||
      proofOption.value.environmentId !== environmentId ||
      proofOption.value.sub !== linkedCloudUserId ||
      proofOption.value.cnf.jkt !== proofOption.value.clientProofKeyThumbprint ||
      !hasBoundedCloudProofLifetime({ ...proofOption.value, nowSeconds }) ||
      !hasExactScope({ scopes: proofOption.value.scope, expected: "environment:connect" })
    ) {
      return yield* new AuthError({
        message: "Invalid cloud mint request.",
        status: 401,
      });
    }
    const proof = proofOption.value;

    const jtiSecretName = `${CLOUD_MINT_JTI_PREFIX}${proof.jti}`;
    const nonceSecretName = `${CLOUD_MINT_NONCE_PREFIX}${proof.nonce}`;
    const consumedReplayGuards = yield* Effect.all(
      [
        dependencies.secrets.create(jtiSecretName, stringToBytes(DateTime.formatIso(now))),
        dependencies.secrets.create(nonceSecretName, stringToBytes(DateTime.formatIso(now))),
      ],
      { concurrency: 2 },
    ).pipe(
      Effect.as(true),
      Effect.catchTag("SecretStoreError", () => Effect.succeed(false)),
    );
    if (!consumedReplayGuards) {
      return yield* new AuthError({
        message: "Cloud mint request was already consumed.",
        status: 409,
      });
    }

    const issued = yield* dependencies.authControlPlane.createPairingLink({
      role: "client",
      subject: "cloud-connect",
      ttl: Duration.minutes(2),
      label: "T3 Cloud connect",
      proofKeyThumbprint: proof.clientProofKeyThumbprint,
    });
    const responsePayload = {
      iss: `t3-env:${environmentId}`,
      aud: normalizeRelayIssuer(relayIssuer),
      sub: environmentId,
      jti: yield* Crypto.Crypto.pipe(Effect.flatMap((crypto) => crypto.randomUUIDv4)),
      iat: nowSeconds,
      exp: Math.floor(issued.expiresAt.epochMilliseconds / 1_000),
      environmentId,
      clientProofKeyThumbprint: proof.clientProofKeyThumbprint,
      requestNonce: proof.nonce,
      credential: issued.credential,
    } satisfies RelayEnvironmentMintResponseProofPayload;
    const responseProof = yield* signRelayJwt({
      privateKey: keyPair.privateKey,
      typ: RELAY_MINT_RESPONSE_TYP,
      payload: responsePayload,
    }).pipe(
      Effect.mapError(
        (cause) => new AuthError({ message: "Failed to sign cloud mint JWT.", status: 500, cause }),
      ),
    );
    const response = {
      credential: issued.credential,
      expiresAt: DateTime.formatIso(issued.expiresAt),
      proof: responseProof,
    } satisfies RelayEnvironmentMintResponseShape;

    yield* appendCloudCredentialResponseHeaders;
    return response;
  },
  Effect.catchTag("AuthError", failEnvironmentCloudAuthError),
  Effect.catchTags({
    AuthControlPlaneError: failEnvironmentCloudInternalError(
      "Could not issue cloud connection credential.",
    ),
    PlatformError: failEnvironmentCloudInternalError(
      "Could not issue cloud connection credential.",
    ),
    SecretStoreError: failEnvironmentCloudInternalError(
      "Could not issue cloud connection credential.",
    ),
  }),
);

export const cloudHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "cloud",
  Effect.fnUntraced(function* (handlers) {
    const dependencies: CloudHttpDependencies = {
      secrets: yield* makeServerSecretStore,
      environment: yield* ServerEnvironment,
      endpointRuntime: yield* CloudManagedEndpointRuntime,
      authControlPlane: yield* AuthControlPlane,
    };
    return handlers
      .handle("linkProof", ({ payload }) => cloudLinkProofHandler(dependencies, payload))
      .handle("relayConfig", ({ payload }) => cloudRelayConfigHandler(dependencies, payload))
      .handle("linkState", () => cloudLinkStateHandler(dependencies))
      .handle("unlink", () => cloudUnlinkHandler(dependencies))
      .handle("health", ({ payload }) => cloudEnvironmentHealthHandler(dependencies, payload))
      .handle("mintCredential", ({ payload }) => cloudMintCredentialHandler(dependencies, payload))
      .handle("t3MintCredential", ({ payload }) =>
        cloudMintCredentialHandler(dependencies, payload),
      );
  }),
);
