import type {
  OrchestrationPlanningTicket,
  OrchestrationProject,
  ProjectId,
} from "@t3tools/contracts";

type ProjectChoiceSource = Pick<
  OrchestrationProject,
  "id" | "title" | "workspaceRoot" | "ownerUserId" | "repositoryIdentity" | "deletedAt"
>;

/**
 * The projects a workflow's tickets can change besides the workflow's own.
 *
 * A ticket names one with `projectId`; leaving it out keeps the ticket in the
 * workflow's project. Another checkout of the workflow's own repository is not
 * a choice: its branches would be the same repository's branches.
 */
export function ticketRepositoryChoices<Project extends ProjectChoiceSource>(
  projects: ReadonlyArray<Project>,
  workflowProjectId: ProjectId,
): ReadonlyArray<Project> {
  const workflowProject = projects.find((project) => project.id === workflowProjectId);
  if (workflowProject === undefined) return [];
  const workflowRepository = workflowProject.repositoryIdentity?.canonicalKey;
  return projects.filter(
    (project) =>
      project.id !== workflowProject.id &&
      project.deletedAt === null &&
      project.ownerUserId === workflowProject.ownerUserId &&
      (workflowRepository === undefined ||
        project.repositoryIdentity?.canonicalKey !== workflowRepository),
  );
}

/** Prompt lines that let a ticket author choose a repository, or none when there is no choice. */
export function ticketRepositoryPromptLines(
  choices: ReadonlyArray<ProjectChoiceSource>,
): ReadonlyArray<string> {
  if (choices.length === 0) return [];
  return [
    "A ticket changes this workflow's repository unless it sets `projectId` to one of the projects below. Inspect a ticket's repository at its path before planning it; its plannedFileChanges and appReviewCommands are relative to that repository. Keep each ticket in one repository, and make a ticket that needs another repository's change depend on the ticket making it.",
    ...choices.map(
      (project) => `- ${project.title} (projectId: ${project.id}) at ${project.workspaceRoot}`,
    ),
  ];
}

/**
 * Checks the repositories tickets name against the workflow's choices.
 *
 * A ticket naming the workflow's own project loses the field, so every ticket
 * with `projectId` set really is in another repository.
 */
export function resolveTicketProjects(input: {
  readonly tickets: ReadonlyArray<OrchestrationPlanningTicket>;
  readonly workflowProjectId: ProjectId;
  readonly choices: ReadonlyArray<Pick<OrchestrationProject, "id">>;
}): OrchestrationPlanningTicket[] | string {
  const choiceIds = new Set<string>(input.choices.map((project) => project.id));
  const resolved: OrchestrationPlanningTicket[] = [];
  for (const ticket of input.tickets) {
    if (ticket.projectId === undefined) {
      resolved.push(ticket);
      continue;
    }
    if (ticket.projectId === input.workflowProjectId) {
      const { projectId: _ownProject, ...rest } = ticket;
      resolved.push(rest);
      continue;
    }
    if (!choiceIds.has(ticket.projectId)) {
      return `Planning Ticket '${ticket.key ?? ticket.id}' names project '${ticket.projectId}', which is not a repository this workflow can change.`;
    }
    resolved.push(ticket);
  }
  return resolved;
}
