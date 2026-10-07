import type { ProviderSession } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Stream from "effect/Stream";
import type { ProviderRuntimeEvent } from "@t3tools/contracts";

export class WorkflowProviderEvents extends Context.Service<
  WorkflowProviderEvents,
  {
    readonly setSession: (session: ProviderSession) => void;
    readonly listSessions: () => Effect.Effect<ReadonlyArray<ProviderSession>>;
    readonly streamEvents: Stream.Stream<ProviderRuntimeEvent>;
  }
>()("t3/orchestration/WorkflowProviderEvents") {}
