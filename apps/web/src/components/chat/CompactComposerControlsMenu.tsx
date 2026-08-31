import { RuntimeMode } from "@t3tools/contracts";
import { memo, type ReactNode, useState } from "react";
import { EllipsisIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import {
  ComposerModePickerContent,
  resolveComposerPrimaryMode,
  type ComposerModeControls,
} from "./ComposerModePicker";

/**
 * The narrow footer's single overflow menu: traits, mode and access in one
 * popup. Workflow and skill catalogs open in the same full-size dialog used
 * by the regular composer footer.
 */
export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  /** Null when no mode, workflow or skill is offerable for this provider. */
  modeControls: ComposerModeControls | null;
  runtimeMode: RuntimeMode;
  traitsMenuContent?: ReactNode;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const { modeControls } = props;
  const [open, setOpen] = useState(false);
  const activeMode = modeControls ? resolveComposerPrimaryMode(modeControls) : null;
  const modeSection = modeControls ? (
    <ComposerModePickerContent
      activeMode={activeMode ?? "build"}
      buildSkills={modeControls.buildSkills}
      showPrimaryModes={modeControls.showPrimaryModes}
      workflowAvailable={modeControls.workflowAvailable}
      onOpenSkills={() => {
        setOpen(false);
        modeControls.onOpenCatalog("skills");
      }}
      onOpenWorkflow={() => {
        setOpen(false);
        modeControls.onOpenCatalog("workflows");
      }}
      onSelectPrimary={(mode) => {
        modeControls.onBuildSkillChange(null);
        modeControls.onInteractionModeChange(mode === "build" ? "default" : "plan", null);
        setOpen(false);
      }}
    />
  ) : null;
  return (
    <>
      <Menu open={open} onOpenChange={setOpen}>
        <MenuTrigger
          render={
            <Button
              size="sm"
              variant="ghost"
              className="shrink-0 px-2 text-muted-foreground/70 hover:text-foreground/80"
              aria-label="More composer controls"
            />
          }
        >
          <EllipsisIcon aria-hidden="true" className="size-4" />
        </MenuTrigger>
        <MenuPopup align="start">
          {props.traitsMenuContent ? (
            <>
              {props.traitsMenuContent}
              <MenuDivider />
            </>
          ) : null}
          {modeSection ? (
            <>
              <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
              {modeSection}
              <MenuDivider />
            </>
          ) : null}
          <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
          <MenuRadioGroup
            value={props.runtimeMode}
            onValueChange={(value) => {
              if (!value || value === props.runtimeMode) return;
              props.onRuntimeModeChange(value as RuntimeMode);
            }}
          >
            <MenuRadioItem value="approval-required">Supervised</MenuRadioItem>
            <MenuRadioItem value="auto-accept-edits">Auto-accept edits</MenuRadioItem>
            <MenuRadioItem value="auto">Auto</MenuRadioItem>
            <MenuRadioItem value="full-access">Full access</MenuRadioItem>
          </MenuRadioGroup>
        </MenuPopup>
      </Menu>
    </>
  );
});
