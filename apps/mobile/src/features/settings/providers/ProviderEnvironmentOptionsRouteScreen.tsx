import type { MenuAction } from "@react-native-menu/menu";
import type { StaticScreenProps } from "@react-navigation/native";
import { idleCompactionModeLabel } from "@t3tools/client-runtime/contract-labels";
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
import { msg, useGT, useMessages } from "gt-react-native";
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
import { m, type MessageResolver } from "../../../i18n/messages";
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
const CLI_PROXY_NAME = "CLI Proxy";

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
  const gt = useGT();
  const insets = useSafeAreaInsets();
  const actions = useProviderInstanceActions(environmentId);
  const environmentLabel = useEnvironmentLabel(environmentId);
  return (
    <SettingsScreen title={gt("Usage and background checks")}>
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
  const gt = useGT();
  const { settings, canManage } = props.actions;
  const readOnly = !canManage;
  const sources = useSecretSources(props.environmentId);
  const [adding, setAdding] = useState(false);
  const entries = Object.entries(settings.usageLimitSources);

  return (
    <SettingsSection
      title={gt("Usage hubs")}
      footer={gt(
        "Show the quota of every account a CLIProxyAPI hub pools, next to the providers on {environment}. Management keys stay on that server.",
        { environment: props.environmentLabel },
      )}
    >
      {entries.length === 0 && !adding ? (
        <FieldBlock label={gt("No hubs configured")} />
      ) : (
        entries.map(([id, source], index) => {
          const label = source.label?.trim() || source.url;
          return (
            <FieldBlock
              key={id}
              label={label}
              description={[
                CLI_PROXY_NAME,
                source.enabled ? null : gt("Disabled", { $context: "usage hub status" }),
                label !== source.url ? source.url : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              separated={index > 0}
              trailing={
                readOnly ? null : (
                  <ControlPill
                    variant="pill"
                    label={gt("Remove", { $context: "verb, removes a usage hub" })}
                    accessibilityLabel={gt("Remove {label}", { label })}
                    onPress={() =>
                      Dialog.confirm({
                        title: gt("Remove {label}?", { label }),
                        message: gt(
                          "The hub's management key is deleted from this server. Its accounts leave the Limits view; the hub itself is untouched. Add it again with the URL and key to bring them back.",
                        ),
                        confirmText: gt("Remove hub"),
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
          <ListActionRow icon="plus" label={gt("Add hub")} onPress={() => setAdding(true)} />
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
  const gt = useGT();
  const [url, setUrl] = useState("");
  const [managementKey, setManagementKey] = useState("");
  const [keySourceId, setKeySourceId] = useState<SecretRequestSource["id"] | null>(null);
  const keySource = props.sources.find((source) => source.id === keySourceId);
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const canSave = url.trim().length > 0 && managementKey.trim().length > 0 && !saving;
  const keySourceActions: MenuAction[] = [
    { id: "", title: gt("Stored value"), state: keySource === undefined ? "on" : "off" },
    ...props.sources.map((source) => ({
      id: source.id,
      title: source.label,
      state: source.id === keySourceId ? ("on" as const) : ("off" as const),
    })),
  ];
  const inputClassName = "min-h-11 rounded-xl px-3 py-2 text-base";
  return (
    <View className={props.separated ? "border-t border-border-subtle" : undefined}>
      <FieldBlock label={gt("Hub URL")}>
        <AppTextInput
          accessibilityLabel={gt("Hub URL")}
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
        label={gt("Management key")}
        separated
        trailing={
          props.sources.length > 0 ? (
            <Menu
              accessible
              accessibilityRole="button"
              accessibilityLabel={
                keySource
                  ? gt("Management key source: {source}", { source: keySource.label })
                  : gt("Management key source: Stored value")
              }
              title={gt("Value comes from")}
              actions={keySourceActions}
              onPressAction={({ nativeEvent }) => {
                setKeySourceId(
                  props.sources.find((source) => source.id === nativeEvent.event)?.id ?? null,
                );
                setManagementKey("");
              }}
            >
              <ControlPill variant="pill" label={keySource?.label ?? gt("Stored value")} />
            </Menu>
          ) : null
        }
      >
        <AppTextInput
          accessibilityLabel={keySource ? gt("Management key reference") : gt("Management key")}
          value={managementKey}
          placeholder={keySource?.referencePlaceholder ?? gt("Not set")}
          secureTextEntry={keySource === undefined}
          autoCapitalize="none"
          autoCorrect={false}
          className={inputClassName}
          onChangeText={setManagementKey}
        />
      </FieldBlock>
      <FieldBlock
        label={gt("Label")}
        description={gt("Optional. Defaults to the hub's host name.")}
        separated
      >
        <AppTextInput
          accessibilityLabel={gt("Label")}
          value={label}
          placeholder={gt("e.g. Team hub")}
          autoCorrect={false}
          className={inputClassName}
          onChangeText={setLabel}
        />
      </FieldBlock>
      <View className="flex-row gap-3 border-t border-border-subtle px-4 py-3">
        <View className="flex-1">
          <Button label={gt("Cancel")} tone="secondary" fullWidth onPress={props.onCancel} />
        </View>
        <View className="flex-1">
          <Button
            label={gt("Add hub")}
            fullWidth
            loading={saving}
            disabled={!canSave}
            onPress={() => {
              const key = keySource
                ? secretRequestReference(keySource, managementKey)
                : managementKey.trim();
              if (key === undefined) {
                Dialog.alert(gt("Invalid reference"), keySource?.invalidReferenceMessage);
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

function formatInterval(seconds: number, resolve: MessageResolver = m) {
  if (seconds === 0) return resolve(msg("Off", { $context: "health check interval status" }));
  if (seconds % 3_600 === 0) return resolve(msg("{count} hr", { count: seconds / 3_600 }));
  if (seconds % 60 === 0) return resolve(msg("{count} min", { count: seconds / 60 }));
  return resolve(msg("{count} s", { count: seconds }));
}

function HealthCheckInterval(props: { readonly actions: Actions }) {
  const gt = useGT();
  const messages = useMessages();
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
          ? gt("{interval} (default)", { interval: formatInterval(seconds, messages) })
          : formatInterval(seconds, messages),
      state: seconds === current ? "on" : "off",
    })),
    { id: "custom", title: gt("Custom…") },
  ];
  return (
    <SettingsSection
      title={gt("Health checks")}
      footer={gt(
        "The shared Background activity policy still decides whether a check may run when the timer fires. Custom intervals appear as Advanced in Maintenance settings.",
      )}
    >
      <FieldBlock
        label={gt("Provider health check")}
        description={gt("Refresh provider status, versions, and models in the background.")}
        trailing={
          <Menu
            accessible
            accessibilityRole="button"
            accessibilityLabel={gt("Provider health check interval: {interval}", {
              interval: formatInterval(current, messages),
            })}
            title={gt("Check every")}
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
                title: gt("Health check interval"),
                message: gt("Seconds between checks. Enter 0 to turn them off."),
                placeholder: String(profileDefault),
                initialValue: String(current),
                confirmText: gt("Save", { $context: "verb" }),
                onConfirm: (value) => {
                  const seconds = Number(value.trim());
                  if (value.trim().length === 0 || !Number.isFinite(seconds) || seconds < 0) {
                    Dialog.alert(
                      gt("Invalid interval"),
                      gt("Enter a whole number of seconds, 0 or more."),
                    );
                    return;
                  }
                  write(seconds);
                },
              });
            }}
          >
            <ControlPill
              variant="pill"
              label={formatInterval(current, messages)}
              disabled={!canWriteSettings}
            />
          </Menu>
        }
      />
    </SettingsSection>
  );
}

function IdleCompaction(props: { readonly actions: Actions }) {
  const gt = useGT();
  const messages = useMessages();
  const { settings, canWriteSettings, updateSettings } = props.actions;
  const current = globalIdleCompaction(settings);
  // A server from before modes has only the on/off switch, so it cannot store "Never".
  const neverAvailable = readsIdleCompactionModes(settings);
  return (
    <SettingsSection
      title={gt("Compact idle threads")}
      footer={gt(
        "When to compact an idle Claude thread over 200,000 tokens. Each Claude provider can override this.",
      )}
    >
      {IDLE_COMPACTION_MODES.map((mode, index) => (
        <ListChoiceRow
          key={mode.value}
          label={idleCompactionModeLabel(mode.value, messages)}
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
