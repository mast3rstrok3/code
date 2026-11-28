import type { EnvironmentId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

import { msg } from "gt-react-native";

import type { AppBarMenuItem } from "../../components/ui/AppBar.types";
import { m, type MessageResolver } from "../../i18n/messages";
import type { WorkspaceEnvironment } from "../../state/workspaceModel";
import type { WorkspaceUserMenuScope } from "../workspace-users/workspaceUserMenu";

export interface HomeListFilterMenuEnvironment {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export function homeListFilterEnvironments(environments: ReadonlyArray<WorkspaceEnvironment>) {
  return Arr.sort(
    environments
      .filter((environment) => environment.isEnabled)
      .map((environment) => ({
        environmentId: environment.environmentId,
        label: environment.environmentLabel,
        connectionState: environment.connectionState,
      })),
    Order.mapInput(Order.String, (environment: { readonly label: string }) => environment.label),
  );
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

export function buildHomeListFilterMenuItems(
  props: {
    readonly environments: ReadonlyArray<HomeListFilterMenuEnvironment>;
    readonly projects: ReadonlyArray<HomeListFilterMenuProject>;
    readonly selectedEnvironmentId: EnvironmentId | null;
    readonly selectedProjectKey: string | null;
    readonly userScopes: ReadonlyArray<WorkspaceUserMenuScope>;
    readonly onEnvironmentChange: (environmentId: EnvironmentId | null) => void;
    readonly onProjectChange: (projectKey: string | null) => void;
    readonly onUserScopeChange: (environmentId: EnvironmentId, key: string) => void;
    readonly wizard?: HomeListWizardFilter;
  },
  resolve: MessageResolver = m,
): AppBarMenuItem[] {
  const wizard = props.wizard;
  const items: AppBarMenuItem[] = [
    ...(wizard !== undefined && (wizard.offered || wizard.active)
      ? [
          {
            id: "wizard",
            title: resolve(msg("Wizard", { $context: "filter menu heading" })),
            items: [
              {
                id: "wizard:all",
                title: resolve(msg("All threads")),
                selected: !wizard.active,
                onPress: () => wizard.onChange(false),
              },
              {
                id: "wizard:only",
                title: resolve(msg("Only Wizard threads")),
                subtitle: resolve(msg("Threads the Wizard API started")),
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
      title: resolve(msg("Environment", { $context: "filter menu heading" })),
      items: [
        {
          id: "environment:all",
          title: resolve(msg("All environments")),
          subtitle: resolve(msg("Show threads from every environment")),
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
      title: resolve(msg("Project", { $context: "filter menu heading" })),
      items: [
        {
          id: "project:all",
          title: resolve(msg("All projects")),
          subtitle: resolve(msg("Show threads from every project")),
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
