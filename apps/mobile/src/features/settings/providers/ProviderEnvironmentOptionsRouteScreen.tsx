import type { MenuAction } from "@react-native-menu/menu";
import type { StaticScreenProps } from "@react-navigation/native";
import {
  backgroundActivityOverrideSettings,
  durationToSeconds,
  normalizeIntervalSeconds,
} from "@t3tools/client-runtime/provider-settings/background-activity";
import {
  secretRequestReference,
  type SecretRequestSource,
} from "@t3tools/client-runtime/secret-request";
import {
  globalIdleCompaction,
  IDLE_COMPACTION_MODES,
  idleCompactionPatch,
  readsIdleCompactionModes,
  type EnvironmentId,
  type SecretReference,
} from "@t3tools/contracts";
import {
  getBackgroundActivityPresetSettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import { useState } from "react";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../../components/ui/Dialog";
import { AppTextInput } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { ControlPill } from "../../../components/ui/ControlPill";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListChoiceRow } from "../../../components/ui/ListChoiceRow";
import { Menu } from "../../../components/ui/Menu";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { SettingsScreen } from "../components/SettingsScreen";
import { SettingsSection } from "../components/SettingsSection";
import { FieldBlock } from "./ProviderFields";
import {
  useEnvironmentLabel,
  useProviderInstanceActions,
  useSecretSources,
} from "./useProviderSettings";
import { sourceIdFromUrl } from "@t3tools/client-runtime/provider-settings/usage-hubs";

type Actions = ReturnType<typeof useProviderInstanceActions>;

export function ProviderEnvironmentOptionsRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId }>) {
  return (
    <EnvironmentOptions
      key={route.params.environmentId}
      environmentId={route.params.environmentId}
    />
  );
}

function EnvironmentOptions({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const insets = useSafeAreaInsets();
  const actions = useProviderInstanceActions(environmentId);
  const environmentLabel = useEnvironmentLabel(environmentId);
  return (
    <SettingsScreen title="Usage and background checks">
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <UsageHubs
          environmentId={environmentId}
          environmentLabel={environmentLabel}
          actions={actions}
        />
        <HealthCheckInterval actions={actions} />
        <IdleCompaction actions={actions} />
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function UsageHubs(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly actions: Actions;
}) {
  const { settings, canManage } = props.actions;
  const readOnly = !canManage;
  const sources = useSecretSources(props.environmentId);
  const [adding, setAdding] = useState(false);
  const entries = Object.entries(settings.usageLimitSources);

  return (
    <SettingsSection
      title="Usage hubs"
      footer={`Show the quota of every account a CLIProxyAPI hub pools, next to the providers on ${props.environmentLabel}. Management keys stay on that server.`}
    >
      {entries.length === 0 && !adding ? (
        <FieldBlock label="No hubs configured" />
      ) : (
        entries.map(([id, source], index) => {
          const label = source.label?.trim() || source.url;
          return (
            <FieldBlock
              key={id}
              label={label}
              description={[
                "CLI Proxy",
                source.enabled ? null : "Disabled",
                label !== source.url ? source.url : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              separated={index > 0}
              trailing={
                readOnly ? null : (
                  <ControlPill
                    variant="pill"
                    label="Remove"
                    accessibilityLabel={`Remove ${label}`}
                    onPress={() =>
                      Dialog.confirm({
                        title: `Remove ${label}?`,
                        message:
                          "The hub's management key is deleted from this server. Its accounts leave the Limits view; the hub itself is untouched. Add it again with the URL and key to bring them back.",
                        confirmText: "Remove hub",
                        destructive: true,
                        onConfirm: () =>
                          void props.actions.updateSettings({ usageLimitSources: { [id]: null } }),
                      })
                    }
                  />
                )
              }
            />
          );
        })
      )}
      {readOnly ? null : adding ? (
        <AddHubForm
          separated={entries.length > 0}
          sources={sources}
          onCancel={() => setAdding(false)}
          onSave={async (hub) => {
            const sourceId = sourceIdFromUrl(hub.url, settings.usageLimitSources);
            const saved = await props.actions.updateSettings({
              usageLimitSources: {
                [sourceId]: {
                  kind: "cliproxy",
                  ...(hub.label ? { label: hub.label } : {}),
                  url: hub.url,
                  managementKey: hub.managementKey,
                  enabled: true,
                },
              },
            });
            if (saved) setAdding(false);
          }}
        />
      ) : (
        <View className="border-t border-border-subtle">
          <ListActionRow icon="plus" label="Add hub" onPress={() => setAdding(true)} />
        </View>
      )}
    </SettingsSection>
  );
}

function AddHubForm(props: {
  readonly separated: boolean;
  readonly sources: ReadonlyArray<SecretRequestSource>;
  readonly onCancel: () => void;
  readonly onSave: (hub: {
    readonly url: string;
    readonly managementKey: string | SecretReference;
    readonly label: string;
  }) => Promise<void>;
}) {
  const [url, setUrl] = useState("");
  const [managementKey, setManagementKey] = useState("");
  const [keySourceId, setKeySourceId] = useState<SecretRequestSource["id"] | null>(null);
  const keySource = props.sources.find((source) => source.id === keySourceId);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const canSave = url.trim().length > 0 && managementKey.trim().length > 0 && !saving;
  const keySourceActions: MenuAction[] = [
    { id: "", title: "Stored value", state: keySource === undefined ? "on" : "off" },
    ...props.sources.map((source) => ({
      id: source.id,
      title: source.label,
      state: source.id === keySourceId ? ("on" as const) : ("off" as const),
    })),
  ];
  const inputClassName = "min-h-11 rounded-xl px-3 py-2 text-base";
  return (
    <View className={props.separated ? "border-t border-border-subtle" : undefined}>
      <FieldBlock label="Hub URL">
        <AppTextInput
          accessibilityLabel="Hub URL"
          value={url}
          placeholder="https://hub.example.ts.net:8318"
          autoFocus
          autoCapitalize="none"
          autoCorrect={false}
          keyboardType="url"
          className={inputClassName}
          onChangeText={setUrl}
        />
      </FieldBlock>
      <FieldBlock
        label="Management key"
        separated
        trailing={
          props.sources.length > 0 ? (
            <Menu
              accessible
              accessibilityRole="button"
              accessibilityLabel={`Management key source: ${keySource?.label ?? "Stored value"}`}
              title="Value comes from"
              actions={keySourceActions}
              onPressAction={({ nativeEvent }) => {
                setKeySourceId(
                  props.sources.find((source) => source.id === nativeEvent.event)?.id ?? null,
                );
                setManagementKey("");
              }}
            >
              <ControlPill variant="pill" label={keySource?.label ?? "Stored value"} />
            </Menu>
          ) : null
        }
      >
        <AppTextInput
          accessibilityLabel={keySource ? "Management key reference" : "Management key"}
          value={managementKey}
          placeholder={keySource?.referencePlaceholder ?? "Not set"}
          secureTextEntry={keySource === undefined}
          autoCapitalize="none"
          autoCorrect={false}
          className={inputClassName}
          onChangeText={setManagementKey}
        />
      </FieldBlock>
      <FieldBlock label="Label" description="Optional. Defaults to the hub's host name." separated>
        <AppTextInput
          accessibilityLabel="Label"
          value={label}
          placeholder="e.g. Team hub"
          autoCorrect={false}
          className={inputClassName}
          onChangeText={setLabel}
        />
      </FieldBlock>
      <View className="flex-row gap-3 border-t border-border-subtle px-4 py-3">
        <View className="flex-1">
          <Button label="Cancel" tone="secondary" fullWidth onPress={props.onCancel} />
        </View>
        <View className="flex-1">
          <Button
            label="Add hub"
            fullWidth
            loading={saving}
            disabled={!canSave}
            onPress={() => {
              const key = keySource
                ? secretRequestReference(keySource, managementKey)
                : managementKey.trim();
              if (key === undefined) {
                Dialog.alert("Invalid reference", keySource?.invalidReferenceMessage);
                return;
              }
              setSaving(true);
              void props
                .onSave({ url: url.trim(), managementKey: key, label: label.trim() })
                .finally(() => setSaving(false));
            }}
          />
        </View>
      </View>
    </View>
  );
}

const HEALTH_INTERVAL_PRESETS = [60, 300, 900, 1_800, 3_600] as const;

function formatInterval(seconds: number) {
  if (seconds === 0) return "Off";
  if (seconds % 3_600 === 0) return `${seconds / 3_600} hr`;
  if (seconds % 60 === 0) return `${seconds / 60} min`;
  return `${seconds} s`;
}

function HealthCheckInterval(props: { readonly actions: Actions }) {
  const { settings, canWriteSettings, updateSettings } = props.actions;
  const resolved = resolveServerBackgroundActivitySettings(settings);
  const current = durationToSeconds(resolved.providerHealthRefreshInterval);
  const profileDefault = durationToSeconds(
    getBackgroundActivityPresetSettings(resolved.profile).providerHealthRefreshInterval,
  );
  const write = (seconds: number | undefined) =>
    void updateSettings(
      backgroundActivityOverrideSettings(settings.backgroundActivity, resolved, {
        providerHealthRefreshInterval:
          seconds === undefined ? undefined : Duration.seconds(normalizeIntervalSeconds(seconds)),
      }),
    );
  const choices = [...new Set([0, profileDefault, ...HEALTH_INTERVAL_PRESETS, current])].sort(
    (left, right) => left - right,
  );
  const menuActions: MenuAction[] = [
    ...choices.map((seconds): MenuAction => ({
      id: String(seconds),
      title:
        seconds === profileDefault
          ? `${formatInterval(seconds)} (default)`
          : formatInterval(seconds),
      state: seconds === current ? "on" : "off",
    })),
    { id: "custom", title: "Custom…" },
  ];
  return (
    <SettingsSection
      title="Health checks"
      footer="The shared Background activity policy still decides whether a check may run when the timer fires. Custom intervals appear as Advanced in Maintenance settings."
    >
      <FieldBlock
        label="Provider health check"
        description="Refresh provider status, versions, and models in the background."
        trailing={
          <Menu
            accessible
            accessibilityRole="button"
            accessibilityLabel={`Provider health check interval: ${formatInterval(current)}`}
            title="Check every"
            actions={menuActions}
            onPressAction={({ nativeEvent }) => {
              if (!canWriteSettings) return;
              if (nativeEvent.event !== "custom") {
                const seconds = Number(nativeEvent.event);
                // The default clears the override so a later profile change still applies.
                write(seconds === profileDefault ? undefined : seconds);
                return;
              }
              Dialog.prompt({
                title: "Health check interval",
                message: "Seconds between checks. Enter 0 to turn them off.",
                placeholder: String(profileDefault),
                initialValue: String(current),
                confirmText: "Save",
                onConfirm: (value) => {
                  const seconds = Number(value.trim());
                  if (value.trim().length === 0 || !Number.isFinite(seconds) || seconds < 0) {
                    Dialog.alert("Invalid interval", "Enter a whole number of seconds, 0 or more.");
                    return;
                  }
                  write(seconds);
                },
              });
            }}
          >
            <ControlPill
              variant="pill"
              label={formatInterval(current)}
              disabled={!canWriteSettings}
            />
          </Menu>
        }
      />
    </SettingsSection>
  );
}

function IdleCompaction(props: { readonly actions: Actions }) {
  const { settings, canWriteSettings, updateSettings } = props.actions;
  const current = globalIdleCompaction(settings);
  // A server from before modes has only the on/off switch, so it cannot store "Never".
  const neverAvailable = readsIdleCompactionModes(settings);
  return (
    <SettingsSection
      title="Compact idle threads"
      footer="When to compact an idle Claude thread over 200,000 tokens. Each Claude provider can override this."
    >
      {IDLE_COMPACTION_MODES.map((mode, index) => (
        <ListChoiceRow
          key={mode.value}
          label={mode.label}
          selected={current === mode.value}
          separated={index > 0}
          disabled={!canWriteSettings || (mode.value === "off" && !neverAvailable)}
          onPress={() => {
            if (mode.value !== current)
              void updateSettings(idleCompactionPatch(settings, mode.value));
          }}
        />
      ))}
    </SettingsSection>
  );
}
