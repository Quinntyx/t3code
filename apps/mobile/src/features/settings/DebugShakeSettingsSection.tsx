import { useAtomSet, useAtomValue } from "@effect/atom-react";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { ListRowLayout } from "../../components/ui/ListRowLayout";
import { Menu } from "../../components/ui/Menu";
import { useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { mobilePreferencesAtom, updateMobilePreferencesAtom } from "../../state/preferences";
import { SettingsSection } from "./components/SettingsSection";
import { SettingsSwitchRow } from "./components/SettingsSwitchRow";

export function DebugShakeSettingsSection() {
  const preferences = useAtomValue(mobilePreferencesAtom);
  const save = useAtomSet(updateMobilePreferencesAtom);
  const projects = useProjects();
  const { environments } = useEnvironments();
  const ready = AsyncResult.isSuccess(preferences) && !preferences.waiting;
  const value = AsyncResult.isSuccess(preferences) ? preferences.value : {};
  const selected = projects.find(
    (project) =>
      project.environmentId === value.debugShakeProject?.environmentId &&
      project.id === value.debugShakeProject.projectId,
  );
  const machine = environments.find(
    (environment) => environment.environmentId === value.debugShakeProject?.environmentId,
  );

  return (
    <View className="gap-3">
      <SettingsSection title="Developer">
        <SettingsSwitchRow
          icon="iphone"
          label="Debug shake"
          value={value.debugShakeEnabled === true}
          disabled={!ready || (!selected && value.debugShakeEnabled !== true)}
          onValueChange={(enabled) => save({ debugShakeEnabled: enabled })}
        />
        <Menu
          accessibilityLabel="Debug shake destination"
          actions={environments.map((environment) => ({
            id: environment.environmentId,
            title: environment.label,
            subactions: projects
              .filter((project) => project.environmentId === environment.environmentId)
              .map((project) => ({
                id: JSON.stringify([project.environmentId, project.id]),
                title: project.title,
                state: selected === project ? "on" : "off",
              })),
            attributes: {
              disabled:
                !ready ||
                !projects.some((project) => project.environmentId === environment.environmentId),
            },
          }))}
          onPressAction={({ nativeEvent }) => {
            const project = projects.find(
              (candidate) =>
                JSON.stringify([candidate.environmentId, candidate.id]) === nativeEvent.event,
            );
            if (project)
              save({
                debugShakeProject: { environmentId: project.environmentId, projectId: project.id },
              });
          }}
        >
          <ListRowLayout
            icon="desktopcomputer"
            label="Machine and project"
            detail={
              selected && machine
                ? `${machine.label} · ${selected.title}`
                : value.debugShakeProject
                  ? "Unavailable project, choose…"
                  : "Choose…"
            }
          />
        </Menu>
      </SettingsSection>
      <Text className="px-2 text-sm text-foreground-muted">
        Choose your T3 Code project, then shake to open a new draft with a screenshot and the last
        200 mobile log lines. No agent runs until you press Send. Logs are kept only in memory while
        enabled; review them for sensitive information before sending.
      </Text>
    </View>
  );
}
