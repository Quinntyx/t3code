import {
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { supportsSharedSettingsSync } from "@t3tools/client-runtime/state/shared-settings";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { useEnvironmentsWithScope } from "../../state/session";
import { planAutoSettleSettingsSync, type AutoSettleSettings } from "./autoSettleSettingsSync";
import { AutoSettleDaysField } from "./components/AutoSettleDaysField";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import { resolveMobileSettingsTargets, uniformMobileSetting } from "./settings-scoped-server";

const AUTO_SETTLE_DEFAULT_DAYS = DEFAULT_SERVER_SETTINGS.sidebarAutoSettleAfterDays ?? 3;

/**
 * Usage-limit and auto-settle rows. The Threads page owns their writes, so they share its queue
 * with the page's other project overrides, and their project override reset.
 */
export function AutoSettleSettingsRows(props: {
  readonly write: (patch: ServerSettingsPatch) => void;
  readonly pending: boolean;
}) {
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const selectedProject = projectGroups.find((group) => group.key === selectedProjectKey);
  const writableEnvironments = useEnvironmentsWithScope(selectedTargets, AuthSettingsWriteScope);
  const projectSelected = selectedProjectKey !== null;

  const projectMembers = projectSelected
    ? (selectedProject?.members.map((member) => member.project) ?? [])
    : null;
  const displayTargets = resolveMobileSettingsTargets(
    selectedTargets.filter(supportsSharedSettingsSync),
    projectMembers,
  );
  // The page saves to all its targets, so any read-only one blocks the save.
  const canWriteSettings =
    displayTargets.length > 0 &&
    resolveMobileSettingsTargets(selectedTargets, projectMembers).every((target) =>
      writableEnvironments.has(target.environment.environmentId),
    );
  const reference = displayTargets[0] ?? null;
  const referenceSettings = reference?.settings ?? null;

  if (reference === null || referenceSettings === null) {
    return null;
  }

  const writeToAll = (
    patch: Partial<AutoSettleSettings> & {
      autoResumeLimitedThreads?: boolean;
      autoResumePullRequestThreadsFirst?: boolean;
      snoozeLimitedThreads?: boolean;
    },
  ) => props.write(patch);

  const { patch: autoSettlePatch, mismatches } = planAutoSettleSettingsSync(
    {
      environmentId: reference.environment.environmentId,
      projectId: reference.projectId,
      settings: referenceSettings,
    },
    displayTargets.map((target) => ({
      environmentId: target.environment.environmentId,
      projectId: target.projectId,
      label: target.environment.label,
      settings: target.settings,
    })),
  );

  const disabled = !canWriteSettings || props.pending;
  const afterDays = referenceSettings.sidebarAutoSettleAfterDays;

  return (
    <View className="gap-6">
      {!projectSelected ? (
        <SettingsSection title="Usage limits">
          <SettingsSwitchRow
            icon="clock"
            label="Resume after usage limits"
            value={uniformMobileSetting(displayTargets, "autoResumeLimitedThreads")}
            disabled={disabled}
            onValueChange={(value) => writeToAll({ autoResumeLimitedThreads: value })}
          />
          <SettingsSwitchRow
            icon="clock"
            label="Resume threads with PRs first"
            value={uniformMobileSetting(displayTargets, "autoResumePullRequestThreadsFirst")}
            disabled={disabled}
            onValueChange={(value) => writeToAll({ autoResumePullRequestThreadsFirst: value })}
          />
          <SettingsSwitchRow
            icon="clock"
            label="Snooze until limits reset"
            value={uniformMobileSetting(displayTargets, "snoozeLimitedThreads")}
            disabled={disabled}
            onValueChange={(value) => writeToAll({ snoozeLimitedThreads: value })}
          />
        </SettingsSection>
      ) : null}
      <SettingsSection title="Auto-settle">
        <SettingsSwitchRow
          icon="arrow.triangle.branch"
          label="Auto-settle merged threads"
          value={referenceSettings.sidebarAutoSettleOnMerge}
          disabled={disabled}
          onValueChange={(value) => writeToAll({ sidebarAutoSettleOnMerge: value })}
        />
        <SettingsSwitchRow
          icon="clock"
          label="Auto-settle inactive threads"
          value={afterDays !== null}
          disabled={disabled}
          onValueChange={(value) =>
            writeToAll({ sidebarAutoSettleAfterDays: value ? AUTO_SETTLE_DEFAULT_DAYS : null })
          }
        />
        {afterDays !== null ? (
          <View className="flex-row items-center gap-4 px-4 py-4 android:min-h-14 android:py-3">
            <View className="w-[22px] android:w-6" />
            <Text className="flex-1 text-foreground text-lg android:text-base">Inactive days</Text>
            <AutoSettleDaysField
              value={afterDays}
              disabled={disabled}
              onValueChange={(value) => writeToAll({ sidebarAutoSettleAfterDays: value })}
            />
          </View>
        ) : null}
      </SettingsSection>
      {!props.pending && mismatches.length > 0 ? (
        <SettingsSection title="Across environments">
          <View className="gap-3 p-4">
            <Text className="text-base text-foreground">Auto-settle defaults differ</Text>
            <Text className="text-sm text-foreground-muted">
              {mismatches.map((mismatch) => mismatch.label).join(", ")}
            </Text>
            <Button
              label="Apply auto-settle defaults"
              tone="secondary"
              disabled={disabled}
              onPress={() => writeToAll(autoSettlePatch)}
            />
          </View>
        </SettingsSection>
      ) : null}
    </View>
  );
}
