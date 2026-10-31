import type { MenuAction } from "@react-native-menu/menu";
import * as Haptics from "expo-haptics";
import { Pressable } from "react-native";

import { SymbolView } from "../../components/ui/AppSymbol";
import * as Dialog from "../../components/ui/Dialog";
import { Menu } from "../../components/ui/Menu";
import type { WorkflowScopeControls } from "./workflowSheetModel";

export interface WorkflowScopeHandlers {
  readonly onStop: (controls: WorkflowScopeControls) => void;
  readonly onResume: (controls: WorkflowScopeControls) => void;
  readonly onRestart: (controls: WorkflowScopeControls) => void;
  readonly onClear: (controls: WorkflowScopeControls) => void;
  readonly onSetSkipped: (controls: WorkflowScopeControls, skipped: boolean) => void;
}

/** The step, wave, and ticket menu: the web settings popover's actions as a native menu. */
export function WorkflowScopeMenu(props: {
  readonly controls: WorkflowScopeControls;
  readonly handlers: WorkflowScopeHandlers;
  readonly disabled: boolean;
  readonly onOpenSettings?: (() => void) | undefined;
}) {
  const { controls } = props;
  const noun = controls.noun;
  const paused = controls.pausedScopeThreadIds.length > 0;
  const actions: MenuAction[] = [
    paused
      ? { id: "resume", title: `Resume ${noun}`, image: "play" }
      : {
          id: "stop",
          title: `Stop ${noun}`,
          image: "stop.fill",
          ...(controls.runningThreadIds.length === 0
            ? { subtitle: `Nothing is running in this ${noun}`, attributes: { disabled: true } }
            : {}),
        },
    {
      id: "restart",
      title: `Start ${noun} again`,
      image: "arrow.clockwise",
      ...(controls.restart === null || controls.restartDisabledReason !== null
        ? {
            subtitle:
              controls.restartDisabledReason ?? `This ${noun} cannot be started on its own.`,
            attributes: { disabled: true },
          }
        : {}),
    },
    ...(controls.clear === null
      ? []
      : [
          {
            id: "clear",
            title: `Clear ${noun}`,
            image: "eraser",
            ...(controls.clearDisabledReason === null
              ? { attributes: { destructive: true } }
              : {
                  subtitle: controls.clearDisabledReason,
                  attributes: { destructive: true, disabled: true },
                }),
          } satisfies MenuAction,
        ]),
    ...(controls.skip === null
      ? []
      : [
          {
            id: "skip",
            title: controls.skip.skipped ? `Stop skipping ${noun}` : `Skip ${noun}`,
            image: "forward.end",
          } satisfies MenuAction,
        ]),
    ...(props.onOpenSettings === undefined
      ? []
      : [{ id: "settings", title: "Models and cycles", image: "slider.horizontal.3" }]),
  ];

  return (
    <Menu
      title={controls.label}
      actions={actions}
      onPressAction={({ nativeEvent }) => {
        void Haptics.selectionAsync();
        switch (nativeEvent.event) {
          case "stop":
            props.handlers.onStop(controls);
            return;
          case "resume":
            props.handlers.onResume(controls);
            return;
          case "restart":
            props.handlers.onRestart(controls);
            return;
          case "clear":
            // Clearing is one tap from discarding recorded results, so it asks first.
            Dialog.confirm({
              title: `Clear ${controls.label}?`,
              message: controls.confirmClearMessage,
              confirmText: `Clear ${noun}`,
              destructive: true,
              onConfirm: () => props.handlers.onClear(controls),
            });
            return;
          case "skip":
            props.handlers.onSetSkipped(controls, !(controls.skip?.skipped ?? false));
            return;
          case "settings":
            props.onOpenSettings?.();
            return;
        }
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Actions for ${controls.label}`}
        disabled={props.disabled}
        hitSlop={8}
        className="size-9 items-center justify-center rounded-full active:bg-subtle"
        style={{ opacity: props.disabled ? 0.45 : 1 }}
      >
        <SymbolView
          name="ellipsis.circle"
          size={18}
          tintColorClassName="accent-icon-muted"
          type="monochrome"
        />
      </Pressable>
    </Menu>
  );
}
