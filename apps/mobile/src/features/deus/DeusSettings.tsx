import { useAtomValue } from "@effect/atom-react";
import { sameDeusScope } from "@t3tools/client-runtime/state/deus";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { DeusConfiguration, DeusScope, EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, TextInput, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { useProjects } from "../../state/entities";
import { deusEnvironment } from "../../state/deus";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";
import { useDeusPanelStore } from "./panelStore";
function Action({
  label,
  disabled,
  onPress,
}: {
  label: string;
  disabled?: boolean;
  onPress(): void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-11 justify-center rounded-xl border border-border px-3 py-2 ${disabled ? "opacity-40" : "active:opacity-70"}`}
    >
      <Text>{label}</Text>
    </Pressable>
  );
}
function DestinationSettings({ target }: { target: DeusScope }) {
  const canRead = useAtomValue(deusEnvironment.getSettings.permissionAtom(target.environmentId));
  const canWrite = useAtomValue(
    deusEnvironment.updateSettings.permissionAtom(target.environmentId),
  );
  const canOpen = useAtomValue(deusEnvironment.open.permissionAtom(target.environmentId));
  const canSnapshot = useAtomValue(
    deusEnvironment.getSnapshot.permissionAtom(target.environmentId),
  );
  const canAttach = useAtomValue(deusEnvironment.attach.permissionAtom(target.environmentId));
  const canControl = useAtomValue(
    deusEnvironment.mediaControl.permissionAtom(target.environmentId),
  );
  const { voice } = useDeusPanelStore();
  const controls = voice && sameDeusScope(voice.target, target) ? voice.controls : null;
  const get = useAtomCommand(deusEnvironment.getSettings, { reportFailure: false });
  const update = useAtomCommand(deusEnvironment.updateSettings, { reportFailure: false });
  const [configuration, setConfiguration] = useState<DeusConfiguration | null>(null);
  const [draft, setDraft] = useState({ textModel: "", liveModel: "", voice: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const load = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await get({ environmentId: target.environmentId, input: target });
      if (result._tag === "Success") {
        setConfiguration(result.value);
        const { textModel, liveModel, voice } = result.value.settings;
        setDraft({ textModel: textModel ?? "", liveModel: liveModel ?? "", voice: voice ?? "" });
      } else {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Settings unavailable.");
      }
    } finally {
      setBusy(false);
    }
  };
  const save = async (enabled: boolean) => {
    setBusy(true);
    setError(null);
    try {
      const result = await update({
        environmentId: target.environmentId,
        input: {
          ...target,
          patch: {
            enabled,
            textModel: draft.textModel.trim() || null,
            liveModel: draft.liveModel.trim() || null,
            voice: draft.voice.trim() || null,
          },
        },
      });
      if (result._tag === "Success") setConfiguration(result.value);
      else {
        const cause = squashAtomCommandFailure(result);
        setError(cause instanceof Error ? cause.message : "Settings update failed.");
      }
    } finally {
      setBusy(false);
    }
  };
  return (
    <View className="gap-3 p-4">
      <Text selectable>
        {target.environmentId} / {target.projectId}
      </Text>
      <Text>Voice settings and credential readiness belong to this destination environment.</Text>
      <Action
        label="Open or focus Deus"
        disabled={!canOpen || !canSnapshot}
        onPress={() => {
          const store = useDeusPanelStore.getState();
          store.openPicker();
          store.select(target);
        }}
      />
      <Text>
        Opening never captures the microphone. Open Deus before connecting voice; disconnecting
        releases only local voice, not workers.
      </Text>
      <Action
        label="Connect Deus voice"
        disabled={!canAttach || !controls?.ready || controls.active}
        onPress={() => controls?.connect()}
      />
      <Action
        label="Disconnect Deus voice"
        disabled={!controls?.active}
        onPress={() => controls?.disconnect()}
      />
      <Action
        label={controls?.muted ? "Resume Deus microphone" : "Mute Deus microphone"}
        disabled={!canControl || !controls?.active}
        onPress={() => controls?.toggleMute()}
      />
      <Action label="Load Deus settings" disabled={!canRead || busy} onPress={() => void load()} />
      {error ? <Text accessibilityRole="alert">{error}</Text> : null}
      {configuration ? (
        <>
          <Text>
            Credential {configuration.credentialConfigured ? "configured" : "not configured"} · Deus{" "}
            {configuration.settings.enabled ? "enabled" : "disabled"}
          </Text>
          {(["textModel", "liveModel", "voice"] as const).map((key) => (
            <View key={key}>
              <Text>
                {key === "textModel" ? "Text model" : key === "liveModel" ? "Live model" : "Voice"}
              </Text>
              <TextInput
                accessibilityLabel={`Deus ${key}`}
                editable={canWrite && !busy}
                value={draft[key]}
                onChangeText={(value) => setDraft({ ...draft, [key]: value })}
                className="min-h-11 rounded-xl border border-border p-3 text-foreground"
              />
            </View>
          ))}
          <Action
            label="Save and enable Deus"
            disabled={!canWrite || busy}
            onPress={() => void save(true)}
          />
          <Action
            label="Save and disable Deus"
            disabled={!canWrite || busy}
            onPress={() => void save(false)}
          />
        </>
      ) : null}
    </View>
  );
}
export function DeusSettings({ environmentId }: { environmentId?: EnvironmentId }) {
  const projects = useProjects().filter(
    (project) => !environmentId || project.environmentId === environmentId,
  );
  const [selected, setSelected] = useState("");
  const project =
    projects.find((item) => `${item.environmentId}:${item.id}` === selected) ?? projects[0];
  return (
    <SettingsSection title="Deus destination settings">
      <View className="gap-2 p-4">
        {projects.map((item) => (
          <Action
            key={`${item.environmentId}:${item.id}`}
            label={`${item.title} · ${item.environmentId}`}
            onPress={() => setSelected(`${item.environmentId}:${item.id}`)}
          />
        ))}
      </View>
      {project ? (
        <DestinationSettings
          key={`${project.environmentId}:${project.id}`}
          target={{ environmentId: project.environmentId, projectId: project.id }}
        />
      ) : (
        <Text>Add a project to configure Deus.</Text>
      )}
    </SettingsSection>
  );
}
