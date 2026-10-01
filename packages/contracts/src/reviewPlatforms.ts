import * as Schema from "effect/Schema";
import { AppStackShape } from "./appStack.ts";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ReviewTestPlatform = Schema.Literals(["web", "windows", "android", "ios", "macos"]);
export type ReviewTestPlatform = typeof ReviewTestPlatform.Type;

export const ReviewTestPlatforms = Schema.NonEmptyArray(ReviewTestPlatform);

export const TicketTestPlatforms = Schema.Struct({
  ticketId: TrimmedNonEmptyString,
  platforms: ReviewTestPlatforms,
});

/** The user's choice of App Stack for one ticket, over the planner's. */
export const TicketAppStack = Schema.Struct({
  ticketId: TrimmedNonEmptyString,
  appStack: AppStackShape,
});
