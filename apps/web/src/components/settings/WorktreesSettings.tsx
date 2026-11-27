import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useGT } from "gt-react";

import { DraftInput } from "../ui/draft-input";
import { AdvancedSettings } from "./AdvancedSettings";
import { BranchNamingSettings } from "./BranchNamingSettings";
import { WorktreeSubmodulesRow } from "./ProjectDefaultsSettings";
import { ScopedSwitch } from "./ScopedSwitch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { WorktreeCleanupSection, WorktreesDirectoryRow } from "./StorageSettings";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

function DevelopmentBranchRow() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const mixed = useScopedSettingsMixed(["worktreeBaseBranch"]);
  return (
    <SettingsRow
      serverScoped
      settingKeys={["worktreeBaseBranch"]}
      {...searchableSetting("worktree-base-branch")}
      description={gt(
        "New worktrees start from this branch unless you pick another. Leave empty to use dev when the repository has it, else its default branch.",
      )}
      resetAction={
        mixed || settings.worktreeBaseBranch !== null ? (
          <SettingResetButton
            ariaLabel={gt("Reset development branch to default")}
            onClick={() => updateSettings({ worktreeBaseBranch: null })}
          />
        ) : null
      }
      control={
        <DraftInput
          size="sm"
          className="w-full sm:w-48"
          value={mixed ? "" : (settings.worktreeBaseBranch ?? "")}
          onCommit={(next) => {
            const branch = next.trim();
            updateSettings({ worktreeBaseBranch: branch === "" ? null : branch });
          }}
          placeholder={mixed ? gt("Mixed") : gt("dev, else default")}
          autoCapitalize="none"
          spellCheck={false}
          aria-label={gt("Development branch")}
        />
      }
    />
  );
}

function StartFromRemoteRow() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["newWorktreesStartFromOrigin"]}
      {...searchableSetting("start-from-origin")}
      description={gt(
        "Uses the latest commit of the base branch’s tracked remote branch, even if its name differs. Otherwise uses the same-named branch on origin. Uses your local branch if that remote branch is missing.",
      )}
      resetAction={
        settings.newWorktreesStartFromOrigin !==
        DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin ? (
          <SettingResetButton
            ariaLabel={gt("Reset new worktrees start from remote to default")}
            onClick={() =>
              updateSettings({
                newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["newWorktreesStartFromOrigin"]}
          checked={settings.newWorktreesStartFromOrigin}
          onCheckedChange={(checked) =>
            updateSettings({ newWorktreesStartFromOrigin: Boolean(checked) })
          }
          aria-label={gt("Start new worktrees from remote by default")}
        />
      }
    />
  );
}

export function WorktreesSettingsPanel() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const { scope } = useSettingsScope();
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";

  return (
    <SettingsPageContainer>
      <SettingsSection
        id="worktree-creation"
        title={gt("Creation", { $context: "settings section about creating worktrees" })}
      >
        {!isProjectScope && <WorktreesDirectoryRow />}
        <DevelopmentBranchRow />
        <StartFromRemoteRow />
        <AdvancedSettings targetIds={[searchableSetting("worktree-submodules").id]}>
          <WorktreeSubmodulesRow />
        </AdvancedSettings>
      </SettingsSection>
      <SettingsSection id="worktree-branches" title={gt("Branches")}>
        <BranchNamingSettings />
      </SettingsSection>
      <WorktreeCleanupSection />
    </SettingsPageContainer>
  );
}
