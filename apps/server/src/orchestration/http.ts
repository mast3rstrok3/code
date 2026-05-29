import {
  type ClientOrchestrationCommand,
  EnvironmentHttpApi,
  EnvironmentHttpBadRequestError,
  EnvironmentHttpInternalServerError,
  OrchestrationDispatchCommandError,
  OrchestrationGetSnapshotError,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as HttpApiBuilder from "effect/unstable/httpapi/HttpApiBuilder";

import { normalizeDispatchCommand } from "./Normalizer.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

const failOrchestrationHttpError = (
  error: OrchestrationDispatchCommandError | OrchestrationGetSnapshotError,
) =>
  Effect.gen(function* () {
    if (error._tag === "OrchestrationGetSnapshotError") {
      yield* Effect.logError("orchestration http route failed", {
        message: error.message,
        cause: error.cause,
      });
      return yield* new EnvironmentHttpInternalServerError({ message: error.message });
    }

    return yield* new EnvironmentHttpBadRequestError({ message: error.message });
  });

export const orchestrationHttpApiLayer = HttpApiBuilder.group(
  EnvironmentHttpApi,
  "orchestration",
  Effect.fnUntraced(function* (handlers) {
    const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
    const orchestrationEngine = yield* OrchestrationEngineService;

    const snapshotHandler = Effect.fn("environment.orchestration.snapshot")(
      function* () {
        return yield* projectionSnapshotQuery.getSnapshot().pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationGetSnapshotError({
                message: "Failed to load orchestration snapshot.",
                cause,
              }),
          ),
        );
      },
      Effect.catchTag("OrchestrationGetSnapshotError", failOrchestrationHttpError),
    );

    const dispatchHandler = Effect.fn("environment.orchestration.dispatch")(
      function* (input: { readonly payload: ClientOrchestrationCommand }) {
        const normalizedCommand = yield* normalizeDispatchCommand(input.payload);
        return yield* orchestrationEngine.dispatch(normalizedCommand).pipe(
          Effect.mapError(
            (cause) =>
              new OrchestrationDispatchCommandError({
                message: "Failed to dispatch orchestration command.",
                cause,
              }),
          ),
        );
      },
      Effect.catchTag("OrchestrationDispatchCommandError", failOrchestrationHttpError),
    );

    return handlers.handle("snapshot", snapshotHandler).handle("dispatch", dispatchHandler);
  }),
);
