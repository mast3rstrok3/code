import {
  AppReviewScope,
  IsoDateTime,
  NonNegativeInt,
  OrchestrationPlanningFileChange,
  OrchestrationPlanningTicket,
  OrchestrationPlanningTicketDependency,
  OrchestrationPlanningTicketId,
  OrchestrationPlanningTicketKey,
  OrchestrationPlanningSpecId,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProjectionRepositoryError } from "../Errors.ts";

export const ProjectionThreadPlanningTicket = Schema.Struct({
  ticketId: OrchestrationPlanningTicketId,
  ticketKey: OrchestrationPlanningTicketKey,
  specId: OrchestrationPlanningSpecId,
  threadId: ThreadId,
  ordinal: NonNegativeInt,
  title: TrimmedNonEmptyString,
  bodyMarkdown: TrimmedNonEmptyString,
  plannedFileChanges: Schema.Array(OrchestrationPlanningFileChange),
  dependencies: Schema.Array(OrchestrationPlanningTicketDependency),
  appReviewEligible: Schema.Literals([0, 1]),
  appReviewScope: Schema.NullOr(AppReviewScope),
  appReviewPlanMarkdown: Schema.NullOr(TrimmedNonEmptyString),
  status: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type ProjectionThreadPlanningTicket = typeof ProjectionThreadPlanningTicket.Type;

export function projectionTicketFromContract(
  threadId: ThreadId,
  ticket: OrchestrationPlanningTicket,
): ProjectionThreadPlanningTicket {
  return {
    ticketId: ticket.id,
    ticketKey: ticket.key ?? `LEGACY-${ticket.id}`,
    specId: ticket.specId,
    threadId,
    ordinal: ticket.ordinal,
    title: ticket.title,
    bodyMarkdown: ticket.bodyMarkdown,
    plannedFileChanges: ticket.plannedFileChanges,
    dependencies: ticket.dependencies,
    appReviewEligible: ticket.appReviewEligible === true ? 1 : 0,
    appReviewScope: ticket.appReviewScope ?? null,
    appReviewPlanMarkdown: ticket.appReviewPlanMarkdown ?? null,
    status: ticket.status,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

export function projectionTicketToContract(
  ticket: ProjectionThreadPlanningTicket,
): OrchestrationPlanningTicket {
  return {
    id: ticket.ticketId,
    key: ticket.ticketKey,
    specId: ticket.specId,
    ordinal: ticket.ordinal,
    title: ticket.title,
    bodyMarkdown: ticket.bodyMarkdown,
    plannedFileChanges: ticket.plannedFileChanges,
    dependencies: ticket.dependencies,
    appReviewEligible: ticket.appReviewEligible === 1,
    ...(ticket.appReviewScope === null ? {} : { appReviewScope: ticket.appReviewScope }),
    appReviewPlanMarkdown: ticket.appReviewPlanMarkdown,
    status: ticket.status,
    createdAt: ticket.createdAt,
    updatedAt: ticket.updatedAt,
  };
}

export const ListProjectionThreadPlanningTicketsInput = Schema.Struct({
  threadId: ThreadId,
});
export type ListProjectionThreadPlanningTicketsInput =
  typeof ListProjectionThreadPlanningTicketsInput.Type;

export const DeleteProjectionThreadPlanningTicketsInput = Schema.Struct({
  threadId: ThreadId,
});
export type DeleteProjectionThreadPlanningTicketsInput =
  typeof DeleteProjectionThreadPlanningTicketsInput.Type;

export interface ProjectionThreadPlanningTicketRepositoryShape {
  readonly upsert: (
    ticket: ProjectionThreadPlanningTicket,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
  readonly listByThreadId: (
    input: ListProjectionThreadPlanningTicketsInput,
  ) => Effect.Effect<ReadonlyArray<ProjectionThreadPlanningTicket>, ProjectionRepositoryError>;
  readonly deleteByThreadId: (
    input: DeleteProjectionThreadPlanningTicketsInput,
  ) => Effect.Effect<void, ProjectionRepositoryError>;
}

export class ProjectionThreadPlanningTicketRepository extends Context.Service<
  ProjectionThreadPlanningTicketRepository,
  ProjectionThreadPlanningTicketRepositoryShape
>()(
  "t3/persistence/Services/ProjectionThreadPlanningTickets/ProjectionThreadPlanningTicketRepository",
) {}
