import { useRef } from "react";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { useGT } from "gt-react";

import { Input } from "../ui/input";
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

function DefaultBranchRemoteRow() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { targets } = useSettingsScope();
  const scopeKey = targets.map((target) => `${target.environmentId}:${target.projectId}`).join(",");
  const mixed = useScopedSettingsMixed(["defaultBranchRemote"]);
  const edited = useRef(false);
  return (
    <SettingsRow
      serverScoped
      settingKeys={["defaultBranchRemote"]}
      {...searchableSetting("default-branch-remote")}
      description={gt(
        "Branch pickers list this remote’s branches with your local ones. Branches on other remotes sit behind Other remotes. Falls back to origin when the project has no such remote.",
      )}
      resetAction={
        mixed || settings.defaultBranchRemote !== DEFAULT_UNIFIED_SETTINGS.defaultBranchRemote ? (
          <SettingResetButton
            ariaLabel={gt("Reset default remote to default")}
            onClick={() =>
              updateSettings({ defaultBranchRemote: DEFAULT_UNIFIED_SETTINGS.defaultBranchRemote })
            }
          />
        ) : null
      }
      control={
        <Input
          key={`${scopeKey}:${mixed}:${settings.defaultBranchRemote}`}
          aria-label={gt("Default remote")}
          autoCapitalize="none"
          spellCheck={false}
          onChange={() => {
            edited.current = true;
          }}
          placeholder={mixed ? gt("Mixed") : "origin"}
          defaultValue={mixed ? "" : settings.defaultBranchRemote}
          onBlur={(event) => {
            const value = event.target.value.trim();
            if (edited.current && (mixed || value !== settings.defaultBranchRemote))
              updateSettings({ defaultBranchRemote: value });
            edited.current = false;
          }}
        />
      }
    />
  );
}

function BesideMainRow() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      serverScoped
      settingKeys={["newWorktreesBesideMain"]}
      {...searchableSetting("beside-main")}
      description={gt(
        "Creates a container-layout project’s new worktrees beside its main checkout instead of the worktrees location. A configured worktree location still overrides this.",
      )}
      resetAction={
        settings.newWorktreesBesideMain !== DEFAULT_UNIFIED_SETTINGS.newWorktreesBesideMain ? (
          <SettingResetButton
            ariaLabel={gt("Reset new worktrees beside the main checkout to default")}
            onClick={() =>
              updateSettings({
                newWorktreesBesideMain: DEFAULT_UNIFIED_SETTINGS.newWorktreesBesideMain,
              })
            }
          />
        ) : null
      }
      control={
        <ScopedSwitch
          settingKeys={["newWorktreesBesideMain"]}
          checked={settings.newWorktreesBesideMain}
          onCheckedChange={(checked) =>
            updateSettings({ newWorktreesBesideMain: Boolean(checked) })
          }
          aria-label={gt("Place new worktrees beside the project’s main checkout")}
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
        <StartFromRemoteRow />
        <BesideMainRow />
        <AdvancedSettings targetIds={[searchableSetting("worktree-submodules").id]}>
          <WorktreeSubmodulesRow />
        </AdvancedSettings>
      </SettingsSection>
      <SettingsSection id="worktree-branches" title={gt("Branches")}>
        <DefaultBranchRemoteRow />
        <BranchNamingSettings />
      </SettingsSection>
      <WorktreeCleanupSection />
    </SettingsPageContainer>
  );
}
