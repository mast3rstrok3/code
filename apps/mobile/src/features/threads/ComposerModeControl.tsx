import type { MenuAction } from "@react-native-menu/menu";
import type { ProviderInteractionMode, WorkflowPreset } from "@t3tools/contracts";
import {
  describeComposerMode,
  resolveComposerPrimaryMode,
} from "@t3tools/client-runtime/workflow-composer-mode";
import { WORKFLOW_PRESET_DEFINITIONS } from "@t3tools/shared/workflowPresets";
import * as Haptics from "expo-haptics";

import { ComposerInlineControl } from "../../components/ComposerToolbar";
import { Menu } from "../../components/ui/Menu";
import type { AppSymbolName } from "../../components/ui/AppSymbol";
import type { ComposerModeChoice } from "../../state/composer-workflow";

const MODE_ICON = {
  build: { ios: "hammer", android: "construction" },
  plan: { ios: "list.bullet.clipboard", android: "auto_awesome" },
  workflow: "point.3.connected.trianglepath.dotted",
  skill: { ios: "hammer", android: "construction" },
} as const satisfies Record<string, AppSymbolName>;

export interface ComposerModeControlProps {
  readonly interactionMode: ProviderInteractionMode;
  readonly workflowPreset: WorkflowPreset | null;
  readonly lastWorkflowPreset: WorkflowPreset | null;
  /** The provider can run workflows (Codex, Claude, OpenCode). */
  readonly workflowAvailable: boolean;
  readonly planAvailable: boolean;
  readonly disabled?: boolean;
  readonly iconOnly?: boolean;
  readonly onSelect: (choice: ComposerModeChoice) => void;
}

/** Whether the composer has a choice to offer beyond plain Build. */
export function composerModeControlVisible(input: {
  readonly workflowAvailable: boolean;
  readonly planAvailable: boolean;
  readonly workflowPreset: WorkflowPreset | null;
}): boolean {
  return input.workflowAvailable || input.planAvailable || input.workflowPreset !== null;
}

/** Build, Plan, and the Engineering workflow variants, in the composer's own menu. */
export function ComposerModeControl(props: ComposerModeControlProps) {
  const display = describeComposerMode({
    interactionMode: props.interactionMode,
    workflowPreset: props.workflowPreset,
    lastWorkflowPreset: props.lastWorkflowPreset,
    buildSkills: [],
    selectedBuildSkillId: null,
  });
  const activeMode = resolveComposerPrimaryMode(props);
  const actions: MenuAction[] = [
    {
      id: "mode:build",
      title: "Build",
      subtitle: "Make implementation changes.",
      state: activeMode === "build" ? "on" : "off",
    },
    ...(props.planAvailable
      ? [
          {
            id: "mode:plan",
            title: "Plan",
            subtitle: "Plan without changing files.",
            state: activeMode === "plan" ? ("on" as const) : ("off" as const),
          },
        ]
      : []),
    props.workflowAvailable
      ? {
          id: "workflow",
          title: "Engineering workflow",
          subtitle:
            activeMode === "workflow" ? (display.shortLabel ?? undefined) : "Choose a variant.",
          state: activeMode === "workflow" ? "on" : "off",
          subactions: WORKFLOW_PRESET_DEFINITIONS.map((definition) => ({
            id: `workflow:${definition.id}`,
            title:
              definition.availability === "under-development"
                ? `${definition.label} · Soon`
                : definition.label,
            subtitle: definition.description,
            state: props.workflowPreset === definition.id ? ("on" as const) : ("off" as const),
            attributes: { disabled: definition.availability === "under-development" },
          })),
        }
      : {
          id: "workflow",
          title: "Engineering workflow",
          subtitle: "Available for Codex, Claude, and OpenCode providers.",
          attributes: { disabled: true },
        },
  ];

  return (
    <Menu
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        const choice = parseComposerModeAction(nativeEvent.event);
        if (choice === null) return;
        void Haptics.selectionAsync();
        props.onSelect(choice);
      }}
    >
      <ComposerInlineControl
        accessibilityLabel={`Mode: ${display.label}`}
        accessibilityHint="Chooses Build, Plan, or an Engineering workflow"
        disabled={props.disabled}
        emphasized={activeMode !== "build"}
        icon={MODE_ICON[display.kind]}
        iconOnly={props.iconOnly}
        label={display.shortLabel ?? display.label}
      />
    </Menu>
  );
}

function parseComposerModeAction(id: string): ComposerModeChoice | null {
  if (id === "mode:build") return { kind: "build" };
  if (id === "mode:plan") return { kind: "plan" };
  if (!id.startsWith("workflow:")) return null;
  const preset = WORKFLOW_PRESET_DEFINITIONS.find(
    (definition) =>
      `workflow:${definition.id}` === id && definition.availability !== "under-development",
  )?.id;
  return preset === undefined ? null : { kind: "workflow", preset };
}
