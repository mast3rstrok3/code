import {
  AppDevStack,
  AppDevStackAutoCreateResult,
  AppDevStackByWorktreeResult,
  AppDevStackDeleteResult,
  AppDevStackError,
  AppDevStackGetPodLogsResult,
  AppDevStackListResult,
  type AppDevStackAutoCreateInput,
  type AppDevStackBackendStatus,
  type AppDevStackGetPodLogsInput,
  type AppDevStackGetInput,
  type AppDevStackListPodsInput,
  type AppDevStackListInput,
  AppDevStackListPodsResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import { makeKubectlRunner, makeNativeAppDevStackService } from "./NativeAppDevStackManager.ts";

const BACKEND_TOKEN_ENV = "T3CODE_APP_DEV_STACK_BACKEND_BEARER_TOKEN";
const OIDC_TOKEN_URL_ENV = "T3CODE_APP_DEV_STACK_BACKEND_OIDC_TOKEN_URL";
const OIDC_ISSUER_ENV = "T3CODE_APP_DEV_STACK_BACKEND_OIDC_ISSUER";
const OIDC_CLIENT_ID_ENV = "T3CODE_APP_DEV_STACK_BACKEND_OIDC_CLIENT_ID";
const OIDC_CLIENT_SECRET_ENV = "T3CODE_APP_DEV_STACK_BACKEND_OIDC_CLIENT_SECRET";
const CODE_OIDC_ISSUER_ENV = "CODE_OIDC_ISSUER";
const CODE_OIDC_CLIENT_ID_ENV = "CODE_OIDC_CLIENT_ID";
const CODE_OIDC_CLIENT_SECRET_ENV = "CODE_OIDC_CLIENT_SECRET";
const OIDC_REFRESH_EARLY_MS = 60_000;
const DISABLED_MESSAGE =
  "App Dev Stack handling is not configured. Enable T3CODE_APP_DEV_STACK_NATIVE_ENABLED or set T3CODE_APP_DEV_STACK_BACKEND_URL to a controller API that serves /api/app-dev-stacks.";

const OAuthTokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.optional(Schema.Number),
  token_type: Schema.optional(Schema.String),
});

export class AppDevStackManager extends Context.Service<
  AppDevStackManager,
  {
    readonly status: Effect.Effect<AppDevStackBackendStatus>;
    readonly list: (
      input: AppDevStackListInput,
    ) => Effect.Effect<AppDevStackListResult, AppDevStackError>;
    readonly getByWorktree: (input: {
      readonly worktreePath: string;
    }) => Effect.Effect<AppDevStackByWorktreeResult, AppDevStackError>;
    readonly get: (input: AppDevStackGetInput) => Effect.Effect<AppDevStack, AppDevStackError>;
    readonly autoCreate: (
      input: AppDevStackAutoCreateInput,
    ) => Effect.Effect<AppDevStackAutoCreateResult, AppDevStackError>;
    readonly stop: (input: AppDevStackGetInput) => Effect.Effect<AppDevStack, AppDevStackError>;
    readonly delete: (
      input: AppDevStackGetInput,
    ) => Effect.Effect<AppDevStackDeleteResult, AppDevStackError>;
    readonly listPods: (
      input: AppDevStackListPodsInput,
    ) => Effect.Effect<AppDevStackListPodsResult, AppDevStackError>;
    readonly getPodLogs: (
      input: AppDevStackGetPodLogsInput,
    ) => Effect.Effect<AppDevStackGetPodLogsResult, AppDevStackError>;
  }
>()("t3/appDevStack/AppDevStackManager") {
  static readonly layer = Layer.effect(
    AppDevStackManager,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;

      if (config.appDevStackNative !== undefined) {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        return AppDevStackManager.of(
          makeNativeAppDevStackService(
            config.appDevStackNative,
            makeKubectlRunner(config.appDevStackNative.kubectlPath, spawner),
          ),
        );
      }

      const baseUrl = config.appDevStackBackendUrl?.href.replace(/\/+$/u, "") ?? null;
      const bearerToken =
        config.appDevStackBackendBearerToken === undefined
          ? null
          : Redacted.value(config.appDevStackBackendBearerToken);
      const oidcConfig =
        config.appDevStackBackendOidcTokenUrl !== undefined &&
        config.appDevStackBackendOidcClientId !== undefined &&
        config.appDevStackBackendOidcClientSecret !== undefined
          ? {
              tokenUrl: config.appDevStackBackendOidcTokenUrl.href,
              clientId: config.appDevStackBackendOidcClientId,
              clientSecret: Redacted.value(config.appDevStackBackendOidcClientSecret),
            }
          : null;
      let cachedOidcToken: {
        readonly accessToken: string;
        readonly expiresAtEpochMs: number;
      } | null = null;

      const status = Effect.succeed({
        enabled: baseUrl !== null,
        backendUrl: baseUrl,
      });

      const requireBaseUrl = (operation: string) =>
        baseUrl === null
          ? Effect.fail(
              new AppDevStackError({
                operation,
                reason: "disabled",
                message: DISABLED_MESSAGE,
              }),
            )
          : Effect.succeed(baseUrl);

      const appDevStackUrl = (base: string, path: string) => `${base}/api/app-dev-stacks${path}`;

      const oidcConfigDescription = () =>
        `${OIDC_TOKEN_URL_ENV} or ${OIDC_ISSUER_ENV}, ${OIDC_CLIENT_ID_ENV}, and ${OIDC_CLIENT_SECRET_ENV} (or ${CODE_OIDC_ISSUER_ENV}, ${CODE_OIDC_CLIENT_ID_ENV}, and ${CODE_OIDC_CLIENT_SECRET_ENV})`;

      const tokenRequestMessage = (response: HttpClientResponse.HttpClientResponse) =>
        response.text.pipe(
          Effect.map((body) => {
            const trimmed = body.trim();
            return trimmed.length > 0
              ? `App Dev Stack OIDC token endpoint responded with ${response.status}: ${trimmed}`
              : `App Dev Stack OIDC token endpoint responded with ${response.status}.`;
          }),
          Effect.orElseSucceed(
            () => `App Dev Stack OIDC token endpoint responded with ${response.status}.`,
          ),
        );

      const getOidcAccessToken = Effect.fn("AppDevStackManager.getOidcAccessToken")(function* () {
        if (oidcConfig === null) {
          return yield* new AppDevStackError({
            operation: "authenticate",
            reason: "request_failed",
            message: `App Dev Stack backend auth is not configured. Set ${BACKEND_TOKEN_ENV} or configure ${oidcConfigDescription()}.`,
          });
        }

        const now = yield* Clock.currentTimeMillis;
        if (
          cachedOidcToken !== null &&
          cachedOidcToken.expiresAtEpochMs - OIDC_REFRESH_EARLY_MS > now
        ) {
          return cachedOidcToken.accessToken;
        }

        const response = yield* HttpClientRequest.post(oidcConfig.tokenUrl).pipe(
          HttpClientRequest.bodyUrlParams({
            grant_type: "client_credentials",
            client_id: oidcConfig.clientId,
            client_secret: oidcConfig.clientSecret,
          }),
          httpClient.execute,
          Effect.mapError(
            (cause) =>
              new AppDevStackError({
                operation: "authenticate",
                reason: "request_failed",
                message: "Failed to reach App Dev Stack OIDC token endpoint.",
                cause,
              }),
          ),
        );
        if (response.status < 200 || response.status >= 300) {
          return yield* tokenRequestMessage(response).pipe(
            Effect.flatMap((message) =>
              Effect.fail(
                new AppDevStackError({
                  operation: "authenticate",
                  reason: "request_failed",
                  status: response.status,
                  message,
                }),
              ),
            ),
          );
        }

        const token = yield* HttpClientResponse.schemaBodyJson(OAuthTokenResponse)(response).pipe(
          Effect.mapError(
            (cause) =>
              new AppDevStackError({
                operation: "authenticate",
                reason: "invalid_response",
                status: response.status,
                message: "Failed to decode App Dev Stack OIDC token response.",
                cause,
              }),
          ),
        );
        const accessToken = token.access_token.trim();
        if (accessToken.length === 0) {
          return yield* new AppDevStackError({
            operation: "authenticate",
            reason: "invalid_response",
            status: response.status,
            message: "App Dev Stack OIDC token response did not include an access token.",
          });
        }
        cachedOidcToken = {
          accessToken,
          expiresAtEpochMs: now + Math.max(token.expires_in ?? 300, 1) * 1_000,
        };
        return accessToken;
      });

      const authorizeBackendRequest = (request: HttpClientRequest.HttpClientRequest) => {
        if (bearerToken !== null) {
          return Effect.succeed(request.pipe(HttpClientRequest.bearerToken(bearerToken)));
        }
        if (oidcConfig === null) {
          return Effect.succeed(request);
        }
        return getOidcAccessToken().pipe(
          Effect.map((token) => request.pipe(HttpClientRequest.bearerToken(token))),
        );
      };

      const unauthorizedMessage = () =>
        bearerToken !== null
          ? `App Dev Stack backend responded with 401. The configured ${BACKEND_TOKEN_ENV} was rejected or expired; refresh it on the server.`
          : oidcConfig !== null
            ? `App Dev Stack backend responded with 401. The service token minted from the configured OIDC client credentials was rejected; check ${oidcConfigDescription()}.`
            : `App Dev Stack backend responded with 401. Set ${BACKEND_TOKEN_ENV} or configure ${oidcConfigDescription()}.`;

      const responseMessage = (response: HttpClientResponse.HttpClientResponse) =>
        response.text.pipe(
          Effect.map((body) => {
            const trimmed = body.trim();
            if (response.status === 401) {
              const message = unauthorizedMessage();
              return trimmed.length > 0 ? `${message} Backend response: ${trimmed}` : message;
            }
            return trimmed.length > 0
              ? `App Dev Stack backend responded with ${response.status}: ${trimmed}`
              : `App Dev Stack backend responded with ${response.status}.`;
          }),
          Effect.orElseSucceed(() =>
            response.status === 401
              ? unauthorizedMessage()
              : `App Dev Stack backend responded with ${response.status}.`,
          ),
        );

      const decodeResponse = <S extends Schema.Top>(
        operation: string,
        schema: S,
        response: HttpClientResponse.HttpClientResponse,
      ): Effect.Effect<S["Type"], AppDevStackError, S["DecodingServices"]> => {
        if (response.status < 200 || response.status >= 300) {
          return responseMessage(response).pipe(
            Effect.flatMap((message) =>
              Effect.fail(
                new AppDevStackError({
                  operation,
                  reason: "request_failed",
                  status: response.status,
                  message,
                }),
              ),
            ),
          );
        }
        return HttpClientResponse.schemaBodyJson(schema)(response).pipe(
          Effect.mapError(
            (cause) =>
              new AppDevStackError({
                operation,
                reason: "invalid_response",
                status: response.status,
                message: "Failed to decode App Dev Stack backend response.",
                cause,
              }),
          ),
        );
      };

      const executeJson = <S extends Schema.Top>(
        operation: string,
        request: HttpClientRequest.HttpClientRequest,
        schema: S,
      ): Effect.Effect<S["Type"], AppDevStackError, S["DecodingServices"]> =>
        authorizeBackendRequest(request).pipe(
          Effect.flatMap((authorizedRequest) =>
            httpClient.execute(authorizedRequest.pipe(HttpClientRequest.acceptJson)).pipe(
              Effect.mapError(
                (cause) =>
                  new AppDevStackError({
                    operation,
                    reason: "request_failed",
                    message: "Failed to reach App Dev Stack backend.",
                    cause,
                  }),
              ),
            ),
          ),
          Effect.flatMap((response) => decodeResponse(operation, schema, response)),
        );

      const executeEmpty = (
        operation: string,
        request: HttpClientRequest.HttpClientRequest,
      ): Effect.Effect<AppDevStackDeleteResult, AppDevStackError> =>
        authorizeBackendRequest(request).pipe(
          Effect.flatMap((authorizedRequest) =>
            httpClient.execute(authorizedRequest.pipe(HttpClientRequest.acceptJson)).pipe(
              Effect.mapError(
                (cause) =>
                  new AppDevStackError({
                    operation,
                    reason: "request_failed",
                    message: "Failed to reach App Dev Stack backend.",
                    cause,
                  }),
              ),
            ),
          ),
          Effect.flatMap((response) =>
            response.status >= 200 && response.status < 300
              ? Effect.succeed({ deleted: true as const })
              : responseMessage(response).pipe(
                  Effect.flatMap((message) =>
                    Effect.fail(
                      new AppDevStackError({
                        operation,
                        reason: "request_failed",
                        status: response.status,
                        message,
                      }),
                    ),
                  ),
                ),
          ),
        );

      const list = Effect.fn("AppDevStackManager.list")(function* (input: AppDevStackListInput) {
        const base = yield* requireBaseUrl("list");
        const url = new URL(appDevStackUrl(base, ""));
        const userId = input.userId?.trim();
        if (userId) {
          url.searchParams.set("userId", userId);
        }
        const stacks = yield* executeJson(
          "list",
          HttpClientRequest.get(url.toString()),
          Schema.Array(AppDevStack),
        );
        return { stacks };
      });

      const getByWorktree = Effect.fn("AppDevStackManager.getByWorktree")(function* (input: {
        readonly worktreePath: string;
      }) {
        const base = yield* requireBaseUrl("getByWorktree");
        const url = new URL(appDevStackUrl(base, "/by-worktree"));
        url.searchParams.set("worktreePath", input.worktreePath);
        return yield* executeJson(
          "getByWorktree",
          HttpClientRequest.get(url.toString()),
          AppDevStackByWorktreeResult,
        );
      });

      const get = Effect.fn("AppDevStackManager.get")(function* (input: AppDevStackGetInput) {
        const base = yield* requireBaseUrl("get");
        return yield* executeJson(
          "get",
          HttpClientRequest.get(appDevStackUrl(base, `/${encodeURIComponent(input.stackId)}`)),
          AppDevStack,
        );
      });

      const autoCreate = Effect.fn("AppDevStackManager.autoCreate")(function* (
        input: AppDevStackAutoCreateInput,
      ) {
        const base = yield* requireBaseUrl("autoCreate");
        return yield* executeJson(
          "autoCreate",
          HttpClientRequest.post(appDevStackUrl(base, "/auto-create")).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              worktree_path: input.worktreePath,
              display_name: input.displayName,
              git_branch: input.gitBranch ?? null,
            }),
          ),
          AppDevStackAutoCreateResult,
        );
      });

      const stop = Effect.fn("AppDevStackManager.stop")(function* (input: AppDevStackGetInput) {
        const base = yield* requireBaseUrl("stop");
        return yield* executeJson(
          "stop",
          HttpClientRequest.post(
            appDevStackUrl(base, `/${encodeURIComponent(input.stackId)}/stop`),
          ),
          AppDevStack,
        );
      });

      const deleteStack = Effect.fn("AppDevStackManager.delete")(function* (
        input: AppDevStackGetInput,
      ) {
        const base = yield* requireBaseUrl("delete");
        return yield* executeEmpty(
          "delete",
          HttpClientRequest.delete(appDevStackUrl(base, `/${encodeURIComponent(input.stackId)}`)),
        );
      });

      const listPods = Effect.fn("AppDevStackManager.listPods")(function* (
        input: AppDevStackListPodsInput,
      ) {
        const base = yield* requireBaseUrl("listPods");
        return yield* executeJson(
          "listPods",
          HttpClientRequest.get(appDevStackUrl(base, `/${encodeURIComponent(input.stackId)}/pods`)),
          AppDevStackListPodsResult,
        );
      });

      const getPodLogs = Effect.fn("AppDevStackManager.getPodLogs")(function* (
        input: AppDevStackGetPodLogsInput,
      ) {
        const base = yield* requireBaseUrl("getPodLogs");
        const url = new URL(
          appDevStackUrl(
            base,
            `/${encodeURIComponent(input.stackId)}/pods/${encodeURIComponent(input.podName)}/logs`,
          ),
        );
        const containerName = input.containerName?.trim();
        if (containerName) {
          url.searchParams.set("containerName", containerName);
        }
        if (input.tailLines !== undefined) {
          url.searchParams.set("tailLines", String(input.tailLines));
        }
        return yield* executeJson(
          "getPodLogs",
          HttpClientRequest.get(url.toString()),
          AppDevStackGetPodLogsResult,
        );
      });

      return AppDevStackManager.of({
        status,
        list,
        getByWorktree,
        get,
        autoCreate,
        stop,
        delete: deleteStack,
        listPods,
        getPodLogs,
      });
    }),
  );
}
