import * as Schema from "effect/Schema";
import { TrimmedNonEmptyString } from "./baseSchemas.ts";

export const ReviewTestPlatform = Schema.Literals(["web", "windows", "android", "ios", "macos"]);
export type ReviewTestPlatform = typeof ReviewTestPlatform.Type;

export const ReviewTestPlatforms = Schema.NonEmptyArray(ReviewTestPlatform);

export const TicketTestPlatforms = Schema.Struct({
  ticketId: TrimmedNonEmptyString,
  platforms: ReviewTestPlatforms,
});
