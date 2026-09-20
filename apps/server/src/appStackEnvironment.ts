import * as Redacted from "effect/Redacted";

import type { ServerConfig } from "./config.ts";

/** Credentials for suites that request test fleets from the server's Stacks controller. */
export function appStackEnvironment(
  config:
    | Pick<ServerConfig["Service"], "appStackBackendUrl" | "appStackBackendBearerToken">
    | undefined,
): Record<string, string> | undefined {
  if (config?.appStackBackendUrl === undefined || config.appStackBackendBearerToken === undefined) {
    return undefined;
  }
  return {
    APP_DEV_STACK_API_URL: new URL("/api/app-dev-stacks", config.appStackBackendUrl).href,
    APP_DEV_STACK_API_TOKEN: Redacted.value(config.appStackBackendBearerToken),
  };
}
