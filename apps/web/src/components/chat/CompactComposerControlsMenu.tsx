import { resolveComposerPrimaryMode } from "@t3tools/client-runtime/workflow-composer-mode";
import type { RuntimeMode } from "@t3tools/contracts";
import { memo, useRef } from "react";
import { EllipsisIcon } from "lucide-react";
import { Menu, MenuSeparator, MenuPopup, MenuTrigger } from "../ui/menu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { focusRequestedPermission, useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";
import { ComposerPermissionsSection, type RuntimeModeOption } from "./ComposerFooterControls";
import { ComposerModePickerContent, type ComposerModeControls } from "./ComposerModePicker";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  modeControls?: ComposerModeControls | undefined;
  runtimeMode: RuntimeMode;
  runtimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  showPermissions: boolean;
  size?: "sm" | "xs";
  /** Close the portaled popup when its trigger hides. */
  hidden?: boolean;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const size = props.size ?? "sm";
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const triggerRef = useRef<HTMLButtonElement>(null);

  return (
    <Menu
      open={open}
      onOpenChange={setOpen}
      onOpenChangeComplete={(isOpen) => focusRequestedPermission(isOpen, triggerRef.current)}
    >
      <MenuTrigger
        render={
          <ComposerControl
            ref={triggerRef}
            size={size}
            className="shrink-0"
            aria-label="More composer controls"
            data-composer-shortcut={props.showPermissions ? "composer.mode" : undefined}
          />
        }
      >
        <ComposerControlIcon icon={EllipsisIcon} size={size} />
      </MenuTrigger>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        {props.modeControls ? (
          <>
            <ComposerModePickerContent
              activeMode={resolveComposerPrimaryMode(props.modeControls)}
              buildSkills={props.modeControls.buildSkills}
              showPrimaryModes={props.modeControls.showPrimaryModes}
              workflowAvailable={props.modeControls.workflowAvailable}
              onOpenSkills={() => {
                setOpen(false);
                props.modeControls?.onOpenCatalog("skills");
              }}
              onOpenWorkflow={() => {
                setOpen(false);
                props.modeControls?.onOpenCatalog("workflows");
              }}
              onSelectPrimary={(mode) => {
                props.modeControls?.onBuildSkillChange(null);
                props.modeControls?.onInteractionModeChange(
                  mode === "build" ? "default" : "plan",
                  null,
                );
                setOpen(false);
              }}
            />
            {props.showPermissions ? <MenuSeparator /> : null}
          </>
        ) : null}
        {props.showPermissions ? (
          <ComposerPermissionsSection
            runtimeMode={props.runtimeMode}
            runtimeModeOptions={props.runtimeModeOptions}
            onRuntimeModeChange={props.onRuntimeModeChange}
          />
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
