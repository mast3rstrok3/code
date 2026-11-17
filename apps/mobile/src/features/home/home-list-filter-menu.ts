import type { EnvironmentId } from "@t3tools/contracts";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import type { WorkspaceUserMenuScope } from "../workspace-users/workspaceUserMenu";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface HomeListFilterMenuProject {
  readonly key: string;
  readonly label: string;
}

/** The "only Wizard threads" filter, offered once a Wizard thread is loaded. */
export interface HomeListWizardFilter {
  readonly offered: boolean;
  readonly active: boolean;
  readonly onChange: (active: boolean) => void;
}

export function buildHomeListFilterMenuItems(props: {
  readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
  readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly selectedProjectKey: string | null;
  readonly userScopes: ReadonlyArray<WorkspaceUserMenuScope>;
  readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
  readonly onProjectChange: (projectKey: string | null) => void;
  readonly onUserScopeChange: (environmentId: EnvironmentId, key: string) => void;
  readonly wizard?: HomeListWizardFilter;
}): AppBarMenuItem[] {
  const wizard = props.wizard;
  const items: AppBarMenuItem[] = [
    ...(wizard !== undefined && (wizard.offered || wizard.active)
      ? [
          {
            id: "wizard",
            title: "Wizard",
            items: [
              {
                id: "wizard:all",
                title: "All threads",
                selected: !wizard.active,
                onPress: () => wizard.onChange(false),
              },
              {
                id: "wizard:only",
                title: "Only Wizard threads",
                subtitle: "Threads the Wizard API started",
                icon: "wand.and.stars",
                selected: wizard.active,
                onPress: () => wizard.onChange(true),
              },
            ],
          },
        ]
      : []),
    ...props.userScopes.map((scope) => ({
      id: `workspace-user:${scope.environmentId}`,
      title: scope.title,
      items: scope.options.map((option) => ({
        id: `workspace-user:${scope.environmentId}:${option.key}`,
        title: option.title,
        selected: option.selected,
        onPress: () => props.onUserScopeChange(scope.environmentId, option.key),
      })),
    })),
    {
      id: "environment",
      title: "Environment",
      items: [
        {
          id: "environment:all",
          title: "All environments",
          subtitle: "Show threads from every environment",
          selected: props.selectedEnvironmentId === null,
          onPress: () => props.onEnvironmentChange(null),
        },
        ...props.environments.map((environment) => ({
          id: `environment:${environment.environmentId}`,
          title: environment.label,
          selected: props.selectedEnvironmentId === environment.environmentId,
          onPress: () => props.onEnvironmentChange(environment.environmentId),
        })),
      ],
    },
  ];

  if (props.projects.length > 0) {
    items.push({
      id: "project",
      title: "Project",
      items: [
        {
          id: "project:all",
          title: "All projects",
          subtitle: "Show threads from every project",
          selected: props.selectedProjectKey === null,
          onPress: () => props.onProjectChange(null),
        },
        ...props.projects.map((project) => ({
          id: `project:${project.key}`,
          title: project.label,
          selected: props.selectedProjectKey === project.key,
          onPress: () => props.onProjectChange(project.key),
        })),
      ],
    });
  }

  return items;
}
