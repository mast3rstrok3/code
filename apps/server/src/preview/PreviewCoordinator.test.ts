import { describe, expect, it } from "@effect/vitest";
import {
  PreviewBrowserUnavailableError,
  ThreadId,
  type PreviewAutomationRecordingArtifact,
  type PreviewAutomationRecordingStatus,
  type PreviewFrameEvent,
  type PreviewScreenshotArtifact,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as Stream from "effect/Stream";

import * as PreviewManager from "./Manager.ts";
import * as PreviewCoordinator from "./PreviewCoordinator.ts";
import * as ServerBrowserManager from "./ServerBrowserManager.ts";

type EnsureTabInput = Parameters<
  ServerBrowserManager.ServerBrowserManager["Service"]["ensureTab"]
>[0];
type NavigateInput = Parameters<
  ServerBrowserManager.ServerBrowserManager["Service"]["navigate"]
>[0];

const unexpectedBrowserCall = <A>(): Effect.Effect<A, PreviewBrowserUnavailableError> =>
  Effect.fail(
    new PreviewBrowserUnavailableError({
      message: "Unexpected server browser call in PreviewCoordinator test.",
    }),
  );

const makeHarness = () => {
  const ensureTabCalls: EnsureTabInput[] = [];
  const navigateCalls: NavigateInput[] = [];
  const browser = ServerBrowserManager.ServerBrowserManager.of({
    isEnabled: Effect.succeed(true),
    ensureTab: (input) =>
      Effect.sync(() => {
        ensureTabCalls.push(input);
      }),
    navigate: (input) =>
      Effect.sync(() => {
        navigateCalls.push(input);
      }),
    resize: () => Effect.void,
    refresh: () => Effect.void,
    close: () => Effect.void,
    goBack: () => Effect.void,
    goForward: () => Effect.void,
    zoom: () => Effect.void,
    input: () => Effect.void,
    captureScreenshot: () => unexpectedBrowserCall<PreviewScreenshotArtifact>(),
    pickElementAt: () => unexpectedBrowserCall<string | null>(),
    clearBrowserData: () => Effect.void,
    frames: () => unexpectedBrowserCall<Stream.Stream<PreviewFrameEvent>>(),
    automationStatus: () =>
      Effect.succeed({
        available: true,
        visible: true,
        tabId: null,
        url: null,
        title: null,
        loading: false,
      }),
    automationSnapshot: () => unexpectedBrowserCall<unknown>(),
    automationClick: () => Effect.void,
    automationType: () => Effect.void,
    automationPress: () => Effect.void,
    automationScroll: () => Effect.void,
    automationEvaluate: () => unexpectedBrowserCall<unknown>(),
    automationWaitFor: () => Effect.void,
    recordingSupported: Effect.succeed(false),
    recordingStart: () => unexpectedBrowserCall<PreviewAutomationRecordingStatus>(),
    recordingStop: () => unexpectedBrowserCall<PreviewAutomationRecordingArtifact>(),
  });
  const browserLayer = Layer.succeed(ServerBrowserManager.ServerBrowserManager, browser);
  const layer = PreviewCoordinator.layer.pipe(
    Layer.provide(Layer.merge(PreviewManager.layer, browserLayer)),
  );
  return { ensureTabCalls, navigateCalls, layer };
};

describe("PreviewCoordinator", () => {
  it.effect("opens server-hosted Chromium with the normalized manager URL", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const coordinator = yield* PreviewCoordinator.PreviewCoordinator;
      const threadId = ThreadId.make("thread-open");

      const snapshot = yield* coordinator.open({
        threadId,
        url: "rudi-dev.nightingale-ai.com",
      });

      expect(snapshot.navStatus._tag).toBe("Loading");
      expect(harness.ensureTabCalls).toHaveLength(1);
      expect(harness.navigateCalls).toHaveLength(1);
      expect(harness.navigateCalls[0]).toMatchObject({
        threadId,
        tabId: snapshot.tabId,
        url: "https://rudi-dev.nightingale-ai.com/",
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("navigates server-hosted Chromium with the normalized manager URL", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const coordinator = yield* PreviewCoordinator.PreviewCoordinator;
      const threadId = ThreadId.make("thread-navigate");
      const opened = yield* coordinator.open({ threadId });

      const snapshot = yield* coordinator.navigate({
        threadId,
        tabId: opened.tabId,
        url: "example.com/path",
      });

      expect(snapshot.navStatus._tag).toBe("Loading");
      expect(harness.navigateCalls).toHaveLength(1);
      expect(harness.navigateCalls[0]).toMatchObject({
        threadId,
        tabId: opened.tabId,
        url: "https://example.com/path",
      });
    }).pipe(Effect.provide(harness.layer));
  });

  it.effect("fails invalid URLs before invoking server browser navigation", () => {
    const harness = makeHarness();
    return Effect.gen(function* () {
      const coordinator = yield* PreviewCoordinator.PreviewCoordinator;
      const threadId = ThreadId.make("thread-invalid-url");
      const opened = yield* coordinator.open({ threadId });

      const error = yield* Effect.flip(
        coordinator.navigate({
          threadId,
          tabId: opened.tabId,
          url: "   ",
        }),
      );

      expect(error._tag).toBe("PreviewInvalidUrlError");
      expect(harness.navigateCalls).toEqual([]);
    }).pipe(Effect.provide(harness.layer));
  });
});
