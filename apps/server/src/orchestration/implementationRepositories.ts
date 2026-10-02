import type {
  OrchestrationImplementationRepository,
  OrchestrationImplementationRun,
  OrchestrationPlanningTicket,
  OrchestrationProject,
  ProjectId,
} from "@t3tools/contracts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { GitWorkflowService } from "../git/GitWorkflowService.ts";
import type { T3ProjectFileLoader } from "../project/T3ProjectFileLoader.ts";

/** A repository a ticket names cannot be prepared for the run. */
export class ImplementationRepositoryError extends Data.TaggedError(
  "ImplementationRepositoryError",
)<{
  readonly message: string;
}> {}

/**
 * Prepares the record of every other repository the tickets change.
 *
 * Each repository works from the workflow's base branch when it has one of
 * that name, otherwise from whatever its checkout is on, pinned to the
 * remote's copy when there is one. Its integration worktree takes the
 * orchestrator branch's name at the path git would choose for that branch, so
 * the run's branches line up across repositories. Nothing is created here;
 * the run creates the worktrees once it launches.
 */
export const resolveImplementationRepositories = Effect.fn("resolveImplementationRepositories")(
  function* (input: {
    readonly gitWorkflow: GitWorkflowService["Service"];
    readonly path: Path.Path;
    readonly projects: ReadonlyArray<Pick<OrchestrationProject, "id" | "workspaceRoot">>;
    readonly tickets: ReadonlyArray<Pick<OrchestrationPlanningTicket, "projectId">>;
    readonly workflowProjectId: ProjectId;
    readonly baseBranch: string;
    readonly orchestratorBranch: string;
    readonly worktreesDir: string;
  }) {
    const path = input.path;
    const projectIds = [
      ...new Set(
        input.tickets.flatMap((ticket) =>
          ticket.projectId === undefined || ticket.projectId === input.workflowProjectId
            ? []
            : [ticket.projectId],
        ),
      ),
    ];
    return yield* Effect.forEach(projectIds, (projectId) =>
      Effect.gen(function* () {
        const project = input.projects.find((candidate) => candidate.id === projectId);
        if (project === undefined) {
          return yield* new ImplementationRepositoryError({
            message: `A ticket changes project '${projectId}', which no longer exists.`,
          });
        }
        const cwd = project.workspaceRoot;
        const hasOrigin = yield* input.gitWorkflow
          .remoteExists({ cwd, remoteName: "origin" })
          .pipe(Effect.orElseSucceed(() => false));
        const onRemote = (refName: string) =>
          hasOrigin
            ? input.gitWorkflow.fetchRemote({ cwd, remoteName: "origin", refName }).pipe(
                Effect.ignore,
                Effect.andThen(
                  input.gitWorkflow.remoteBranchExists({ cwd, remoteName: "origin", refName }),
                ),
                Effect.orElseSucceed(() => false),
              )
            : Effect.succeed(false);
        const onLocal = (refName: string) =>
          input.gitWorkflow.resolveCommit({ cwd, ref: `refs/heads/${refName}` }).pipe(
            Effect.as(true),
            Effect.orElseSucceed(() => false),
          );
        let baseBranch = input.baseBranch;
        let baseOnRemote = yield* onRemote(baseBranch);
        if (!baseOnRemote && !(yield* onLocal(baseBranch))) {
          const status = yield* input.gitWorkflow.localStatus({ cwd });
          if (status.refName === null) {
            return yield* new ImplementationRepositoryError({
              message: `The checkout of project '${projectId}' at ${cwd} has neither branch '${input.baseBranch}' nor a checked-out branch to start from.`,
            });
          }
          baseBranch = status.refName;
          baseOnRemote = yield* onRemote(baseBranch);
        }
        const pinnedCommit = baseOnRemote
          ? (yield* input.gitWorkflow.resolveRemoteTrackingCommit({
              cwd,
              refName: baseBranch,
              fallbackRemoteName: "origin",
            })).commitSha
          : (yield* input.gitWorkflow.resolveCommit({ cwd, ref: `refs/heads/${baseBranch}` }))
              .commitSha;
        return {
          projectId,
          repositoryPath: cwd,
          worktreePath: path.join(
            input.worktreesDir,
            path.basename(cwd),
            input.orchestratorBranch.replace(/\//g, "-"),
          ),
          baseBranch,
          pinnedCommit,
          appReviewedHeadSha: null,
          codeReviewedHeadSha: null,
          validatedHeadSha: null,
          changeRequest: null,
        } satisfies OrchestrationImplementationRepository;
      }),
    );
  },
);

/** The run repository a ticket works in, or undefined for the orchestrator's own. */
export function ticketRunRepository(
  run: Pick<OrchestrationImplementationRun, "repositories" | "launchSummary">,
  ticketId: string,
): OrchestrationImplementationRepository | undefined {
  const projectId = run.launchSummary.plannedWorkers.find(
    (worker) => worker.ticketId === ticketId,
  )?.projectId;
  return projectId === undefined
    ? undefined
    : run.repositories.find((repository) => repository.projectId === projectId);
}

/** The worktree a ticket's repository integrates into, which its git commands run from. */
export function ticketRepositoryWorktreePath(
  run: Pick<
    OrchestrationImplementationRun,
    "repositories" | "launchSummary" | "orchestratorWorktreePath"
  >,
  ticketId: string,
): string {
  return ticketRunRepository(run, ticketId)?.worktreePath ?? run.orchestratorWorktreePath;
}

/**
 * A validation command that runs in a run repository's worktree from any
 * directory. The gates match results to commands by their text, so a
 * repository's commands join the run's list in this form and are validated
 * like the orchestrator's own.
 */
export function repositoryValidationCommand(worktreePath: string, command: string): string {
  return `cd '${worktreePath.replaceAll("'", `'\\''`)}' && ${command}`;
}

/**
 * The complete validation every other repository declares in its own
 * t3.json, as commands the run's gates can run. The orchestrator's default
 * commands belong to its own repository and are not repeated here.
 */
export const repositoryValidationCommands = Effect.fn("repositoryValidationCommands")(function* (
  projectFileLoader: T3ProjectFileLoader["Service"],
  repositories: ReadonlyArray<OrchestrationImplementationRepository>,
) {
  const commands = yield* Effect.forEach(repositories, (repository) =>
    projectFileLoader
      .load(repository.repositoryPath)
      .pipe(
        Effect.map((loaded) =>
          (Option.getOrUndefined(loaded)?.validationCommands ?? []).map((command) =>
            repositoryValidationCommand(repository.worktreePath, command),
          ),
        ),
      ),
  );
  return commands.flat();
});
