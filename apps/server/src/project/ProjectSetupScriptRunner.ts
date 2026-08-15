import { ProjectId } from "@t3tools/contracts";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import { projectScriptRuntimeEnv, setupProjectScript } from "@t3tools/shared/projectScripts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export interface ProjectSetupScriptRunnerResultNoScript {
  readonly status: "no-script";
}

export interface ProjectSetupScriptRunnerResultStarted {
  readonly status: "started";
  readonly scriptId: string;
  readonly scriptName: string;
  readonly terminalId: string;
  readonly cwd: string;
  readonly completion: Effect.Effect<void, ProjectSetupScriptOperationError>;
}

export type ProjectSetupScriptRunnerResult =
  | ProjectSetupScriptRunnerResultNoScript
  | ProjectSetupScriptRunnerResultStarted;

export interface ProjectSetupScriptRunnerInput {
  readonly threadId: string;
  readonly projectId?: string;
  readonly projectCwd?: string;
  readonly worktreePath: string;
  readonly preferredTerminalId?: string;
}

export class ProjectSetupScriptOperationError extends Schema.TaggedErrorClass<ProjectSetupScriptOperationError>()(
  "ProjectSetupScriptOperationError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
    operation: Schema.Literals([
      "resolveProject",
      "resolveSetupScript",
      "openTerminal",
      "writeCommand",
      "executeCommand",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Project setup script operation '${this.operation}' failed for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export class ProjectSetupScriptProjectNotFoundError extends Schema.TaggedErrorClass<ProjectSetupScriptProjectNotFoundError>()(
  "ProjectSetupScriptProjectNotFoundError",
  {
    threadId: Schema.String,
    projectId: Schema.optional(Schema.String),
    projectCwd: Schema.optional(Schema.String),
    worktreePath: Schema.String,
  },
) {
  override get message(): string {
    return `Project was not found for setup script execution for thread '${this.threadId}' in '${this.worktreePath}'.`;
  }
}

export const ProjectSetupScriptRunnerError = Schema.Union([
  ProjectSetupScriptOperationError,
  ProjectSetupScriptProjectNotFoundError,
]);
export type ProjectSetupScriptRunnerError = typeof ProjectSetupScriptRunnerError.Type;

export class ProjectSetupScriptRunner extends Context.Service<
  ProjectSetupScriptRunner,
  {
    readonly runForThread: (
      input: ProjectSetupScriptRunnerInput,
    ) => Effect.Effect<ProjectSetupScriptRunnerResult, ProjectSetupScriptRunnerError>;
  }
>()("t3/project/ProjectSetupScriptRunner") {}

const WorktreePackageManifest = Schema.Struct({
  packageManager: Schema.optionalKey(Schema.String),
  scripts: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});

const decodeWorktreePackageManifest = Schema.decodeUnknownOption(
  Schema.fromJsonString(WorktreePackageManifest),
);

const conventionalBootstrapCommand = (packageManager: string | undefined) => {
  const name = packageManager?.split("@", 1)[0];
  switch (name) {
    case "bun":
    case "npm":
    case "pnpm":
    case "yarn":
      return `${name} run bootstrap:worktree`;
    default:
      return null;
  }
};

export const make = Effect.gen(function* () {
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const terminalManager = yield* TerminalManager.TerminalManager;
  const platform = yield* HostProcessPlatform;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const runForThread: ProjectSetupScriptRunner["Service"]["runForThread"] = Effect.fn(
    "ProjectSetupScriptRunner.runForThread",
  )(function* (input) {
    const errorContext = {
      threadId: input.threadId,
      worktreePath: input.worktreePath,
      ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
      ...(input.projectCwd === undefined ? {} : { projectCwd: input.projectCwd }),
    };
    const projectById = input.projectId
      ? yield* projectionSnapshotQuery.getProjectShellById(ProjectId.make(input.projectId)).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.mapError(
            (cause) =>
              new ProjectSetupScriptOperationError({
                ...errorContext,
                operation: "resolveProject",
                cause,
              }),
          ),
        )
      : null;
    const project =
      projectById ??
      (input.projectCwd
        ? yield* projectionSnapshotQuery.getActiveProjectByWorkspaceRoot(input.projectCwd).pipe(
            Effect.map(Option.getOrUndefined),
            Effect.mapError(
              (cause) =>
                new ProjectSetupScriptOperationError({
                  ...errorContext,
                  operation: "resolveProject",
                  cause,
                }),
            ),
          )
        : null);

    if (!project) {
      return yield* new ProjectSetupScriptProjectNotFoundError(errorContext);
    }

    const configuredScript = setupProjectScript(project.scripts);
    const script =
      configuredScript ??
      (yield* fileSystem.readFileString(path.join(input.worktreePath, "package.json")).pipe(
        Effect.map((raw) => {
          const manifest = decodeWorktreePackageManifest(raw);
          if (
            Option.isNone(manifest) ||
            typeof manifest.value.scripts?.["bootstrap:worktree"] !== "string"
          ) {
            return null;
          }
          const command = conventionalBootstrapCommand(manifest.value.packageManager);
          return command === null
            ? null
            : {
                id: "bootstrap-worktree",
                name: "Bootstrap Worktree",
                command,
              };
        }),
        Effect.catchTags({
          PlatformError: (cause) =>
            cause.reason._tag === "NotFound"
              ? Effect.succeed(null)
              : Effect.fail(
                  new ProjectSetupScriptOperationError({
                    ...errorContext,
                    operation: "resolveSetupScript",
                    cause,
                  }),
                ),
        }),
      ));
    if (!script) {
      return {
        status: "no-script",
      } as const;
    }

    const terminalId = input.preferredTerminalId ?? `setup-${script.id}`;
    const cwd = input.worktreePath;
    const env = projectScriptRuntimeEnv({
      project: { cwd: project.workspaceRoot },
      worktreePath: input.worktreePath,
    });

    yield* terminalManager
      .open({
        threadId: input.threadId,
        terminalId,
        cwd,
        worktreePath: input.worktreePath,
        env,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "openTerminal",
              cause,
            }),
        ),
      );

    const completionSignal = yield* Deferred.make<
      | {
          readonly type: "exited";
          readonly exitCode: number | null;
          readonly exitSignal: number | null;
        }
      | { readonly type: "error"; readonly message: string }
      | { readonly type: "closed" }
    >();
    const unsubscribe = yield* terminalManager.subscribe((event) => {
      if (event.threadId !== input.threadId || event.terminalId !== terminalId) {
        return Effect.void;
      }
      switch (event.type) {
        case "exited":
          return Deferred.succeed(completionSignal, {
            type: "exited",
            exitCode: event.exitCode,
            exitSignal: event.exitSignal,
          }).pipe(Effect.asVoid);
        case "error":
          return Deferred.succeed(completionSignal, {
            type: "error",
            message: event.message,
          }).pipe(Effect.asVoid);
        case "closed":
          return Deferred.succeed(completionSignal, { type: "closed" }).pipe(Effect.asVoid);
        case "started":
        case "output":
        case "cleared":
        case "restarted":
        case "activity":
          return Effect.void;
      }
    });
    const command =
      platform === "win32"
        ? `& { ${script.command} }; $t3SetupSucceeded = $?; $t3SetupExit = $LASTEXITCODE; if (-not $t3SetupSucceeded) { if ($null -ne $t3SetupExit -and $t3SetupExit -ne 0) { exit $t3SetupExit }; exit 1 }; exit 0`
        : `exec sh -lc '${script.command.replaceAll("'", `'"'"'`)}'`;
    yield* terminalManager
      .write({
        threadId: input.threadId,
        terminalId,
        data: `${command}\r`,
      })
      .pipe(
        Effect.mapError(
          (cause) =>
            new ProjectSetupScriptOperationError({
              ...errorContext,
              operation: "writeCommand",
              cause,
            }),
        ),
        Effect.tapError(() => Effect.sync(unsubscribe)),
      );

    const completion = Deferred.await(completionSignal).pipe(
      Effect.flatMap((event) => {
        if (event.type === "exited" && event.exitCode === 0) {
          return Effect.void;
        }
        const cause =
          event.type === "error"
            ? new Error(event.message)
            : event.type === "closed"
              ? new Error("Setup terminal closed before the command completed.")
              : new Error(
                  `Setup command exited with code ${event.exitCode ?? "unknown"} and signal ${event.exitSignal ?? "none"}.`,
                );
        return Effect.fail(
          new ProjectSetupScriptOperationError({
            ...errorContext,
            operation: "executeCommand",
            cause,
          }),
        );
      }),
      Effect.ensuring(Effect.sync(unsubscribe)),
    );

    return {
      status: "started",
      scriptId: script.id,
      scriptName: script.name,
      terminalId,
      cwd,
      completion,
    } as const;
  });

  return ProjectSetupScriptRunner.of({ runForThread });
});

export const layer = Layer.effect(ProjectSetupScriptRunner, make);
