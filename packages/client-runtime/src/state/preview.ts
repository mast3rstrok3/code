import { WS_METHODS } from "@t3tools/contracts";
import { Atom } from "effect/unstable/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createEnvironmentRpcSubscriptionAtomFamily,
} from "./runtime.ts";

export const previewAutomationHostFocusConcurrencyKey = (value: {
  readonly environmentId: string;
  readonly input: {
    readonly clientId: string;
    readonly connectionId: string;
  };
}): string => JSON.stringify([value.environmentId, value.input.clientId, value.input.connectionId]);

export function createPreviewEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const lifecycleScheduler = createAtomCommandScheduler();
  const statusScheduler = createAtomCommandScheduler();
  const automationScheduler = createAtomCommandScheduler();
  const lifecycleConcurrency = {
    mode: "serial" as const,
    key: ({ environmentId, input }: { environmentId: string; input: { threadId: string } }) =>
      JSON.stringify([environmentId, input.threadId]),
  };
  return {
    list: createEnvironmentRpcQueryAtomFamily(runtime, {
      label: "environment-data:preview:list",
      tag: WS_METHODS.previewList,
      staleTimeMs: 5_000,
    }),
    events: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:events",
      tag: WS_METHODS.subscribePreviewEvents,
    }),
    discoveredServers: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:discovered-servers",
      tag: WS_METHODS.subscribeDiscoveredLocalServers,
    }),
    frames: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:frames",
      tag: WS_METHODS.previewSubscribeFrames,
      idleTtlMs: 0,
    }),
    automationRequests: createEnvironmentRpcSubscriptionAtomFamily(runtime, {
      label: "environment-data:preview:automation-requests",
      tag: WS_METHODS.previewAutomationConnect,
      // Automation requests are commands, not cached query data. Dispose the
      // stream immediately with its owner so stale requests cannot replay when
      // a thread remounts and the server can clear disconnected hosts promptly.
      idleTtlMs: 0,
    }),
    open: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:open",
      tag: WS_METHODS.previewOpen,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    navigate: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:navigate",
      tag: WS_METHODS.previewNavigate,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    resize: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:resize",
      tag: WS_METHODS.previewResize,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    refresh: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:refresh",
      tag: WS_METHODS.previewRefresh,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    close: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:close",
      tag: WS_METHODS.previewClose,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    reportStatus: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:report-status",
      tag: WS_METHODS.previewReportStatus,
      scheduler: statusScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.tabId]),
      },
    }),
    input: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:input",
      tag: WS_METHODS.previewInput,
      scheduler: statusScheduler,
      concurrency: {
        mode: "latest",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.threadId, input.tabId, input.type]),
      },
    }),
    goBack: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:go-back",
      tag: WS_METHODS.previewGoBack,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    goForward: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:go-forward",
      tag: WS_METHODS.previewGoForward,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    zoom: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:zoom",
      tag: WS_METHODS.previewZoom,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    captureScreenshot: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:capture-screenshot",
      tag: WS_METHODS.previewCaptureScreenshot,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    pickElementAt: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:pick-element-at",
      tag: WS_METHODS.previewPickElementAt,
      scheduler: lifecycleScheduler,
      concurrency: lifecycleConcurrency,
    }),
    clearBrowserData: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:clear-browser-data",
      tag: WS_METHODS.previewClearBrowserData,
      scheduler: lifecycleScheduler,
    }),
    respondToAutomation: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:automation-respond",
      tag: WS_METHODS.previewAutomationRespond,
      scheduler: automationScheduler,
      concurrency: {
        mode: "singleFlight",
        key: ({ environmentId, input }) =>
          JSON.stringify([environmentId, input.connectionId, input.requestId]),
      },
    }),
    focusAutomationHost: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:preview:automation-focus-host",
      tag: WS_METHODS.previewAutomationFocusHost,
      scheduler: automationScheduler,
      concurrency: {
        mode: "latest",
        key: previewAutomationHostFocusConcurrencyKey,
      },
    }),
  };
}
