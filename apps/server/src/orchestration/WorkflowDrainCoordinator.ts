import type { WorkflowDrainState } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import { ServerConfig } from "../config.ts";
import { ServerLifecycleEvents } from "../serverLifecycleEvents.ts";

export const WORKFLOW_DRAIN_TIMEOUT_MS = 90_000;

interface PlannedRestartMarker {
  readonly operationId: string;
  readonly requestedAt: string;
  readonly deadlineAt: string;
}

interface ActiveDrain {
  readonly state: WorkflowDrainState;
  readonly completed: Deferred.Deferred<WorkflowDrainState>;
  readonly forceRequested: Deferred.Deferred<void>;
}

export class WorkflowDrainCoordinator extends Context.Service<
  WorkflowDrainCoordinator,
  {
    readonly state: Effect.Effect<WorkflowDrainState>;
    readonly accepting: Effect.Effect<boolean>;
    readonly startupRecoveryCause: "planned-restart" | "server-crash" | null;
    readonly requestDrain: (input: {
      readonly operationId: string;
      readonly drain: Effect.Effect<void>;
      readonly requestedAt?: string;
      readonly deadlineAt?: string;
    }) => Effect.Effect<WorkflowDrainState>;
    readonly force: Effect.Effect<WorkflowDrainState>;
  }
>()("t3/orchestration/WorkflowDrainCoordinator") {}

const PlannedRestartMarker = Schema.Struct({
  operationId: Schema.String,
  requestedAt: Schema.String,
  deadlineAt: Schema.String,
});
const PlannedRestartMarkerJson = Schema.fromJsonString(PlannedRestartMarker);
const RuntimeMarkerJson = Schema.fromJsonString(Schema.Struct({ bootedAt: Schema.String }));
const decodeMarker = Schema.decodeUnknownOption(PlannedRestartMarkerJson);
const encodeMarker = Schema.encodeSync(PlannedRestartMarkerJson);
const encodeRuntimeMarker = Schema.encodeSync(RuntimeMarkerJson);

export const make = Effect.gen(function* () {
  const config = yield* ServerConfig;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const lifecycle = yield* ServerLifecycleEvents;
  const plannedMarkerPath = path.join(config.stateDir, "workflow-planned-restart.json");
  const runtimeMarkerPath = path.join(config.stateDir, "workflow-runtime.json");
  const plannedMarkerOption = (yield* fs.exists(plannedMarkerPath))
    ? decodeMarker(yield* fs.readFileString(plannedMarkerPath).pipe(Effect.orElseSucceed(() => "")))
    : Option.none();
  const plannedMarker = Option.getOrNull(plannedMarkerOption);
  const previousRuntimeExists = yield* fs.exists(runtimeMarkerPath);
  const startupRecoveryCause =
    plannedMarker !== null
      ? ("planned-restart" as const)
      : previousRuntimeExists
        ? ("server-crash" as const)
        : null;
  if (plannedMarker !== null) {
    yield* fs.remove(plannedMarkerPath).pipe(Effect.ignore);
  }
  const bootedAt = DateTime.formatIso(yield* DateTime.now);
  yield* fs
    .writeFileString(runtimeMarkerPath, encodeRuntimeMarker({ bootedAt }))
    .pipe(Effect.orDie);

  const state = yield* Ref.make<WorkflowDrainState>({
    status: "accepting",
    operationId: null,
    requestedAt: null,
    deadlineAt: null,
  });
  const active = yield* Ref.make<ActiveDrain | null>(null);

  const requestDrain: WorkflowDrainCoordinator["Service"]["requestDrain"] = (input) =>
    Effect.gen(function* () {
      const requestedAt = input.requestedAt ?? DateTime.formatIso(yield* DateTime.now);
      const deadlineAt =
        input.deadlineAt ??
        DateTime.formatIso(
          DateTime.add(DateTime.makeUnsafe(Date.parse(requestedAt)), {
            milliseconds: WORKFLOW_DRAIN_TIMEOUT_MS,
          }),
        );
      const completed = yield* Deferred.make<WorkflowDrainState>();
      const forceRequested = yield* Deferred.make<void>();
      const drainingState: WorkflowDrainState = {
        status: "draining",
        operationId: input.operationId,
        requestedAt,
        deadlineAt,
      };
      const prior = yield* Ref.get(active);
      if (
        prior !== null &&
        prior.state.operationId !== input.operationId &&
        (yield* Deferred.isDone(prior.completed))
      ) {
        yield* Ref.set(active, null);
      }
      const selected = yield* Ref.modify(active, (current) =>
        current === null
          ? [
              { state: drainingState, completed, forceRequested },
              { state: drainingState, completed, forceRequested },
            ]
          : [current, current],
      );
      if (selected.completed !== completed) return yield* Deferred.await(selected.completed);

      const marker: PlannedRestartMarker = {
        operationId: input.operationId,
        requestedAt,
        deadlineAt,
      };
      yield* fs.writeFileString(plannedMarkerPath, encodeMarker(marker)).pipe(Effect.orDie);
      yield* Ref.set(state, drainingState);
      yield* lifecycle.publish({
        version: 1,
        type: "draining",
        payload: { ...marker, forced: false },
      });

      const remainingMs = Math.max(0, Date.parse(deadlineAt) - Date.parse(requestedAt));
      const status = yield* Effect.race(
        Effect.race(
          input.drain.pipe(Effect.as("ready" as const)),
          Effect.sleep(remainingMs).pipe(Effect.as("forced" as const)),
        ),
        Deferred.await(forceRequested).pipe(Effect.as("forced" as const)),
      );
      const settled: WorkflowDrainState = { ...drainingState, status };
      yield* Ref.set(state, settled);
      yield* Deferred.succeed(completed, settled);
      if (status === "forced") {
        yield* lifecycle.publish({
          version: 1,
          type: "draining",
          payload: { ...marker, forced: true },
        });
      }
      return settled;
    });

  const force = Effect.gen(function* () {
    const current = yield* Ref.get(active);
    if (current === null) return yield* Ref.get(state);
    yield* Deferred.succeed(current.forceRequested, undefined);
    return yield* Deferred.await(current.completed);
  });

  return WorkflowDrainCoordinator.of({
    state: Ref.get(state),
    accepting: Ref.get(state).pipe(Effect.map((current) => current.status === "accepting")),
    startupRecoveryCause,
    requestDrain,
    force,
  });
});

export const layer = Layer.effect(WorkflowDrainCoordinator, make);
