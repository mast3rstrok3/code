import {
  CommandId,
  MessageId,
  type OrchestrationEvent,
  type OrchestrationImplementationRun,
  ThreadId,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { OrchestratorV2 } from "../orchestration-v2/Orchestrator.ts";
import { forkParked } from "../serverActivation.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";

/** A point in an Engineering run that the thread which started it should hear about. */
export interface ScheduledWorkflowMilestone {
  /** Unique per run and milestone, so each one is told once. */
  readonly key: string;
  readonly text: string;
}

/**
 * What to tell the root thread about its Engineering run, if anything. The server opens the
 * run's pull requests and the root never takes another turn on its own, so a scheduled task's
 * prompt (report the pull request to a callback, say) would otherwise never get to finish.
 */
export function scheduledWorkflowMilestone(
  run: OrchestrationImplementationRun,
): ScheduledWorkflowMilestone | null {
  const halt = run.automationHalt;
  if (halt !== null) {
    return {
      key: `halt:${halt.haltedAt}`,
      text: [
        `The Engineering workflow stopped and needs human attention (${halt.stage}, ${halt.category}): ${halt.detail}`,
        "Finish anything your task asked you to do when the work stops, such as reporting this. Do not try to fix the run yourself.",
      ].join("\n\n"),
    };
  }
  if (run.status !== "babysitting-change-request" && run.status !== "completed") return null;
  const urls = [
    run.changeRequest?.url,
    ...run.repositories.map((repository) => repository.changeRequest?.url),
  ].filter((url): url is string => url !== undefined && url.length > 0);
  if (urls.length === 0) return null;
  const opened =
    urls.length === 1
      ? `The Engineering workflow opened its pull request: ${urls[0]}`
      : `The Engineering workflow opened its pull requests:\n${urls.map((url) => `- ${url}`).join("\n")}`;
  const babysits =
    run.status === "babysitting-change-request"
      ? " The workflow babysits them from here: it watches CI and review comments and pushes fixes, so do not change the branch yourself."
      : "";
  return {
    key: "pull-requests",
    text: `${opened}\n\nFinish anything your task asked you to do once the pull request is open, such as reporting its URL.${babysits}`,
  };
}

/**
 * Posts one turn into an Engineering root that a scheduled task started when the run opens
 * its pull requests or halts for a person. Only such roots are told: a person who started a
 * run watches it in the app, while a task's prompt can only act inside its own thread.
 */
export class ScheduledWorkflowReporter extends Context.Service<
  ScheduledWorkflowReporter,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly report: (input: {
      readonly rootThreadId: ThreadId;
      readonly run: OrchestrationImplementationRun;
    }) => Effect.Effect<void>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/ScheduledWorkflowReporter") {}

export const make = Effect.gen(function* () {
  const native = yield* OrchestratorV2;
  const workflowEngine = yield* OrchestrationEngineService;

  const reportUnsafe = Effect.fn("ScheduledWorkflowReporter.report")(function* (input: {
    readonly rootThreadId: ThreadId;
    readonly run: OrchestrationImplementationRun;
  }) {
    const milestone = scheduledWorkflowMilestone(input.run);
    if (milestone === null) return;
    const records = yield* native
      .getThreadRecords(input.rootThreadId, ["messages"], { messageRoles: ["user"] })
      .pipe(Effect.option);
    if (Option.isNone(records)) return;
    const messages = records.value.messages;
    // The task's own message opens the thread; nothing else marks a scheduled run.
    if (messages[0]?.scheduledTaskId === undefined) return;
    const id = `scheduled-workflow-report:${input.run.id}:${milestone.key}`;
    const messageId = MessageId.make(id);
    if (messages.some((message) => message.id === messageId)) return;
    yield* native.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(id),
      threadId: input.rootThreadId,
      messageId,
      text: milestone.text,
      attachments: [],
      createdBy: "system",
      creationSource: "server",
      dispatchMode: { type: "start_immediately" },
    });
  });

  const report = (input: {
    readonly rootThreadId: ThreadId;
    readonly run: OrchestrationImplementationRun;
  }) =>
    reportUnsafe(input).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("Scheduled workflow report failed", {
            threadId: input.rootThreadId,
            runId: input.run.id,
            cause: Cause.pretty(cause),
          }),
      ),
    );

  const worker = yield* makeDrainableWorker(report);

  const onWorkflowEvent = (event: OrchestrationEvent) =>
    event.type === "thread.implementation-run-updated" &&
    scheduledWorkflowMilestone(event.payload.run) !== null
      ? worker.enqueue({ rootThreadId: event.payload.sourceThreadId, run: event.payload.run })
      : Effect.void;

  return {
    start: Effect.fn("ScheduledWorkflowReporter.start")(function* () {
      yield* forkParked(
        Stream.runForEach(workflowEngine.streamDomainEvents, onWorkflowEvent).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("Scheduled workflow report event stream stopped", {
              cause: Cause.pretty(cause),
            }),
          ),
        ),
      );
    }),
    report: (input) => worker.enqueue(input),
    drain: worker.drain,
  } satisfies ScheduledWorkflowReporter["Service"];
});

export const layer = Layer.effect(ScheduledWorkflowReporter, make);
