import { NativeVerificationError, type NativeVerificationRequest } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { FetchHttpClient } from "effect/unstable/http";
import { type Atom } from "effect/unstable/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { RemoteEnvironmentAuthorization } from "../authorization/service.ts";
import { ManagedRelayDpopSigner } from "../relay/managedRelay.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import { createEnvironmentCommand } from "./runtime.ts";

export function createNativeVerificationCommand<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return createEnvironmentCommand(runtime, {
    label: "Native verification",
    execute: (input: NativeVerificationRequest) =>
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor;
        const prepared = yield* SubscriptionRef.get(supervisor.prepared);
        if (Option.isNone(prepared))
          return yield* new NativeVerificationError({
            message: "Connect to this environment before transferring native verification.",
          });
        const signer = yield* Effect.serviceOption(ManagedRelayDpopSigner);
        const remoteAuthorization = yield* Effect.serviceOption(RemoteEnvironmentAuthorization);
        return yield* executeAuthenticatedEnvironmentHttpRequest({
          prepared: prepared.value,
          signer,
          remoteAuthorization,
          method: "POST",
          timeoutMs: 180_000,
          url: (base) => environmentEndpointUrl(base, "/api/orchestration/native-verification"),
          request: ({ client, headers }) =>
            client.orchestration.nativeVerification({ payload: { request: input }, headers }),
        }).pipe(Effect.provide(FetchHttpClient.layer));
      }),
  });
}
