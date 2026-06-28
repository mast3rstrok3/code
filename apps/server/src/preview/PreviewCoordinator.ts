import {
  PreviewBrowserUnavailableError,
  type PreviewClearBrowserDataInput,
  type PreviewCloseInput,
  type PreviewError,
  type PreviewFrameEvent,
  type PreviewFrameSubscribeInput,
  type PreviewInputEvent,
  type PreviewListInput,
  type PreviewListResult,
  type PreviewNavigateInput,
  type PreviewOpenInput,
  type PreviewPickElementInput,
  type PreviewRefreshInput,
  type PreviewResizeInput,
  type PreviewScreenshotArtifact,
  type PreviewSessionSnapshot,
  type PreviewTabActionInput,
  type PreviewZoomInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as PreviewManager from "./Manager.ts";
import * as ServerBrowserManager from "./ServerBrowserManager.ts";

const completeMetadataNavigation = (
  manager: PreviewManager.PreviewManager["Service"],
  snapshot: PreviewSessionSnapshot,
) => {
  if (snapshot.navStatus._tag === "Idle") return Effect.succeed(snapshot);
  const navStatus = {
    _tag: "Success",
    url: snapshot.navStatus.url,
    title: snapshot.navStatus.title,
  } as const;
  return manager
    .reportStatus({
      threadId: snapshot.threadId as PreviewTabActionInput["threadId"],
      tabId: snapshot.tabId,
      navStatus,
      canGoBack: snapshot.canGoBack,
      canGoForward: snapshot.canGoForward,
    })
    .pipe(Effect.as({ ...snapshot, navStatus }));
};

export class PreviewCoordinator extends Context.Service<
  PreviewCoordinator,
  {
    readonly open: (input: PreviewOpenInput) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly navigate: (
      input: PreviewNavigateInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly resize: (
      input: PreviewResizeInput,
    ) => Effect.Effect<PreviewSessionSnapshot, PreviewError>;
    readonly refresh: (input: PreviewRefreshInput) => Effect.Effect<void, PreviewError>;
    readonly close: (input: PreviewCloseInput) => Effect.Effect<void, PreviewError>;
    readonly list: (input: PreviewListInput) => Effect.Effect<PreviewListResult>;
    readonly reportStatus: (
      input: Parameters<PreviewManager.PreviewManager["Service"]["reportStatus"]>[0],
    ) => Effect.Effect<void, PreviewError>;
    readonly subscribeFrames: (
      input: PreviewFrameSubscribeInput,
    ) => Effect.Effect<Stream.Stream<PreviewFrameEvent>, PreviewError>;
    readonly input: (input: PreviewInputEvent) => Effect.Effect<void, PreviewError>;
    readonly goBack: (input: PreviewTabActionInput) => Effect.Effect<void, PreviewError>;
    readonly goForward: (input: PreviewTabActionInput) => Effect.Effect<void, PreviewError>;
    readonly zoom: (input: PreviewZoomInput) => Effect.Effect<void, PreviewError>;
    readonly captureScreenshot: (
      input: PreviewTabActionInput,
    ) => Effect.Effect<PreviewScreenshotArtifact, PreviewError>;
    readonly pickElementAt: (
      input: PreviewPickElementInput,
    ) => Effect.Effect<string | null, PreviewError>;
    readonly clearBrowserData: (
      input: PreviewClearBrowserDataInput,
    ) => Effect.Effect<void, PreviewError>;
  }
>()("t3/preview/PreviewCoordinator") {}

export const make = Effect.gen(function* PreviewCoordinatorMake() {
  const manager = yield* PreviewManager.PreviewManager;
  const browser = yield* ServerBrowserManager.ServerBrowserManager;

  const useServerBrowser = browser.isEnabled;

  const open: PreviewCoordinator["Service"]["open"] = Effect.fn("PreviewCoordinator.open")(
    function* (input) {
      const snapshot = yield* manager.open(input);
      if (!(yield* useServerBrowser)) {
        return input.url ? yield* completeMetadataNavigation(manager, snapshot) : snapshot;
      }
      yield* browser.ensureTab({
        threadId: input.threadId,
        tabId: snapshot.tabId,
        ...(snapshot.viewport === undefined ? {} : { viewport: snapshot.viewport }),
      });
      if (input.url) {
        yield* browser.navigate({
          threadId: input.threadId,
          tabId: snapshot.tabId,
          url: input.url,
        });
      }
      return snapshot;
    },
  );

  const navigate: PreviewCoordinator["Service"]["navigate"] = Effect.fn(
    "PreviewCoordinator.navigate",
  )(function* (input) {
    const snapshot = yield* manager.navigate(input);
    if (!(yield* useServerBrowser)) {
      return yield* completeMetadataNavigation(manager, snapshot);
    }
    yield* browser.navigate(input);
    return snapshot;
  });

  const resize: PreviewCoordinator["Service"]["resize"] = Effect.fn("PreviewCoordinator.resize")(
    function* (input) {
      const snapshot = yield* manager.resize(input);
      if (yield* useServerBrowser) {
        yield* browser.resize(input);
      }
      return snapshot;
    },
  );

  const refresh: PreviewCoordinator["Service"]["refresh"] = Effect.fn("PreviewCoordinator.refresh")(
    function* (input) {
      yield* manager.refresh(input);
      if (yield* useServerBrowser) {
        yield* browser.refresh(input);
      }
    },
  );

  const close: PreviewCoordinator["Service"]["close"] = Effect.fn("PreviewCoordinator.close")(
    function* (input) {
      if (yield* useServerBrowser) {
        yield* browser.close(input);
      }
      yield* manager.close(input);
    },
  );

  const requireServerBrowser = <A>(
    effect: Effect.Effect<A, PreviewBrowserUnavailableError>,
  ): Effect.Effect<A, PreviewBrowserUnavailableError> =>
    useServerBrowser.pipe(
      Effect.flatMap((enabled) =>
        enabled
          ? effect
          : Effect.fail(
              new PreviewBrowserUnavailableError({
                message: "Server-hosted browser preview is not enabled for this environment.",
              }),
            ),
      ),
    );

  return PreviewCoordinator.of({
    open,
    navigate,
    resize,
    refresh,
    close,
    list: manager.list,
    reportStatus: manager.reportStatus,
    subscribeFrames: (input) => requireServerBrowser(browser.frames(input)),
    input: (input) => requireServerBrowser(browser.input(input)),
    goBack: (input) => requireServerBrowser(browser.goBack(input)),
    goForward: (input) => requireServerBrowser(browser.goForward(input)),
    zoom: (input) => requireServerBrowser(browser.zoom(input)),
    captureScreenshot: (input) => requireServerBrowser(browser.captureScreenshot(input)),
    pickElementAt: (input) => requireServerBrowser(browser.pickElementAt(input)),
    clearBrowserData: (input) => requireServerBrowser(browser.clearBrowserData(input.data)),
  });
});

export const layer = Layer.effect(PreviewCoordinator, make);
