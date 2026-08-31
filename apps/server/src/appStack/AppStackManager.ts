import {
  AppStack,
  AppStackAutoCreateResult,
  AppStackByWorktreeResult,
  AppStackDeleteResult,
  AppStackError,
  type AppStackGetAllStackPodLogsInput,
  type AppStackGetAllStackPodLogsResult,
  AppStackGetPodLogsResult,
  type AppStackGetStackPodLogsResult,
  AppStackListResult,
  type AppStackAutoCreateInput,
  type AppStackBackendStatus,
  type AppStackGetPodLogsInput,
  type AppStackGetStackPodLogsInput,
  type AppStackGetInput,
  type AppStackListPodsInput,
  type AppStackListInput,
  AppStackListPodsResult,
  type AppStackPod,
  type AppStackPodContainer,
  type AppStackPodLogEntry,
  type AppStackSetProtectedInput,
  type AppStackWorkflowTeardownInput,
  AppStackWorkflowTeardownResult,
  type AppStackVariant,
} from "@t3tools/contracts";
import { appStackVariantForComposePath } from "@t3tools/shared/appStack";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import * as SynchronizedRef from "effect/SynchronizedRef";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";
import { ChildProcessSpawner } from "effect/unstable/process";

import * as ServerConfig from "../config.ts";
import {
  makeKubectlRunner,
  makeNativeAppStackService,
  makeNativeCommandRunner,
} from "./NativeAppStackManager.ts";

const BACKEND_TOKEN_ENV = "T3CODE_APP_STACK_BACKEND_BEARER_TOKEN";
const OIDC_TOKEN_URL_ENV = "T3CODE_APP_STACK_BACKEND_OIDC_TOKEN_URL";
const OIDC_ISSUER_ENV = "T3CODE_APP_STACK_BACKEND_OIDC_ISSUER";
const OIDC_CLIENT_ID_ENV = "T3CODE_APP_STACK_BACKEND_OIDC_CLIENT_ID";
const OIDC_CLIENT_SECRET_ENV = "T3CODE_APP_STACK_BACKEND_OIDC_CLIENT_SECRET";
const CODE_OIDC_ISSUER_ENV = "CODE_OIDC_ISSUER";
const CODE_OIDC_CLIENT_ID_ENV = "CODE_OIDC_CLIENT_ID";
const CODE_OIDC_CLIENT_SECRET_ENV = "CODE_OIDC_CLIENT_SECRET";
const OIDC_REFRESH_EARLY_MS = 60_000;
const DISABLED_MESSAGE =
  "App Stack handling is not configured. Enable T3CODE_APP_STACK_NATIVE_ENABLED or set T3CODE_APP_STACK_BACKEND_URL to a controller API that serves /api/app-dev-stacks.";
const DEFAULT_LOG_TAIL_LINES = 300;
const POD_LOG_FETCH_CONCURRENCY = 4;

const OAuthTokenResponse = Schema.Struct({
  access_token: Schema.String,
  expires_in: Schema.optional(Schema.Number),
  token_type: Schema.optional(Schema.String),
});

export class AppStackManager extends Context.Service<
  AppStackManager,
  {
    readonly status: Effect.Effect<AppStackBackendStatus>;
    readonly list: (input: AppStackListInput) => Effect.Effect<AppStackListResult, AppStackError>;
    readonly getByWorktree: (input: {
      readonly worktreePath: string;
      readonly variant?: AppStackVariant | undefined;
    }) => Effect.Effect<AppStackByWorktreeResult, AppStackError>;
    readonly get: (input: AppStackGetInput) => Effect.Effect<AppStack, AppStackError>;
    readonly autoCreate: (
      input: AppStackAutoCreateInput,
    ) => Effect.Effect<AppStackAutoCreateResult, AppStackError>;
    readonly stop: (input: AppStackGetInput) => Effect.Effect<AppStack, AppStackError>;
    readonly setProtected: (
      input: AppStackSetProtectedInput,
    ) => Effect.Effect<AppStack, AppStackError>;
    /** Stops every unprotected stack a finished workflow owns. */
    readonly workflowTeardown: (
      input: AppStackWorkflowTeardownInput,
    ) => Effect.Effect<AppStackWorkflowTeardownResult, AppStackError>;
    readonly restart: (input: AppStackGetInput) => Effect.Effect<AppStack, AppStackError>;
    readonly delete: (
      input: AppStackGetInput,
    ) => Effect.Effect<AppStackDeleteResult, AppStackError>;
    readonly listPods: (
      input: AppStackListPodsInput,
    ) => Effect.Effect<AppStackListPodsResult, AppStackError>;
    readonly getPodLogs: (
      input: AppStackGetPodLogsInput,
    ) => Effect.Effect<AppStackGetPodLogsResult, AppStackError>;
    readonly getStackPodLogs: (
      input: AppStackGetStackPodLogsInput,
    ) => Effect.Effect<AppStackGetStackPodLogsResult, AppStackError>;
    readonly getAllStackPodLogs: (
      input: AppStackGetAllStackPodLogsInput,
    ) => Effect.Effect<AppStackGetAllStackPodLogsResult, AppStackError>;
  }
>()("t3/appStack/AppStackManager") {
  static readonly layer = Layer.effect(
    AppStackManager,
    Effect.gen(function* () {
      const config = yield* ServerConfig.ServerConfig;
      const httpClient = yield* HttpClient.HttpClient;
      const baseUrl = config.appStackBackendUrl?.href.replace(/\/+$/u, "") ?? null;

      if (config.appStackNative !== undefined && baseUrl === null) {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        return AppStackManager.of(
          makeNativeAppStackService(
            config.appStackNative,
            makeKubectlRunner(config.appStackNative.kubectlPath, spawner),
            makeNativeCommandRunner(spawner),
          ),
        );
      }

      const bearerToken =
        config.appStackBackendBearerToken === undefined
          ? null
          : Redacted.value(config.appStackBackendBearerToken);
      const oidcConfig =
        config.appStackBackendOidcTokenUrl !== undefined &&
        config.appStackBackendOidcClientId !== undefined &&
        config.appStackBackendOidcClientSecret !== undefined
          ? {
              tokenUrl: config.appStackBackendOidcTokenUrl.href,
              clientId: config.appStackBackendOidcClientId,
              clientSecret: Redacted.value(config.appStackBackendOidcClientSecret),
            }
          : null;
      let cachedOidcToken: {
        readonly accessToken: string;
        readonly expiresAtEpochMs: number;
      } | null = null;
      const autoCreateLocks = yield* SynchronizedRef.make(
        new Map<string, { readonly semaphore: Semaphore.Semaphore; readonly users: number }>(),
      );

      const status = Effect.succeed({
        enabled: baseUrl !== null,
        backendUrl: baseUrl,
      });

      const requireBaseUrl = (operation: string) =>
        baseUrl === null
          ? Effect.fail(
              new AppStackError({
                operation,
                reason: "disabled",
                message: DISABLED_MESSAGE,
              }),
            )
          : Effect.succeed(baseUrl);

      const appStackUrl = (base: string, path: string) => `${base}/api/app-dev-stacks${path}`;

      // The controller does not report the variant; its compose file name is
      // the record, the same rule the controller applies on restart.
      const withVariant = (stack: AppStack): AppStack =>
        stack.variant === undefined
          ? { ...stack, variant: appStackVariantForComposePath(stack.composePath) }
          : stack;

      const oidcConfigDescription = () =>
        `${OIDC_TOKEN_URL_ENV} or ${OIDC_ISSUER_ENV}, ${OIDC_CLIENT_ID_ENV}, and ${OIDC_CLIENT_SECRET_ENV} (or ${CODE_OIDC_ISSUER_ENV}, ${CODE_OIDC_CLIENT_ID_ENV}, and ${CODE_OIDC_CLIENT_SECRET_ENV})`;

      const tokenRequestMessage = (response: HttpClientResponse.HttpClientResponse) =>
        response.text.pipe(
          Effect.map((body) => {
            const trimmed = body.trim();
            return trimmed.length > 0
              ? `App Stack OIDC token endpoint responded with ${response.status}: ${trimmed}`
              : `App Stack OIDC token endpoint responded with ${response.status}.`;
          }),
          Effect.orElseSucceed(
            () => `App Stack OIDC token endpoint responded with ${response.status}.`,
          ),
        );

      const getOidcAccessToken = Effect.fn("AppStackManager.getOidcAccessToken")(function* () {
        if (oidcConfig === null) {
          return yield* new AppStackError({
            operation: "authenticate",
            reason: "request_failed",
            message: `App Stack backend auth is not configured. Set ${BACKEND_TOKEN_ENV} or configure ${oidcConfigDescription()}.`,
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
              new AppStackError({
                operation: "authenticate",
                reason: "request_failed",
                message: "Failed to reach App Stack OIDC token endpoint.",
                cause,
              }),
          ),
        );
        if (response.status < 200 || response.status >= 300) {
          return yield* tokenRequestMessage(response).pipe(
            Effect.flatMap((message) =>
              Effect.fail(
                new AppStackError({
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
              new AppStackError({
                operation: "authenticate",
                reason: "invalid_response",
                status: response.status,
                message: "Failed to decode App Stack OIDC token response.",
                cause,
              }),
          ),
        );
        const accessToken = token.access_token.trim();
        if (accessToken.length === 0) {
          return yield* new AppStackError({
            operation: "authenticate",
            reason: "invalid_response",
            status: response.status,
            message: "App Stack OIDC token response did not include an access token.",
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
          ? `App Stack backend responded with 401. The configured ${BACKEND_TOKEN_ENV} was rejected or expired; refresh it on the server.`
          : oidcConfig !== null
            ? `App Stack backend responded with 401. The service token minted from the configured OIDC client credentials was rejected; check ${oidcConfigDescription()}.`
            : `App Stack backend responded with 401. Set ${BACKEND_TOKEN_ENV} or configure ${oidcConfigDescription()}.`;

      const responseMessage = (response: HttpClientResponse.HttpClientResponse) =>
        response.text.pipe(
          Effect.map((body) => {
            const trimmed = body.trim();
            if (response.status === 401) {
              const message = unauthorizedMessage();
              return trimmed.length > 0 ? `${message} Backend response: ${trimmed}` : message;
            }
            return trimmed.length > 0
              ? `App Stack backend responded with ${response.status}: ${trimmed}`
              : `App Stack backend responded with ${response.status}.`;
          }),
          Effect.orElseSucceed(() =>
            response.status === 401
              ? unauthorizedMessage()
              : `App Stack backend responded with ${response.status}.`,
          ),
        );

      const decodeResponse = <S extends Schema.Top>(
        operation: string,
        schema: S,
        response: HttpClientResponse.HttpClientResponse,
      ): Effect.Effect<S["Type"], AppStackError, S["DecodingServices"]> => {
        if (response.status < 200 || response.status >= 300) {
          return responseMessage(response).pipe(
            Effect.flatMap((message) =>
              Effect.fail(
                new AppStackError({
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
              new AppStackError({
                operation,
                reason: "invalid_response",
                status: response.status,
                message: "Failed to decode App Stack backend response.",
                cause,
              }),
          ),
        );
      };

      const executeJson = <S extends Schema.Top>(
        operation: string,
        request: HttpClientRequest.HttpClientRequest,
        schema: S,
      ): Effect.Effect<S["Type"], AppStackError, S["DecodingServices"]> =>
        authorizeBackendRequest(request).pipe(
          Effect.flatMap((authorizedRequest) =>
            httpClient.execute(authorizedRequest.pipe(HttpClientRequest.acceptJson)).pipe(
              Effect.mapError(
                (cause) =>
                  new AppStackError({
                    operation,
                    reason: "request_failed",
                    message: "Failed to reach App Stack backend.",
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
      ): Effect.Effect<AppStackDeleteResult, AppStackError> =>
        authorizeBackendRequest(request).pipe(
          Effect.flatMap((authorizedRequest) =>
            httpClient.execute(authorizedRequest.pipe(HttpClientRequest.acceptJson)).pipe(
              Effect.mapError(
                (cause) =>
                  new AppStackError({
                    operation,
                    reason: "request_failed",
                    message: "Failed to reach App Stack backend.",
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
                      new AppStackError({
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

      const list = Effect.fn("AppStackManager.list")(function* (input: AppStackListInput) {
        const base = yield* requireBaseUrl("list");
        const url = new URL(appStackUrl(base, ""));
        const userId = input.userId?.trim();
        if (userId) {
          url.searchParams.set("userId", userId);
        }
        const stacks = yield* executeJson(
          "list",
          HttpClientRequest.get(url.toString()),
          Schema.Array(AppStack),
        );
        return { stacks: stacks.map(withVariant) };
      });

      const getByWorktree = Effect.fn("AppStackManager.getByWorktree")(function* (input: {
        readonly worktreePath: string;
        readonly variant?: AppStackVariant | undefined;
      }) {
        const base = yield* requireBaseUrl("getByWorktree");
        const url = new URL(appStackUrl(base, "/by-worktree"));
        url.searchParams.set("worktreePath", input.worktreePath);
        const result = yield* executeJson(
          "getByWorktree",
          HttpClientRequest.get(url.toString()),
          AppStackByWorktreeResult,
        );
        const stack = result.stack === null ? null : withVariant(result.stack);
        // The controller keys this lookup on the worktree alone, so the stack
        // it returns may be the other variant's. That one is not ours.
        if (stack === null || stack.variant !== (input.variant ?? "dev")) {
          return { stack: null, frontendUrl: null, frontendServiceName: null };
        }
        return { ...result, stack };
      });

      const get = Effect.fn("AppStackManager.get")(function* (input: AppStackGetInput) {
        const base = yield* requireBaseUrl("get");
        const stack = yield* executeJson(
          "get",
          HttpClientRequest.get(appStackUrl(base, `/${encodeURIComponent(input.stackId)}`)),
          AppStack,
        );
        return withVariant(stack);
      });

      const autoCreateRequest = Effect.fn("AppStackManager.autoCreateRequest")(function* (
        input: AppStackAutoCreateInput,
      ) {
        const existing = yield* getByWorktree({
          worktreePath: input.worktreePath,
          variant: input.variant,
        });
        if (
          existing.stack !== null &&
          ["pending", "starting", "running", "stopping"].includes(existing.stack.status)
        ) {
          return {
            stack: existing.stack,
            created: false,
            alreadyRunning: true,
            reserved: false,
            message: "An app stack for this worktree already exists; returning it.",
            frontendUrl: existing.frontendUrl,
            frontendServiceName: existing.frontendServiceName,
          };
        }
        const base = yield* requireBaseUrl("autoCreate");
        const result = yield* executeJson(
          "autoCreate",
          HttpClientRequest.post(appStackUrl(base, "/auto-create")).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              worktree_path: input.worktreePath,
              display_name: input.displayName,
              git_branch: input.gitBranch ?? null,
              variant: input.variant ?? "dev",
              ...(input.namespace === undefined ? {} : { namespace: input.namespace }),
              ...(input.workflowId === undefined ? {} : { workflow_id: input.workflowId }),
            }),
          ),
          AppStackAutoCreateResult,
        );
        return { ...result, stack: result.stack === null ? null : withVariant(result.stack) };
      });

      const getAutoCreateSemaphore = (key: string) =>
        SynchronizedRef.modifyEffect(autoCreateLocks, (current) => {
          const existing = current.get(key);
          if (existing !== undefined) {
            const next = new Map(current);
            next.set(key, { ...existing, users: existing.users + 1 });
            return Effect.succeed([existing.semaphore, next] as const);
          }
          return Semaphore.make(1).pipe(
            Effect.map((semaphore) => {
              const next = new Map(current);
              next.set(key, { semaphore, users: 1 });
              return [semaphore, next] as const;
            }),
          );
        });

      const releaseAutoCreateSemaphore = (key: string) =>
        SynchronizedRef.update(autoCreateLocks, (current) => {
          const existing = current.get(key);
          if (existing === undefined) return current;
          const next = new Map(current);
          if (existing.users === 1) next.delete(key);
          else next.set(key, { ...existing, users: existing.users - 1 });
          return next;
        });

      const autoCreate = Effect.fn("AppStackManager.autoCreate")(function* (
        input: AppStackAutoCreateInput,
      ) {
        const normalizedPath = input.worktreePath.trim().replace(/[\\/]+$/u, "");
        const key = `${input.workflowId?.trim() ?? "manual"}\u0000${normalizedPath}`;
        const semaphore = yield* getAutoCreateSemaphore(key);
        return yield* semaphore
          .withPermit(autoCreateRequest(input))
          .pipe(Effect.ensuring(releaseAutoCreateSemaphore(key)));
      });

      const stop = Effect.fn("AppStackManager.stop")(function* (input: AppStackGetInput) {
        const base = yield* requireBaseUrl("stop");
        const stack = yield* executeJson(
          "stop",
          HttpClientRequest.post(appStackUrl(base, `/${encodeURIComponent(input.stackId)}/stop`)),
          AppStack,
        );
        return withVariant(stack);
      });

      const setProtected = Effect.fn("AppStackManager.setProtected")(function* (
        input: AppStackSetProtectedInput,
      ) {
        const base = yield* requireBaseUrl("setProtected");
        const stack = yield* executeJson(
          "setProtected",
          HttpClientRequest.post(
            appStackUrl(base, `/${encodeURIComponent(input.stackId)}/protection`),
          ).pipe(HttpClientRequest.bodyJsonUnsafe({ protected: input.protected })),
          AppStack,
        );
        return withVariant(stack);
      });

      const workflowTeardown = Effect.fn("AppStackManager.workflowTeardown")(function* (
        input: AppStackWorkflowTeardownInput,
      ) {
        const base = yield* requireBaseUrl("workflowTeardown");
        return yield* executeJson(
          "workflowTeardown",
          HttpClientRequest.post(appStackUrl(base, "/workflow-teardown")).pipe(
            HttpClientRequest.bodyJsonUnsafe({ workflow_id: input.workflowId }),
          ),
          AppStackWorkflowTeardownResult,
        );
      });

      const restart = Effect.fn("AppStackManager.restart")(function* (input: AppStackGetInput) {
        const stack = yield* get(input);
        yield* stop(input);
        const result = yield* autoCreate({
          worktreePath: stack.worktreePath,
          displayName: displayNameForRestart(stack),
          gitBranch: stack.branchName ?? null,
          workflowId: stack.workflowId ?? undefined,
          variant: stack.variant,
        });
        if (result.stack === null) {
          return yield* new AppStackError({
            operation: "restart",
            reason: "invalid_response",
            message:
              result.message ??
              "The controller did not return a stack (branch is served by a standing deployment).",
          });
        }
        return result.stack;
      });

      const deleteStack = Effect.fn("AppStackManager.delete")(function* (input: AppStackGetInput) {
        const base = yield* requireBaseUrl("delete");
        return yield* executeEmpty(
          "delete",
          HttpClientRequest.delete(appStackUrl(base, `/${encodeURIComponent(input.stackId)}`)),
        );
      });

      const listPods = Effect.fn("AppStackManager.listPods")(function* (
        input: AppStackListPodsInput,
      ) {
        const base = yield* requireBaseUrl("listPods");
        return yield* executeJson(
          "listPods",
          HttpClientRequest.get(appStackUrl(base, `/${encodeURIComponent(input.stackId)}/pods`)),
          AppStackListPodsResult,
        );
      });

      const getPodLogs = Effect.fn("AppStackManager.getPodLogs")(function* (
        input: AppStackGetPodLogsInput,
      ) {
        const base = yield* requireBaseUrl("getPodLogs");
        const url = new URL(
          appStackUrl(
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
          AppStackGetPodLogsResult,
        );
      });

      const getStackPodLogs = Effect.fn("AppStackManager.getStackPodLogs")(function* (
        input: AppStackGetStackPodLogsInput,
      ) {
        const tailLines = input.tailLines ?? DEFAULT_LOG_TAIL_LINES;
        const podList = yield* listPods({ stackId: input.stackId });
        const podContainers = podList.pods.flatMap((pod) =>
          pod.containers.map((container) => ({ pod, container })),
        );
        const entries = yield* Effect.forEach(
          podContainers,
          ({ pod, container }) =>
            getPodLogs({
              stackId: input.stackId,
              podName: pod.name,
              containerName: container.name,
              tailLines,
            }).pipe(
              Effect.map((result) =>
                stackPodLogEntryFromResult(pod, container, result.logs, null, result.fetchedAt),
              ),
              Effect.catch((error) =>
                Effect.succeed(
                  stackPodLogEntryFromResult(
                    pod,
                    container,
                    "",
                    error.message,
                    DateTime.formatIso(DateTime.nowUnsafe()),
                  ),
                ),
              ),
            ),
          { concurrency: POD_LOG_FETCH_CONCURRENCY },
        );
        return {
          stackId: podList.stackId,
          namespace: podList.namespace,
          tailLines,
          pods: podList.pods,
          entries,
          fetchedAt: DateTime.formatIso(DateTime.nowUnsafe()),
        };
      });

      const getAllStackPodLogs = Effect.fn("AppStackManager.getAllStackPodLogs")(function* (
        input: AppStackGetAllStackPodLogsInput,
      ) {
        const limit = normalizeAllStackLogLimit(input.limit);
        if (limit.mode === "all") {
          return yield* new AppStackError({
            operation: "getAllStackPodLogs",
            reason: "request_failed",
            message:
              "Reading all App Stack logs is not supported by the configured remote App Stack backend.",
          });
        }
        const tailLines = limit.tailLines;
        const listResult = yield* list({});
        const stacks = yield* Effect.forEach(
          listResult.stacks,
          (stack) =>
            getStackPodLogs({ stackId: stack.id, tailLines }).pipe(
              Effect.map((result) => ({
                stackId: result.stackId,
                namespace: result.namespace,
                displayName: stack.displayName,
                displaySlug: stack.displaySlug ?? null,
                repoName: stack.repoName ?? null,
                branchName: stack.branchName ?? null,
                worktreePath: stack.worktreePath,
                managedBy: null,
                limit,
                pods: result.pods,
                entries: result.entries,
                error: null,
                fetchedAt: result.fetchedAt,
              })),
              Effect.catch((error) =>
                Effect.succeed({
                  stackId: stack.id,
                  namespace: stack.namespace ?? stack.id,
                  displayName: stack.displayName,
                  displaySlug: stack.displaySlug ?? null,
                  repoName: stack.repoName ?? null,
                  branchName: stack.branchName ?? null,
                  worktreePath: stack.worktreePath,
                  managedBy: null,
                  limit,
                  pods: [],
                  entries: [],
                  error: error.message,
                  fetchedAt: DateTime.formatIso(DateTime.nowUnsafe()),
                }),
              ),
            ),
          { concurrency: 3 },
        );
        return {
          limit,
          stacks,
          fetchedAt: DateTime.formatIso(DateTime.nowUnsafe()),
        };
      });

      return AppStackManager.of({
        status,
        list,
        getByWorktree,
        get,
        autoCreate,
        stop,
        setProtected,
        workflowTeardown,
        restart,
        delete: deleteStack,
        listPods,
        getPodLogs,
        getStackPodLogs,
        getAllStackPodLogs,
      });
    }),
  );
}

const stackPodLogEntryFromResult = (
  pod: AppStackPod,
  container: AppStackPodContainer,
  logs: string,
  error: string | null,
  fetchedAt: string,
): AppStackPodLogEntry => ({
  podName: pod.name,
  containerName: container.name,
  phase: pod.phase,
  ready: container.ready,
  restartCount: container.restartCount,
  state: container.state,
  ownerKind: pod.ownerKind ?? null,
  ownerName: pod.ownerName ?? null,
  logs,
  error,
  fetchedAt,
});

const normalizeAllStackLogLimit = (
  limit: AppStackGetAllStackPodLogsInput["limit"] | undefined,
): AppStackGetAllStackPodLogsResult["limit"] =>
  limit?.mode === "all"
    ? { mode: "all" }
    : {
        mode: "tail",
        tailLines: Math.min(
          5_000,
          Math.max(100, Math.trunc(limit?.tailLines ?? DEFAULT_LOG_TAIL_LINES)),
        ),
      };

const displayNameForRestart = (stack: AppStack): string => {
  const candidates = [
    stack.displayName,
    stack.displaySlug,
    stack.repoName,
    stack.branchName,
    stack.worktreePath.split("/").findLast((segment) => segment.length > 0),
  ];
  for (const candidate of candidates) {
    const trimmed = candidate?.trim();
    if (trimmed) return trimmed;
  }
  return stack.id;
};
