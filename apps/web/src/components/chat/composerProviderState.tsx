import {
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderOptionSelection,
  type ScopedThreadRef,
  type ServerProviderModel,
} from "@t3tools/contracts";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionCurrentValue,
  getProviderOptionDescriptors,
  isClaudeUltrathinkPrompt,
} from "@t3tools/shared/model";
import type { ReactNode } from "react";

import type { DraftId } from "../../composerDraftStore";
import { getProviderModelCapabilities } from "../../providerModels";
import {
  shouldRenderTraitsControls,
  TraitsMenuContent,
  TraitsPicker,
  type ComposerModeControls,
} from "./TraitsPicker";

export type ComposerProviderStateInput = {
  provider: ProviderDriverKind;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  promptInjectionState?: ComposerPromptInjectionState;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | null | undefined;
};

export type ComposerPromptInjectionState = "none" | "ultrathink";

export type ComposerProviderState = {
  provider: ProviderDriverKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ReadonlyArray<ProviderOptionSelection> | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

type TraitsRenderInput = {
  provider: ProviderDriverKind;
  instanceId?: ProviderInstanceId;
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  prompt: string;
  onPromptChange: (prompt: string) => void;
  /**
   * Composer-only. When present the control also renders the mode section, so
   * it must survive providers whose model advertises no traits at all.
   */
  modeControls?: ComposerModeControls;
};

export function getComposerPromptInjectionState(prompt: string): ComposerPromptInjectionState {
  return isClaudeUltrathinkPrompt(prompt) ? "ultrathink" : "none";
}

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  const { provider, model, models, modelOptions, promptInjectionState = "none" } = input;
  const caps = getProviderModelCapabilities(models, model, provider);
  const descriptors = getProviderOptionDescriptors({ caps, selections: modelOptions });
  const primarySelectDescriptor = descriptors.find(
    (descriptor): descriptor is Extract<(typeof descriptors)[number], { type: "select" }> =>
      descriptor.type === "select",
  );
  const primaryValue = getProviderOptionCurrentValue(primarySelectDescriptor ?? null);
  const promptEffort = typeof primaryValue === "string" ? primaryValue : null;
  const ultrathinkActive =
    (primarySelectDescriptor?.promptInjectedValues?.length ?? 0) > 0 &&
    promptInjectionState === "ultrathink";

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: buildProviderOptionSelectionsFromDescriptors(descriptors),
    ...(ultrathinkActive
      ? {
          composerFrameClassName: "ultrathink-frame",
          composerSurfaceClassName: "shadow-[0_0_0_1px_rgba(255,255,255,0.07)_inset]",
          modelPickerIconClassName: "ultrathink-chroma",
        }
      : {}),
  };
}

function traitsControlProps(input: TraitsRenderInput) {
  const { provider, instanceId, threadRef, draftId, model, models, modelOptions, prompt } = input;
  const hasTarget = threadRef !== undefined || draftId !== undefined;
  if (!hasTarget) {
    return null;
  }
  return {
    provider,
    ...(instanceId ? { instanceId } : {}),
    models,
    ...(threadRef ? { threadRef } : {}),
    ...(draftId ? { draftId } : {}),
    model,
    modelOptions,
    prompt,
    onPromptChange: input.onPromptChange,
    hasTraits: shouldRenderTraitsControls({ provider, models, model, modelOptions, prompt }),
  };
}

export function renderProviderTraitsMenuContent(input: TraitsRenderInput): ReactNode {
  const props = traitsControlProps(input);
  if (!props?.hasTraits) {
    return null;
  }
  const { hasTraits: _hasTraits, ...rest } = props;
  return <TraitsMenuContent {...rest} />;
}

export function renderProviderTraitsPicker(input: TraitsRenderInput): ReactNode {
  const props = traitsControlProps(input);
  // The mode section is reason enough to render: a model with no reasoning or
  // context-window options still needs somewhere to pick a workflow.
  if (!props || (!props.hasTraits && !input.modeControls)) {
    return null;
  }
  const { hasTraits: _hasTraits, ...rest } = props;
  return (
    <TraitsPicker {...rest} {...(input.modeControls ? { modeControls: input.modeControls } : {})} />
  );
}
