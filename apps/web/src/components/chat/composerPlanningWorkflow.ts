import {
  isPlanningWorkflowInteractionMode,
  ProviderDriverKind,
  type ProviderInteractionMode,
} from "@t3tools/contracts";

export const PLANNING_WORKFLOW_PROVIDERS: ReadonlySet<ProviderDriverKind> = new Set([
  ProviderDriverKind.make("codex"),
  ProviderDriverKind.make("claudeAgent"),
]);

export function isPlanningWorkflowAvailableForProvider(
  provider: ProviderDriverKind | null | undefined,
): boolean {
  return provider !== null && provider !== undefined && PLANNING_WORKFLOW_PROVIDERS.has(provider);
}

export function resolveComposerInteractionModeForProvider(input: {
  interactionMode: ProviderInteractionMode;
  provider: ProviderDriverKind | null | undefined;
}): ProviderInteractionMode {
  if (
    (isPlanningWorkflowInteractionMode(input.interactionMode) ||
      input.interactionMode === "implementation-workflow") &&
    !isPlanningWorkflowAvailableForProvider(input.provider)
  ) {
    return "default";
  }
  return input.interactionMode;
}
