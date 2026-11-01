import {
  DEFAULT_PROVIDER_INTERACTION_MODE,
  type ProviderInteractionMode,
  type ServerProvider,
} from "@t3tools/contracts";

type InteractionModeProvider = Pick<ServerProvider, "showInteractionModeToggle">;

// Workflow modes are chosen with a workflow preset, not the Plan toggle, so a
// provider without that toggle keeps them; the web composer does the same.
export function resolveProviderInteractionMode(
  provider: InteractionModeProvider | null | undefined,
  interactionMode: ProviderInteractionMode | null | undefined,
): ProviderInteractionMode {
  return provider?.showInteractionModeToggle === false && !interactionMode?.endsWith("-workflow")
    ? DEFAULT_PROVIDER_INTERACTION_MODE
    : (interactionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE);
}

export function resolveLegacyPlanModeEnabled(input: {
  readonly loaded: boolean;
  readonly preference: boolean | undefined;
}): boolean {
  return input.loaded && input.preference === true;
}

export function resolvePendingTaskInteractionMode(input: {
  readonly planModeEnabled: boolean;
  readonly draftInteractionMode: ProviderInteractionMode | undefined;
  readonly provider?: InteractionModeProvider | null;
}): ProviderInteractionMode {
  if (input.draftInteractionMode?.endsWith("-workflow")) {
    return input.draftInteractionMode;
  }
  if (input.provider?.showInteractionModeToggle === false || !input.planModeEnabled) {
    return DEFAULT_PROVIDER_INTERACTION_MODE;
  }
  return input.draftInteractionMode ?? DEFAULT_PROVIDER_INTERACTION_MODE;
}
