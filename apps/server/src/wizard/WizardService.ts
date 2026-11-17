import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  isProviderAvailable,
  isWizardThread,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
  type SelectProviderOptionDescriptor,
  ThreadId,
  WIZARD_THREAD_TAG,
  type WizardCreateThreadRequest,
  type WizardModelChoice,
  type WizardModelOption,
  type WizardSendMessageRequest,
  type WizardThread,
  type WizardThreadState,
  type WizardTranscriptItem,
  wizardIdFromTags,
  wizardIdTag,
  wizardNameFromTags,
  wizardNameTag,
} from "@t3tools/contracts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { resolveNewThreadModelSelection } from "@t3tools/shared/usageLimits";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as AppStackManager from "../appStack/AppStackManager.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { TranscriptSequencer, transcriptEntry, transcriptPage } from "./transcript.ts";

const WIZARD_MAX_WAIT_MS = 25_000;

export interface WizardConfigShape {
  /** Unset turns the whole API off: every route answers 404. */
  readonly token: Redacted.Redacted<string> | null;
  readonly projectPath: string;
  readonly baseBranch: string;
  readonly publicUrl: string;
}

export class WizardConfig extends Context.Service<WizardConfig, WizardConfigShape>()(
  "t3/wizard/WizardService/WizardConfig",
) {}

export const layerConfigFromEnv = Layer.effect(
  WizardConfig,
  Effect.gen(function* () {
    const read = (name: string) =>
      Config.String(name).pipe(
        Config.option,
        Effect.map((value) => Option.getOrUndefined(value)?.trim() || undefined),
        Effect.orElseSucceed(() => undefined),
      );
    const token = yield* read("T3CODE_WIZARD_API_TOKEN");
    return {
      token: token === undefined ? null : Redacted.make(token),
      projectPath:
        (yield* read("T3CODE_WIZARD_PROJECT_PATH")) ?? "/home/wizard/repos/healthcare-platform",
      baseBranch: (yield* read("T3CODE_WIZARD_BASE_BRANCH")) ?? "origin/dev",
      publicUrl: (yield* read("T3CODE_WIZARD_PUBLIC_URL")) ?? "https://wizard.nightingale-ai.com",
    } satisfies WizardConfigShape;
  }),
);

export class WizardApiError extends Schema.TaggedError<WizardApiError>()("WizardApiError", {
  status: Schema.Number,
  code: Schema.String,
  message: Schema.String,
}) {}

const fail = (status: number, code: string, message: string) =>
  Effect.fail(new WizardApiError({ status, code, message }));
const notFound = () => fail(404, "not_found", "No Wizard thread has this id.");
const unavailable = (message: string) => (cause: unknown) =>
  Effect.logWarning("Wizard API request failed", { cause }).pipe(
    Effect.andThen(fail(503, "unavailable", message)),
  );

export interface WizardTranscript {
  readonly items: ReadonlyArray<WizardTranscriptItem>;
  readonly cursor: number;
  readonly thread: WizardThread;
}

export class WizardService extends Context.Service<
  WizardService,
  {
    readonly models: Effect.Effect<
      { readonly models: ReadonlyArray<WizardModelOption>; readonly default: WizardModelChoice },
      WizardApiError
    >;
    readonly createThread: (
      input: WizardCreateThreadRequest,
    ) => Effect.Effect<WizardThread, WizardApiError>;
    readonly listThreads: (
      wizardId: string | null,
    ) => Effect.Effect<ReadonlyArray<WizardThread>, WizardApiError>;
    readonly getThread: (threadId: string) => Effect.Effect<WizardThread, WizardApiError>;
    readonly sendMessage: (
      threadId: string,
      input: WizardSendMessageRequest,
    ) => Effect.Effect<void, WizardApiError>;
    readonly interrupt: (threadId: string) => Effect.Effect<void, WizardApiError>;
    readonly transcript: (input: {
      readonly threadId: string;
      readonly after: number;
      readonly waitMs: number;
    }) => Effect.Effect<WizardTranscript, WizardApiError>;
  }
>()("t3/wizard/WizardService") {}

/** Lowercase ASCII words joined by dashes, for a branch name segment. */
function branchSlug(text: string, fallback: string): string {
  const slug = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug === "" ? fallback : slug;
}

/** `wizard/<wizard>/<title>`, with `-2`, `-3`… when a branch already holds the name. */
function wizardBranchName(
  wizardName: string,
  title: string,
  existing: ReadonlyArray<string>,
): string {
  const base = `wizard/${branchSlug(wizardName, "wizard")}/${branchSlug(title, "change")}`;
  const taken = (name: string) =>
    existing.some(
      (branch) => branch === name || branch.startsWith(`${name}/`) || name.startsWith(`${branch}/`),
    );
  if (!taken(base)) return base;
  for (let suffix = 2; ; suffix++) {
    if (!taken(`${base}-${suffix}`)) return `${base}-${suffix}`;
  }
}

/** A title from the first line of the message when the Wizard gave none. */
function titleFromMessage(message: string): string {
  const line = message.split("\n").find((candidate) => candidate.trim() !== "") ?? "";
  const trimmed = line.replace(/\s+/g, " ").trim();
  return trimmed.length <= 60 ? trimmed || "Wizard change" : `${trimmed.slice(0, 57).trimEnd()}…`;
}

const effortDescriptor = (provider: ServerProvider, model: string) =>
  provider.models
    .find((candidate) => candidate.slug === model)
    ?.capabilities?.optionDescriptors?.find(
      (descriptor): descriptor is SelectProviderOptionDescriptor =>
        descriptor.type === "select" &&
        (descriptor.role === "reasoning" ||
          descriptor.id === "effort" ||
          descriptor.id === "reasoningEffort"),
    );

function wizardModelOptions(
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<WizardModelOption> {
  return providers
    .filter((provider) => provider.enabled && isProviderAvailable(provider))
    .flatMap((provider) =>
      provider.models
        .filter((model) => model.isLegacy !== true)
        .map((model) => {
          const effort = effortDescriptor(provider, model.slug);
          const defaultEffort =
            effort?.currentValue ?? effort?.options.find((option) => option.isDefault)?.id;
          return {
            provider: provider.instanceId,
            model: model.slug,
            label: `${provider.displayName ?? provider.instanceId} · ${model.name}`,
            efforts: effort?.options.map((option) => option.id) ?? [],
            ...(defaultEffort === undefined ? {} : { defaultEffort }),
          };
        }),
    );
}

function modelChoiceFromSelection(selection: ModelSelection): WizardModelChoice {
  const effort = selection.options?.find(
    (option) => option.id === "effort" || option.id === "reasoningEffort",
  )?.value;
  return {
    provider: selection.instanceId,
    model: selection.model,
    ...(typeof effort === "string" ? { effort } : {}),
  };
}

function wizardThreadState(shell: OrchestrationV2ThreadShell): WizardThreadState {
  if (shell.archivedAt !== null) return "archived";
  if (shell.pendingRuntimeRequest !== null) return "waiting";
  switch (shell.status) {
    case "preparing":
    case "starting":
      return "starting";
    case "queued":
    case "running":
      return "working";
    case "waiting":
      return "waiting";
    case "failed":
      return "error";
    default:
      return "idle";
  }
}

function pullRequestOf(shell: OrchestrationV2ThreadShell): WizardThread["pullRequest"] {
  const link = shell.pullRequests?.findLast((candidate) => candidate.source !== "stack-dismissed");
  if (link !== undefined) {
    return {
      number: link.number,
      url: link.url,
      state: link.snapshot?.state ?? "open",
      draft: link.snapshot?.isDraft ?? false,
    };
  }
  const linked = shell.linkedPullRequest ?? shell.branchPullRequest ?? null;
  return linked === null
    ? null
    : { number: linked.number, url: linked.url, state: "open", draft: false };
}

const make = Effect.gen(function* () {
  const config = yield* WizardConfig;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const launches = yield* ThreadLaunch.ThreadLaunchService;
  const projects = yield* ProjectService.ProjectService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const git = yield* GitWorkflow.GitWorkflowService;
  const appStacks = yield* AppStackManager.AppStackManager;
  const crypto = yield* Digest.Digest;
  const sequencer = new TranscriptSequencer();

  const requestKey = Effect.fn("WizardService.requestKey")(function* (
    ...parts: ReadonlyArray<string>
  ) {
    // @effect-diagnostics-next-line globalJsonInEffect:off - a JSON array keeps the parts apart.
    const bytes = new TextEncoder().encode(JSON.stringify(parts));
    const digest = yield* crypto.digest(Digest.sha256, bytes);
    return Hex.encode(digest).slice(0, 32);
  });

  const project = Effect.gen(function* () {
    const found = yield* projects
      .getByWorkspaceRoot(config.projectPath)
      .pipe(Effect.catch(unavailable("The Wizard project could not be read.")));
    if (Option.isNone(found))
      return yield* fail(
        503,
        "project_missing",
        "The Wizard project is not set up on this server (T3CODE_WIZARD_PROJECT_PATH).",
      );
    return found.value;
  });

  const shellOf = (threadId: string) =>
    threads.getThreadShell(ThreadId.make(threadId)).pipe(
      Effect.catch(unavailable("The thread could not be read.")),
      Effect.filterOrElse(
        (shell): shell is OrchestrationV2ThreadShell =>
          shell !== null && shell.deletedAt === null && isWizardThread(shell.tags),
        notFound,
      ),
    );

  const toWizardThread = Effect.fn("WizardService.toWizardThread")(function* (
    shell: OrchestrationV2ThreadShell,
  ) {
    const environmentId = yield* environment.getEnvironmentId;
    const stack =
      shell.worktreePath === null
        ? null
        : yield* appStacks.getByWorktree({ worktreePath: shell.worktreePath }).pipe(
            Effect.map((result) =>
              result.stack === null
                ? null
                : {
                    stackId: result.stack.id,
                    status: result.stack.status,
                    urls: {
                      ...(result.frontendUrl === null ? {} : { frontend: result.frontendUrl }),
                      ...result.stack.previewUrls,
                    },
                    testPassword: result.stack.testPassword ?? null,
                  },
            ),
            // No stack controller, or none reachable, is "no stack" to a Wizard.
            Effect.orElseSucceed(() => null),
          );
    const base = config.publicUrl.replace(/\/+$/, "");
    return {
      threadId: shell.id,
      title: shell.title,
      wizard: {
        id: wizardIdFromTags(shell.tags) ?? "",
        name: wizardNameFromTags(shell.tags) ?? "",
      },
      state: wizardThreadState(shell),
      branch: shell.branch,
      createdAt: DateTime.formatIso(shell.createdAt),
      updatedAt: DateTime.formatIso(shell.updatedAt),
      url: `${base}/${encodeURIComponent(environmentId)}/${encodeURIComponent(shell.id)}`,
      stack,
      pullRequest: pullRequestOf(shell),
      model: modelChoiceFromSelection(shell.modelSelection),
    } satisfies WizardThread;
  });

  const resolveModel = Effect.fn("WizardService.resolveModel")(function* (
    choice: WizardModelChoice | undefined,
    projectId: Parameters<typeof resolveProjectSettings>[1],
    projectRecord: Parameters<typeof resolveProjectSettings>[2],
  ) {
    const list = yield* providers.getProviders;
    if (choice === undefined) {
      const settings = yield* settingsService.getSettings.pipe(
        Effect.catch(unavailable("Settings could not be read.")),
      );
      const projectSettings = resolveProjectSettings(settings, projectId, projectRecord).settings;
      const selection = resolveNewThreadModelSelection({
        defaultSelection: projectSettings.defaultModelSelection,
        fallbackSelection: projectSettings.fallbackModelSelection,
        providers: list,
        settings: projectSettings,
        projectId,
        now: yield* Clock.currentTimeMillis,
      }).selection;
      if (selection === null)
        return yield* fail(503, "no_default_model", "The Wizard project has no default model.");
      return selection;
    }
    const provider = list.find((candidate) => candidate.instanceId === choice.provider);
    if (provider === undefined || !provider.enabled || !isProviderAvailable(provider))
      return yield* fail(400, "invalid_model", `Provider ${choice.provider} is not available.`);
    if (!provider.models.some((model) => model.slug === choice.model))
      return yield* fail(400, "invalid_model", `Model ${choice.model} is not available.`);
    const effort = effortDescriptor(provider, choice.model);
    if (choice.effort !== undefined && !effort?.options.some((o) => o.id === choice.effort))
      return yield* fail(400, "invalid_model", `Effort ${choice.effort} is not available.`);
    return {
      instanceId: provider.instanceId,
      model: choice.model,
      ...(choice.effort === undefined || effort === undefined
        ? {}
        : { options: [{ id: effort.id, value: choice.effort }] }),
    } satisfies ModelSelection;
  });

  /** Tags are set by command id, so a retried create repeats them harmlessly. */
  const tagThread = Effect.fn("WizardService.tagThread")(function* (
    threadId: ThreadId,
    key: string,
    wizard: WizardCreateThreadRequest["wizard"],
  ) {
    const tags = [WIZARD_THREAD_TAG, wizardIdTag(wizard.id), wizardNameTag(wizard.name)];
    for (const [index, tag] of tags.entries()) {
      yield* threads
        .dispatch({
          type: "thread.tag.set",
          commandId: CommandId.make(`wizard:tag:${key}:${index}`),
          threadId,
          tag,
          tagged: true,
        })
        .pipe(Effect.catch(unavailable("The thread could not be tagged.")));
    }
  });

  const createThread = Effect.fn("WizardService.createThread")(function* (
    input: WizardCreateThreadRequest,
  ) {
    const key = yield* requestKey("create", input.wizard.id, input.clientRequestId);
    const threadId = ThreadId.make(`wizard-${key}`);
    const existing = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.catch(unavailable("The thread could not be read.")));
    if (existing === null || existing.deletedAt !== null) {
      const projectRecord = yield* project;
      const modelSelection = yield* resolveModel(input.model, projectRecord.id, projectRecord);
      const settings = yield* settingsService.getSettings.pipe(
        Effect.catch(unavailable("Settings could not be read.")),
      );
      const title = input.title ?? titleFromMessage(input.message);
      const localBranches = yield* git
        .listLocalBranchNames(projectRecord.workspaceRoot)
        .pipe(Effect.catch(unavailable("The Wizard project's branches could not be read.")));
      const baseRef = config.baseBranch.replace(/^origin\//, "");
      const workspaceStrategy = {
        type: "worktree" as const,
        baseRef,
        // Fetches the base first, so every Wizard thread starts from the newest commit.
        startFromOrigin: true,
        branch: wizardBranchName(input.wizard.name, title, localBranches),
      };
      yield* launches
        .checkWorktreeBase({ projectId: projectRecord.id, workspaceStrategy })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("Wizard thread base check failed", { error: error.message }).pipe(
              Effect.andThen(fail(503, "base_unavailable", error.message)),
            ),
          ),
        );
      const commandId = CommandId.make(`wizard:create:${key}`);
      yield* launches
        .launch({
          commandId,
          threadId,
          projectId: projectRecord.id,
          title,
          modelSelection,
          runtimeMode: resolveProjectSettings(settings, projectRecord.id, projectRecord).settings
            .defaultRuntimeMode,
          interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
          workspaceStrategy,
          initialMessage: {
            messageId: MessageId.make(`wizard-message-${key}`),
            text: input.message,
            attachments: [],
          },
          createdBy: "user",
          creationSource: "server",
        })
        .pipe(
          Effect.catchTags({
            ThreadManagementProviderInstanceDisabledError: (error) =>
              fail(400, "invalid_model", error.message),
            ThreadLaunchError: unavailable("The thread could not be started."),
          }),
        );
    }
    yield* tagThread(threadId, key, input.wizard);
    return yield* shellOf(threadId).pipe(Effect.flatMap(toWizardThread));
  });

  const listThreads = Effect.fn("WizardService.listThreads")(function* (wizardId: string | null) {
    const projectRecord = yield* project;
    const snapshot = yield* threads
      .getShellSnapshot({ projectId: projectRecord.id })
      .pipe(Effect.catch(unavailable("Threads could not be read.")));
    const seen = new Set<string>();
    const shells = [...snapshot.threads, ...snapshot.archivedThreads].filter((shell) => {
      if (seen.has(shell.id) || !isWizardThread(shell.tags)) return false;
      seen.add(shell.id);
      return wizardId === null || shell.tags?.includes(wizardIdTag(wizardId)) === true;
    });
    const newestFirst = shells.toSorted(
      (left, right) =>
        DateTime.toEpochMillis(right.createdAt) - DateTime.toEpochMillis(left.createdAt),
    );
    return yield* Effect.forEach(newestFirst, toWizardThread, { concurrency: 4 });
  });

  const sendMessage = Effect.fn("WizardService.sendMessage")(function* (
    threadId: string,
    input: WizardSendMessageRequest,
  ) {
    const shell = yield* shellOf(threadId);
    const modelSelection =
      input.model === undefined
        ? undefined
        : yield* resolveModel(input.model, shell.projectId, undefined);
    const key = yield* requestKey("message", shell.id, input.clientRequestId);
    yield* threads
      .sendToThread({
        projectId: shell.projectId,
        commandId: CommandId.make(`wizard:message:${key}`),
        threadId: shell.id,
        messageId: MessageId.make(`wizard-message-${key}`),
        text: input.message,
        attachments: [],
        ...(modelSelection === undefined ? {} : { modelSelection }),
        mode: "queue",
        createdBy: "user",
        creationSource: "server",
      })
      .pipe(
        Effect.catchTags({
          ThreadManagementThreadNotFoundError: () => notFound(),
          ThreadManagementProviderInstanceDisabledError: (error) =>
            fail(400, "invalid_model", error.message),
        }),
        Effect.catch((error) =>
          Effect.logWarning("Wizard message was refused", { error: error.message }).pipe(
            Effect.andThen(fail(409, "message_refused", error.message)),
          ),
        ),
      );
  });

  const interrupt = Effect.fn("WizardService.interrupt")(function* (threadId: string) {
    const shell = yield* shellOf(threadId);
    const key = yield* requestKey("interrupt", shell.id, String(yield* Clock.currentTimeMillis));
    yield* threads
      .interruptThread({
        projectId: shell.projectId,
        commandId: CommandId.make(`wizard:interrupt:${key}`),
        threadId: shell.id,
        reason: "The Wizard stopped the turn.",
      })
      .pipe(Effect.catch(unavailable("The turn could not be stopped.")));
  });

  const readTranscript = Effect.fn("WizardService.readTranscript")(function* (
    threadId: ThreadId,
    after: number,
  ) {
    const records = yield* threads
      .getThreadRecords(threadId, ["turnItems"])
      .pipe(Effect.catch(unavailable("The transcript could not be read.")));
    const entries = records.turnItems
      .filter((item) => item.parentItemId === null)
      .toSorted((left, right) => left.ordinal - right.ordinal)
      .flatMap((item) => {
        const entry = transcriptEntry(item);
        return entry === null ? [] : [entry];
      });
    return transcriptPage(sequencer.assign(threadId, entries), after);
  });

  const transcript = Effect.fn("WizardService.transcript")(function* (input: {
    readonly threadId: string;
    readonly after: number;
    readonly waitMs: number;
  }) {
    const shell = yield* shellOf(input.threadId);
    const waitMs = Math.min(Math.max(input.waitMs, 0), WIZARD_MAX_WAIT_MS);
    const deadline = (yield* Clock.currentTimeMillis) + waitMs;
    for (;;) {
      // Read the event watermark first, so an event landing during the read still wakes the wait.
      const watermark = yield* threads
        .getThreadEventSequence(shell.id)
        .pipe(Effect.catch(unavailable("The thread could not be read.")));
      const page = yield* readTranscript(shell.id, input.after);
      const remaining = deadline - (yield* Clock.currentTimeMillis);
      if (page.items.length > 0 || remaining <= 0) {
        const thread = yield* shellOf(input.threadId).pipe(Effect.flatMap(toWizardThread));
        return { ...page, thread } satisfies WizardTranscript;
      }
      yield* threads
        .streamStoredEventsFrom({ threadId: shell.id, afterSequence: watermark })
        .pipe(
          Stream.take(1),
          Stream.runDrain,
          Effect.timeoutOption(Duration.millis(remaining)),
          Effect.catch(unavailable("The thread could not be followed.")),
        );
    }
  });

  const models = Effect.gen(function* () {
    const list = yield* providers.getProviders;
    const projectRecord = yield* project;
    const selection = yield* resolveModel(undefined, projectRecord.id, projectRecord);
    return { models: wizardModelOptions(list), default: modelChoiceFromSelection(selection) };
  });

  return WizardService.of({
    models,
    createThread,
    listThreads,
    getThread: Effect.fn("WizardService.getThread")(function* (threadId) {
      return yield* toWizardThread(yield* shellOf(threadId));
    }),
    sendMessage,
    interrupt,
    transcript,
  });
});

export const layer = Layer.effect(WizardService, make);
