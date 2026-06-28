import {
  PREVIEW_AUTOMATION_OPERATIONS,
  PreviewBrowserUnavailableError,
  type BrowserNavigationTarget,
  type PreviewAutomationNavigateInput,
  type PreviewAutomationOpenInput,
  type PreviewAutomationRequest,
  type PreviewAutomationResizeInput,
  type PreviewAutomationResponse,
  type PreviewAutomationStreamEvent,
  type PreviewTabId,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as PreviewAutomationBroker from "../mcp/PreviewAutomationBroker.ts";
import * as PreviewCoordinator from "./PreviewCoordinator.ts";
import * as ServerBrowserManager from "./ServerBrowserManager.ts";

const DEFAULT_TIMEOUT_MS = 15_000;

function serializeHostError(cause: unknown): NonNullable<PreviewAutomationResponse["error"]> {
  if (Cause.isCause(cause)) {
    const failure = Cause.findErrorOption(cause);
    if (Option.isSome(failure)) return serializeHostError(failure.value);
    return { _tag: "PreviewAutomationExecutionError", message: Cause.pretty(cause) };
  }
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    return {
      _tag: String(cause._tag),
      message:
        "message" in cause && typeof cause.message === "string" ? cause.message : String(cause),
      detail: cause,
    };
  }
  return {
    _tag: "PreviewAutomationExecutionError",
    message: cause instanceof Error ? cause.message : String(cause),
  };
}

function resolveAutomationTarget(target: BrowserNavigationTarget): string {
  if (target.kind === "url") return normalizePreviewUrl(target.url);
  const path = target.path?.startsWith("/") ? target.path : `/${target.path ?? ""}`;
  return `${target.protocol ?? "http"}://127.0.0.1:${target.port}${path}`;
}

const latestTab = (
  sessions: ReadonlyArray<{ readonly tabId: string; readonly updatedAt: string }>,
): string | null =>
  sessions.toSorted((a, b) => a.updatedAt.localeCompare(b.updatedAt)).at(-1)?.tabId ?? null;

const SUPPORTED_SERVER_OPERATIONS = PREVIEW_AUTOMATION_OPERATIONS.filter(
  (operation) =>
    operation !== "recordingStart" &&
    operation !== "recordingStop" &&
    operation !== "devReviewReplayStart" &&
    operation !== "devReviewReplayStop",
);

const noPreviewTabOpen = () =>
  new PreviewBrowserUnavailableError({ message: "No preview tab is open." });

export const layer = Layer.effectDiscard(
  Effect.gen(function* ServerPreviewAutomationHost() {
    const config = yield* ServerConfig.ServerConfig;
    if (config.mode === "desktop" || config.previewBrowserMode === "off") return;

    const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
    const environment = yield* ServerEnvironment.ServerEnvironment;
    const coordinator = yield* PreviewCoordinator.PreviewCoordinator;
    const browser = yield* ServerBrowserManager.ServerBrowserManager;
    const environmentId = yield* environment.getEnvironmentId;
    const clientId = `server-preview:${environmentId}`;

    const chooseTab = Effect.fn("ServerPreviewAutomationHost.chooseTab")(function* (
      request: PreviewAutomationRequest,
    ) {
      if (request.tabId) return request.tabId;
      const listed = yield* coordinator.list({ threadId: request.threadId });
      return latestTab(listed.sessions) as PreviewTabId | null;
    });

    const status = Effect.fn("ServerPreviewAutomationHost.status")(function* (
      request: PreviewAutomationRequest,
      tabId: PreviewTabId | null,
    ) {
      if (!tabId) {
        return {
          available: true,
          visible: false,
          tabId: null,
          url: null,
          title: null,
          loading: false,
        };
      }
      return yield* browser.automationStatus({
        threadId: request.threadId,
        tabId,
      });
    });

    const handleRequest = Effect.fn("ServerPreviewAutomationHost.handleRequest")(function* (
      request: PreviewAutomationRequest,
    ) {
      const tabId = yield* chooseTab(request);
      const withTab = (resolvedTabId: PreviewTabId) => ({
        threadId: request.threadId,
        tabId: resolvedTabId,
      });

      switch (request.operation) {
        case "status":
          return yield* status(request, tabId);
        case "open": {
          const input = request.input as PreviewAutomationOpenInput;
          const reuse = input.reuseExistingTab ?? true;
          const activeTabId = reuse ? tabId : null;
          if (!activeTabId) {
            const snapshot = yield* coordinator.open({
              threadId: request.threadId,
              ...(input.url ? { url: normalizePreviewUrl(input.url) } : {}),
            });
            return yield* status(request, snapshot.tabId);
          }
          if (input.url) {
            yield* coordinator.navigate({
              threadId: request.threadId,
              tabId: activeTabId,
              url: normalizePreviewUrl(input.url),
            });
          }
          return yield* status(request, activeTabId);
        }
        case "navigate": {
          const input = request.input as PreviewAutomationNavigateInput;
          const url = resolveAutomationTarget(
            input.target ?? {
              kind: "url",
              url: input.url!,
            },
          );
          const activeTabId =
            tabId ?? (yield* coordinator.open({ threadId: request.threadId, url })).tabId;
          if (tabId) {
            yield* coordinator.navigate({ threadId: request.threadId, tabId: activeTabId, url });
          }
          if ((input.readiness ?? "load") !== "none") {
            yield* browser
              .automationWaitFor({
                ...withTab(activeTabId),
                urlIncludes: new URL(url).origin,
                timeoutMs: input.timeoutMs ?? request.timeoutMs ?? DEFAULT_TIMEOUT_MS,
              })
              .pipe(Effect.ignore);
          }
          return yield* status(request, activeTabId);
        }
        case "resize": {
          if (!tabId) {
            return yield* noPreviewTabOpen();
          }
          const input = request.input as PreviewAutomationResizeInput;
          const setting = resolvePreviewViewport(input);
          yield* coordinator.resize({
            threadId: request.threadId,
            tabId,
            viewport: setting,
          });
          const nextStatus = yield* browser.automationStatus(withTab(tabId));
          return {
            tabId,
            setting,
            viewport: nextStatus.viewport ?? { width: 1280, height: 800 },
          };
        }
        case "snapshot":
          if (!tabId) {
            return yield* noPreviewTabOpen();
          }
          return yield* browser.automationSnapshot(withTab(tabId));
        case "click":
          if (!tabId) {
            return yield* noPreviewTabOpen();
          }
          return yield* browser.automationClick({
            ...withTab(tabId),
            ...(request.input as object),
          });
        case "type":
          if (!tabId) {
            return yield* noPreviewTabOpen();
          }
          return yield* browser.automationType({
            ...withTab(tabId),
            ...(request.input as object),
          } as never);
        case "press":
          if (!tabId) {
            return yield* noPreviewTabOpen();
          }
          return yield* browser.automationPress({
            ...withTab(tabId),
            ...(request.input as object),
          } as never);
        case "scroll":
          if (!tabId) {
            return yield* noPreviewTabOpen();
          }
          return yield* browser.automationScroll({
            ...withTab(tabId),
            ...(request.input as object),
          } as never);
        case "evaluate":
          if (!tabId) {
            return yield* noPreviewTabOpen();
          }
          return yield* browser.automationEvaluate({
            ...withTab(tabId),
            ...(request.input as object),
          } as never);
        case "waitFor":
          if (!tabId) {
            return yield* noPreviewTabOpen();
          }
          return yield* browser.automationWaitFor({
            ...withTab(tabId),
            ...(request.input as object),
          } as never);
        case "recordingStart":
        case "recordingStop":
        case "devReviewReplayStart":
        case "devReviewReplayStop":
          return yield* new PreviewBrowserUnavailableError({
            message: `${request.operation} is not implemented by the server-hosted browser yet.`,
          });
      }
    });

    const respond = (connectionId: string, request: PreviewAutomationRequest, result: unknown) =>
      broker.respond({
        clientId,
        connectionId,
        requestId: request.requestId,
        ok: true,
        ...(result === undefined ? {} : { result }),
      });

    const fail = (connectionId: string, request: PreviewAutomationRequest, cause: unknown) =>
      broker.respond({
        clientId,
        connectionId,
        requestId: request.requestId,
        ok: false,
        error: serializeHostError(cause),
      });

    const stream = yield* broker.connect({
      clientId,
      environmentId,
      supportedOperations: SUPPORTED_SERVER_OPERATIONS,
    });

    yield* stream.pipe(
      Stream.runForEach((event: PreviewAutomationStreamEvent) => {
        if (event.type === "connected") return Effect.void;
        return handleRequest(event.request).pipe(
          Effect.flatMap((result) => respond(event.connectionId, event.request, result)),
          Effect.catchCause((cause) => fail(event.connectionId, event.request, cause)),
        );
      }),
      Effect.forkScoped,
    );
  }),
);
