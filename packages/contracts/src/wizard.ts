import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";

/**
 * The Wizard API (`/api/wizard/*`) lets another app start and drive threads for named people,
 * its Wizards. Its routes and JSON shapes are in `apps/server/src/wizard/wizard-api.md`.
 */

/** Every Wizard thread carries this tag. */
export const WIZARD_THREAD_TAG = "wizard";
const WIZARD_ID_TAG_PREFIX = "wizard:";
const WIZARD_NAME_TAG_PREFIX = "wizard-name:";
// Thread tags hold at most 64 characters.
const THREAD_TAG_MAX_LENGTH = 64;
const WIZARD_ID_MAX_LENGTH = THREAD_TAG_MAX_LENGTH - WIZARD_ID_TAG_PREFIX.length;

export const wizardIdTag = (wizardId: string) => `${WIZARD_ID_TAG_PREFIX}${wizardId}`;

/** The Wizard's display name, cut to fit a tag, so every client can show it. */
export const wizardNameTag = (name: string) =>
  `${WIZARD_NAME_TAG_PREFIX}${name.replace(/\s+/g, " ").trim()}`
    .slice(0, THREAD_TAG_MAX_LENGTH)
    .trim();

const tagValue = (tags: ReadonlyArray<string> | undefined, prefix: string): string | null => {
  const tag = tags?.find((candidate) => candidate.startsWith(prefix));
  const value = tag?.slice(prefix.length).trim();
  return value === undefined || value === "" ? null : value;
};

export const isWizardThread = (tags: ReadonlyArray<string> | undefined) =>
  tags?.includes(WIZARD_THREAD_TAG) === true;
export const wizardIdFromTags = (tags: ReadonlyArray<string> | undefined) =>
  tagValue(tags, WIZARD_ID_TAG_PREFIX);
export const wizardNameFromTags = (tags: ReadonlyArray<string> | undefined) =>
  tagValue(tags, WIZARD_NAME_TAG_PREFIX);

const SingleLine = TrimmedNonEmptyString.check(
  Schema.makeFilter((value) => (/[\p{Cc}]/u.test(value) ? "Must be a single line of text." : true)),
);

export const WizardIdentity = Schema.Struct({
  id: SingleLine.check(Schema.isMaxLength(WIZARD_ID_MAX_LENGTH)),
  name: SingleLine.check(Schema.isMaxLength(200)),
  email: Schema.optional(SingleLine.check(Schema.isMaxLength(320))),
});
export type WizardIdentity = typeof WizardIdentity.Type;

export const WizardModelChoice = Schema.Struct({
  provider: TrimmedNonEmptyString,
  model: TrimmedNonEmptyString,
  effort: Schema.optional(TrimmedNonEmptyString),
});
export type WizardModelChoice = typeof WizardModelChoice.Type;

const WizardMessageText = TrimmedNonEmptyString.check(Schema.isMaxLength(100_000));
const WizardClientRequestId = SingleLine.check(Schema.isMaxLength(200));

export const WizardCreateThreadRequest = Schema.Struct({
  wizard: WizardIdentity,
  message: WizardMessageText,
  title: Schema.optional(SingleLine.check(Schema.isMaxLength(200))),
  model: Schema.optional(WizardModelChoice),
  clientRequestId: WizardClientRequestId,
});
export type WizardCreateThreadRequest = typeof WizardCreateThreadRequest.Type;

export const WizardSendMessageRequest = Schema.Struct({
  message: WizardMessageText,
  model: Schema.optional(WizardModelChoice),
  clientRequestId: WizardClientRequestId,
});
export type WizardSendMessageRequest = typeof WizardSendMessageRequest.Type;

export type WizardThreadState = "starting" | "working" | "waiting" | "idle" | "error" | "archived";

export interface WizardThread {
  readonly threadId: string;
  readonly title: string;
  readonly wizard: { readonly id: string; readonly name: string };
  readonly state: WizardThreadState;
  readonly branch: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly url: string;
  readonly stack: {
    readonly stackId: string;
    readonly status: string;
    readonly urls: Readonly<Record<string, string>>;
    readonly testPassword: string | null;
  } | null;
  readonly pullRequest: {
    readonly number: number;
    readonly url: string;
    readonly state: string;
    readonly draft: boolean;
  } | null;
  readonly model: WizardModelChoice | null;
}

export type WizardTranscriptKind =
  | "user"
  | "assistant"
  | "reasoning"
  | "tool"
  | "command"
  | "diff"
  | "status"
  | "error";

export interface WizardTranscriptItem {
  readonly id: string;
  readonly seq: number;
  readonly kind: WizardTranscriptKind;
  readonly createdAt: string;
  readonly text?: string;
  readonly tool?: {
    readonly name: string;
    readonly input?: string;
    readonly output?: string;
    readonly status: "running" | "done" | "failed";
  };
  readonly command?: {
    readonly command: string;
    readonly output?: string;
    readonly exitCode?: number | null;
  };
  readonly diff?: {
    readonly files: ReadonlyArray<{
      readonly path: string;
      readonly additions: number;
      readonly deletions: number;
    }>;
    readonly patch?: string;
  };
  readonly final?: boolean;
}

export interface WizardModelOption {
  readonly provider: string;
  readonly model: string;
  readonly label: string;
  readonly efforts: ReadonlyArray<string>;
  readonly defaultEffort?: string;
}
