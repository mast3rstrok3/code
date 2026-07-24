import { ProviderInteractionMode, RuntimeMode, WorkflowPreset } from "@t3tools/contracts";
import { interactionModeForWorkflowPreset } from "@t3tools/shared/workflowPresets";
import { memo, type ReactNode, useState } from "react";
import { EllipsisIcon, ListTodoIcon } from "lucide-react";
import { Button } from "../ui/button";
import {
  Menu,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import {
  ComposerModePickerContent,
  resolveComposerPrimaryMode,
  resolveWorkflowPresetForPicker,
  type ComposerModePickerView,
} from "./ComposerModePicker";

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  activePlan: boolean;
  interactionMode: ProviderInteractionMode;
  workflowPreset: WorkflowPreset | null;
  lastWorkflowPreset: WorkflowPreset | null;
  planSidebarLabel: string;
  planSidebarOpen: boolean;
  planningWorkflowAvailable: boolean;
  runtimeMode: RuntimeMode;
  showInteractionModeToggle: boolean;
  traitsMenuContent?: ReactNode;
  onInteractionModeChange: (mode: ProviderInteractionMode, preset: WorkflowPreset | null) => void;
  onTogglePlanSidebar: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const activeMode = resolveComposerPrimaryMode(props);
  const displayedPreset = resolveWorkflowPresetForPicker(props);
  const [open, setOpen] = useState(false);
  const [modeView, setModeView] = useState<ComposerModePickerView>(
    activeMode === "workflow" ? "workflow" : "primary",
  );
  return (
    <Menu
      open={open}
      onOpenChange={(nextOpen) => {
        setOpen(nextOpen);
        if (nextOpen) setModeView(activeMode === "workflow" ? "workflow" : "primary");
      }}
    >
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
        {props.showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <ComposerModePickerContent
              activeMode={activeMode}
              activePreset={activeMode === "workflow" ? displayedPreset : null}
              onBack={() => setModeView("primary")}
              onOpenWorkflow={() => setModeView("workflow")}
              onSelectPrimary={(mode) => {
                props.onInteractionModeChange(mode === "build" ? "default" : "plan", null);
                setOpen(false);
              }}
              onSelectPreset={(preset) => {
                props.onInteractionModeChange(interactionModeForWorkflowPreset(preset), preset);
                setOpen(false);
              }}
              view={modeView}
              workflowAvailable={props.planningWorkflowAvailable}
            />
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
        {props.activePlan ? (
          <>
            <MenuDivider />
            <MenuItem onClick={props.onTogglePlanSidebar}>
              <ListTodoIcon className="size-4 shrink-0" />
              {props.planSidebarOpen
                ? `Hide ${props.planSidebarLabel.toLowerCase()} sidebar`
                : `Show ${props.planSidebarLabel.toLowerCase()} sidebar`}
            </MenuItem>
          </>
        ) : null}
      </MenuPopup>
    </Menu>
  );
});
