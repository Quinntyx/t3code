import { useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { providerClients } from "@t3tools/client-runtime/provider-clients";
import { readCodexSetupMode } from "@t3tools/client-runtime/provider-settings/codex-setup";
import { deriveProviderSettingsFields } from "@t3tools/client-runtime/provider-settings/form";
import {
  deriveProviderInstanceRows,
  deriveProviderModelsForDisplay,
  nextProviderEnvironmentWithFieldValue,
  providerEnvironmentWithoutNames,
} from "@t3tools/client-runtime/provider-settings/instance";
import {
  getProviderVersionAdvisoryPresentation,
  getProviderVersionLabel,
} from "@t3tools/client-runtime/provider-settings/status";
import {
  AuthProvidersManageScope,
  type AcpRegistryUrlAuthAction,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { createModelHiddenPredicate, readCustomModelEntries } from "@t3tools/shared/model";
import { useState } from "react";
import { Linking, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../../components/ui/Dialog";
import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { ControlPill } from "../../../components/ui/ControlPill";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListRow } from "../../../components/ui/ListRow";
import { ListToggleRow } from "../../../components/ui/ListToggleRow";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { copyTextWithHaptic } from "../../../lib/copyTextWithHaptic";
import { serverEnvironment } from "../../../state/server";
import { useEnvironmentScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { canUpdateEnvironmentProvider } from "../environment-maintenance";
import { SettingsScreen } from "../components/SettingsScreen";
import { SettingsSection } from "../components/SettingsSection";
import { AcpSessionsSection } from "./AcpRegistry";
import { AntigravitySetupSection } from "./AntigravitySetup";
import { CodexManagedRuntimeFields, CodexSetupSection } from "./CodexSetup";
import {
  AccentColorPicker,
  CommitTextInput,
  FieldBlock,
  ProviderEnvironmentFieldRows,
  ProviderEnvironmentVariables,
  ProviderSettingsFields,
} from "./ProviderFields";
import { canManageProviderSignIn, ProviderSignInSection } from "./ProviderSignInSection";
import {
  describeProviderInstance,
  isProviderUpdating,
  ProviderInstanceGlyph,
  providerDisplayName,
  ProviderStatusDot,
} from "./ProviderStatus";
import {
  reportCommandFailure,
  useEnvironmentLabel,
  useEnvironmentProviders,
  useModelPreferences,
  usePendingSwitch,
  useProviderInstanceActions,
} from "./useProviderSettings";

type Params = {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
};

export function ProviderDetailRouteScreen({ route }: StaticScreenProps<Params>) {
  return (
    <ProviderDetail
      key={`${route.params.environmentId}:${route.params.instanceId}`}
      environmentId={route.params.environmentId}
      instanceId={route.params.instanceId}
    />
  );
}

function ProviderDetail({ environmentId, instanceId }: Params) {
  const insets = useSafeAreaInsets();
  const environmentLabel = useEnvironmentLabel(environmentId);
  const providers = useEnvironmentProviders(environmentId);
  const actions = useProviderInstanceActions(environmentId);
  const row = deriveProviderInstanceRows({
    providerInstances: actions.settings.providerInstances,
    serverProviders: providers,
    targetInstanceId: instanceId,
  }).find((candidate) => candidate.instanceId === instanceId);
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  const instance = row ? (row.explicitInstance ?? { driver: row.driver }) : null;
  return (
    <SettingsScreen title={instance ? providerDisplayName(instance) : "Provider"}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {row && instance ? (
          <ProviderEditor
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            instanceId={instanceId}
            instance={instance}
            isDefault={row.isDefault}
            isDirty={row.isDirty === true}
            provider={provider}
            actions={actions}
          />
        ) : (
          <Text className="text-foreground-muted">
            This provider is no longer configured on {environmentLabel}.
          </Text>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function ProviderEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly isDefault: boolean;
  readonly isDirty: boolean;
  readonly provider: ServerProvider | undefined;
  readonly actions: ReturnType<typeof useProviderInstanceActions>;
}) {
  const { environmentId, instanceId, instance, provider, actions } = props;
  const navigation = useNavigation();
  const readOnly = !actions.canManage;
  const definition = providerClients.get(instance.driver);
  const status = describeProviderInstance(instance, provider);
  const enabledSwitch = usePendingSwitch(status.enabled);
  const modelPreferences = useModelPreferences(actions.settings).preferences;
  const name = providerDisplayName(instance);
  // Each upsert carries the whole instance, so edits build on the last write until its echo lands.
  const [lastWrite, setLastWrite] = useState<ProviderInstanceConfig | null>(null);
  if (lastWrite !== null && JSON.stringify(lastWrite) === JSON.stringify(instance)) {
    setLastWrite(null);
  }
  const update = async (edit: (current: ProviderInstanceConfig) => ProviderInstanceConfig) => {
    const base = lastWrite ?? instance;
    const next = edit(base);
    setLastWrite(next);
    const saved = await actions.updateInstance(instanceId, base, next);
    if (!saved) setLastWrite(null);
    return saved;
  };

  const environmentFields = definition?.environmentFields ?? [];
  const environmentFieldNames = new Set(environmentFields.map((field) => field.name));
  const updateEnvironment = (
    edit: (
      environment: ProviderInstanceConfig["environment"],
    ) => ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  ) =>
    update((current) => {
      const { environment, ...rest } = current;
      const cleaned = edit(environment).filter((variable) => variable.name.trim().length > 0);
      return cleaned.length > 0 ? { ...rest, environment: cleaned } : rest;
    });
  const updateConfig = (config: Record<string, unknown> | undefined) =>
    update((current) => {
      const { config: _omit, ...rest } = current;
      return config !== undefined ? { ...rest, config } : rest;
    });
  const codexMode = instance.driver === "codex" ? readCodexSetupMode(instance.config) : "existing";

  const setup =
    instance.driver === "antigravity" ? (
      <AntigravitySetupSection
        environmentId={environmentId}
        environmentLabel={props.environmentLabel}
        instanceId={instanceId}
        provider={provider}
        config={instance.config}
        enabled={status.enabled}
        readOnly={readOnly}
        onEnable={() => actions.persistInstance(instanceId, { ...instance, enabled: true })}
      />
    ) : instance.driver === "codex" && codexMode === "managed" ? (
      <CodexSetupSection
        environmentId={environmentId}
        environmentLabel={props.environmentLabel}
        instanceId={instanceId}
        instance={instance}
        provider={provider}
        readOnly={readOnly}
        onModeChange={(setupMode) =>
          actions.persistInstance(instanceId, {
            ...instance,
            enabled: true,
            config: {
              ...(instance.config !== null && typeof instance.config === "object"
                ? instance.config
                : {}),
              enabled: true,
              setupMode,
            },
          })
        }
      />
    ) : !readOnly && provider && canManageProviderSignIn(provider) ? (
      <SettingsSection title="Sign-in">
        <ProviderSignInSection
          environment={{ environmentId, label: props.environmentLabel }}
          provider={provider}
        />
      </SettingsSection>
    ) : !readOnly && instance.driver === "cursor" && provider?.setup?.canAuthenticate === false ? (
      <SettingsSection title="Sign-in">
        <FieldBlock
          label="Cursor account"
          description="Using CURSOR_API_KEY. Remove it from this provider's environment to use browser sign-in."
        />
      </SettingsSection>
    ) : null;

  const runtimeFieldCount = definition
    ? deriveProviderSettingsFields(definition, instance.config).length
    : 0;

  return (
    <>
      <View className="items-center gap-3 pt-2">
        <ProviderInstanceGlyph instance={instance} size={34} />
        <View className="items-center gap-1">
          <Text textRole="title" className="text-center font-t3-bold text-foreground">
            {name}
          </Text>
          <Text textRole="footnote" className="text-center text-foreground-muted">
            {[
              definition?.label ?? String(instance.driver),
              getProviderVersionLabel(provider?.version),
              definition?.badgeLabel,
            ]
              .filter(Boolean)
              .join(" · ")}
          </Text>
          <View className="flex-row items-center gap-1.5 px-6">
            <ProviderStatusDot status={status.statusKey} />
            <Text
              accessibilityLiveRegion="polite"
              textRole="footnote"
              className="shrink text-center text-foreground-muted"
            >
              {status.headline}
            </Text>
          </View>
          {status.detail && status.enabled ? (
            <Text textRole="footnote" className="px-6 text-center text-foreground-muted">
              {status.detail}
            </Text>
          ) : null}
          {status.enabled && provider?.auth.status === "authenticated" && provider.auth.email ? (
            <RevealableEmail email={provider.auth.email} />
          ) : null}
        </View>
      </View>

      <SettingsSection>
        <ListToggleRow
          label="Turned on"
          description="Show this provider in pickers and let threads start on it."
          disabled={readOnly}
          value={enabledSwitch.value}
          onValueChange={(value) =>
            enabledSwitch.change(
              value,
              update((current) => ({ ...current, enabled: value })),
            )
          }
        />
      </SettingsSection>

      <VersionAdvisoryCard
        environmentId={environmentId}
        instanceId={instanceId}
        name={name}
        provider={provider}
        enabled={status.enabled}
        readOnly={readOnly}
      />

      {provider?.auth.action && !readOnly ? (
        <UrlAuthCard
          environmentId={environmentId}
          instanceId={instanceId}
          action={provider.auth.action}
        />
      ) : null}

      {setup}

      {environmentFields.length > 0 ? (
        <SettingsSection title="Credentials">
          <ProviderEnvironmentFieldRows
            fields={environmentFields}
            environment={instance.environment}
            disabled={readOnly}
            separatedFirst={false}
            onCommit={(field, value) =>
              void updateEnvironment((environment) =>
                nextProviderEnvironmentWithFieldValue(environment, field, value),
              )
            }
            onRemove={(field) =>
              void updateEnvironment((environment) =>
                providerEnvironmentWithoutNames(environment, new Set([field.name])),
              )
            }
          />
        </SettingsSection>
      ) : null}

      <SettingsSection title="Identity">
        <FieldBlock label="Display name">
          <CommitTextInput
            accessibilityLabel="Display name"
            value={instance.displayName ?? ""}
            placeholder={definition?.label ?? "Instance label"}
            editable={!readOnly}
            onCommit={(value) => {
              const trimmed = value.trim();
              void update(({ displayName: _omit, ...rest }) =>
                trimmed.length > 0 ? { ...rest, displayName: trimmed } : rest,
              );
            }}
          />
        </FieldBlock>
        <FieldBlock
          label="Accent color"
          description="Marks this instance in the model picker."
          separated
        >
          <AccentColorPicker
            value={instance.accentColor}
            disabled={readOnly}
            onCommit={(value) => {
              void update(({ accentColor: _omit, ...rest }) =>
                value ? { ...rest, accentColor: value } : rest,
              );
            }}
          />
        </FieldBlock>
        <FieldBlock label="Instance ID" separated>
          <Text selectable className="font-mono text-sm text-foreground-muted">
            {instanceId}
          </Text>
        </FieldBlock>
      </SettingsSection>

      {!definition ? (
        <SettingsSection title="Runtime">
          <FieldBlock
            label="Driver"
            description={`This instance uses ${String(instance.driver)}, which this app version does not know. Its configuration is kept as is.`}
          />
        </SettingsSection>
      ) : codexMode === "managed" ? (
        <SettingsSection title="Runtime">
          <CodexManagedRuntimeFields
            environmentId={environmentId}
            instanceId={instanceId}
            provider={provider}
          />
        </SettingsSection>
      ) : runtimeFieldCount > 0 ? (
        <SettingsSection title="Runtime">
          <ProviderSettingsFields
            definition={definition}
            value={instance.config}
            disabled={readOnly}
            onChange={(config) => void updateConfig(config)}
          />
        </SettingsSection>
      ) : null}

      <SettingsSection
        title="Environment variables"
        footer="API keys, base URLs, and other per-instance CLI settings. Sensitive values are stored separately and never returned to the app."
      >
        <ProviderEnvironmentVariables
          environment={providerEnvironmentWithoutNames(instance.environment, environmentFieldNames)}
          disabled={readOnly}
          onChange={(environment) =>
            void updateEnvironment((current) => [
              ...(current ?? []).filter((variable) => environmentFieldNames.has(variable.name)),
              ...environment,
            ])
          }
        />
      </SettingsSection>

      {provider?.driver === "acpRegistry" ? (
        <AcpSessionsSection
          environmentId={environmentId}
          instanceId={instanceId}
          provider={provider}
          readOnly={readOnly}
        />
      ) : null}

      {definition ? (
        <SettingsSection title="Models">
          <ListRow
            icon="cube"
            label="Models"
            description={modelSummary(instance, provider, modelPreferences, instanceId)}
            onPress={() =>
              navigation.navigate("SettingsProviderModels", { environmentId, instanceId })
            }
          />
        </SettingsSection>
      ) : null}

      {!readOnly && (!props.isDefault || props.isDirty) ? (
        <SettingsSection
          footer={
            props.isDefault
              ? "Clears this provider's saved settings on this device. Sign-in is kept."
              : undefined
          }
        >
          {props.isDefault ? (
            <ListActionRow
              icon="arrow.uturn.backward"
              label="Reset to defaults"
              tone="danger"
              onPress={() =>
                Dialog.confirm({
                  title: `Reset ${name}?`,
                  message: "Its display name, runtime settings, and variables return to defaults.",
                  confirmText: "Reset",
                  destructive: true,
                  onConfirm: () => void actions.resetDefaultInstance(instance.driver),
                })
              }
            />
          ) : (
            <ListActionRow
              icon="trash"
              label="Delete provider"
              tone="danger"
              onPress={() =>
                Dialog.confirm({
                  title: `Delete ${name}?`,
                  message: `Removes this provider from ${props.environmentLabel}. Threads that used it keep their history.`,
                  confirmText: "Delete",
                  destructive: true,
                  onConfirm: () => {
                    void actions.deleteInstance(instanceId, instance).then((deleted) => {
                      if (deleted && navigation.canGoBack()) navigation.goBack();
                    });
                  },
                })
              }
            />
          )}
        </SettingsSection>
      ) : null}
    </>
  );
}

function modelSummary(
  instance: ProviderInstanceConfig,
  provider: ServerProvider | undefined,
  preferences: ReturnType<typeof useModelPreferences>["preferences"],
  instanceId: ProviderInstanceId,
) {
  const customModels =
    instance.driver === "antigravity"
      ? []
      : readCustomModelEntries(
          instance.config !== null && typeof instance.config === "object"
            ? (instance.config as Record<string, unknown>).customModels
            : undefined,
        );
  const models = deriveProviderModelsForDisplay({ liveModels: provider?.models, customModels });
  if (models.length === 0) return "No models reported yet";
  const instancePreferences = preferences.providerModelPreferences[instanceId];
  const isHidden = createModelHiddenPredicate({
    hiddenModels: instancePreferences?.hiddenModels ?? [],
    modelOrder: instancePreferences?.modelOrder ?? [],
    newModelsEnabled: instancePreferences?.newModelsEnabled ?? true,
    enabledModels: instancePreferences?.enabledModels ?? [],
  });
  const slugs = new Set(models.map((model) => model.slug));
  const favorites = preferences.favorites.filter(
    (favorite) => favorite.provider === instanceId && slugs.has(favorite.model),
  ).length;
  const hidden = models.filter((model) => !model.isCustom && isHidden(model)).length;
  return [
    `${models.length} model${models.length === 1 ? "" : "s"}`,
    favorites > 0 ? `${favorites} favorite${favorites === 1 ? "" : "s"}` : null,
    hidden > 0 ? `${hidden} hidden` : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

function RevealableEmail(props: { readonly email: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        revealed ? `Signed in as ${props.email}` : "Signed in. Show account email"
      }
      onPress={() => setRevealed((value) => !value)}
      hitSlop={6}
    >
      <Text textRole="footnote" className="text-center text-foreground-muted">
        {`Signed in as ${revealed ? props.email.trim() : "••••••@••••••"}`}
      </Text>
    </Pressable>
  );
}

function VersionAdvisoryCard(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly name: string;
  readonly provider: ServerProvider | undefined;
  readonly enabled: boolean;
  readonly readOnly: boolean;
}) {
  const { provider } = props;
  const runUpdate = useAtomCommand(serverEnvironment.updateProvider, { reportFailure: false });
  const canManage = useEnvironmentScope(props.environmentId, AuthProvidersManageScope);
  const [dispatching, setDispatching] = useState(false);
  const advisory = getProviderVersionAdvisoryPresentation(
    provider?.versionAdvisory,
    provider?.compatibilityAdvisory,
    props.enabled,
  );
  if (!provider || !advisory) return null;
  const updating = dispatching || isProviderUpdating(provider);
  const progress = updating
    ? ((provider.updateState?.status === "queued" || provider.updateState?.status === "running"
        ? provider.updateState.message
        : null) ?? "Starting update")
    : null;
  const problem =
    !updating &&
    (provider.updateState?.status === "failed" || provider.updateState?.status === "unchanged")
      ? provider.updateState.message
      : null;
  const targetVersion = advisory.targetVersion;
  const canInstallTarget =
    targetVersion !== null && provider.versionAdvisory?.canInstallVersion === true;
  const canRun =
    !props.readOnly &&
    canManage &&
    (targetVersion !== null ? canInstallTarget : canUpdateEnvironmentProvider(provider));
  const updateCommand = advisory.updateCommand;
  const start = () => {
    if (dispatching) return;
    setDispatching(true);
    void runUpdate({
      environmentId: props.environmentId,
      input: {
        provider: provider.driver,
        instanceId: props.instanceId,
        ...(targetVersion ? { targetVersion } : {}),
      },
    }).then((result) => {
      setDispatching(false);
      reportCommandFailure(
        result,
        `Could not update ${props.name}`,
        "The provider update command could not be started.",
      );
    });
  };
  return (
    <View
      className={
        advisory.emphasis === "strong"
          ? "gap-3 rounded-3xl border border-warning-border bg-grouped-card p-4"
          : "gap-3 rounded-3xl bg-grouped-card p-4"
      }
    >
      <View className="gap-1">
        <Text
          textRole="body"
          className={
            advisory.emphasis === "strong"
              ? "font-t3-medium text-warning-foreground"
              : "font-t3-medium text-foreground"
          }
        >
          {advisory.title}
        </Text>
        <Text textRole="footnote" className="text-foreground-muted">
          {advisory.detail}
        </Text>
      </View>
      {canRun ? (
        <Button
          label={
            updating
              ? "Updating"
              : targetVersion
                ? `Install ${getProviderVersionLabel(targetVersion)}`
                : "Update now"
          }
          icon="arrow.down.circle"
          loading={updating}
          disabled={updating}
          onPress={start}
          fullWidth
        />
      ) : null}
      {progress || problem ? (
        <View className="flex-row items-center gap-2">
          {progress ? <AppActivityIndicator colorClassName="accent-icon" /> : null}
          <Text
            accessibilityLiveRegion="polite"
            textRole="footnote"
            className={problem ? "shrink text-warning-foreground" : "shrink text-foreground-muted"}
          >
            {progress ?? problem}
          </Text>
        </View>
      ) : null}
      {updateCommand ? (
        <View className="gap-1.5">
          <Text textRole="footnote" className="text-foreground-muted">
            {canRun ? "Or update manually:" : "Update manually:"}
          </Text>
          <View className="flex-row items-center gap-2 rounded-xl bg-subtle py-1 pr-1 pl-3">
            <Text
              selectable
              className="min-w-0 flex-1 font-mono text-xs text-foreground"
              numberOfLines={2}
            >
              {updateCommand}
            </Text>
            <ControlPill
              icon="doc.on.doc"
              accessibilityLabel="Copy update command"
              onPress={() => copyTextWithHaptic(updateCommand, { target: "update command" })}
            />
          </View>
        </View>
      ) : null}
    </View>
  );
}

function UrlAuthCard(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly action: AcpRegistryUrlAuthAction;
}) {
  const accept = useAtomCommand(serverEnvironment.acceptAcpRegistryUrlAuth, {
    reportFailure: false,
  });
  return (
    <View className="gap-3 rounded-3xl bg-grouped-card p-4">
      <Text textRole="body" className="text-foreground">
        {props.action.message}
      </Text>
      <Text selectable className="font-mono text-xs text-foreground-muted">
        {props.action.url}
      </Text>
      <Button
        label="Continue authentication"
        icon="globe"
        tone="secondary"
        onPress={() => {
          void accept({
            environmentId: props.environmentId,
            input: { instanceId: props.instanceId, elicitationId: props.action.elicitationId },
          }).then((result) => {
            if (result._tag === "Success" && !result.value.accepted) {
              Dialog.alert(
                "Authentication request expired",
                "Refresh the provider and start the authentication flow again.",
              );
              return;
            }
            if (reportCommandFailure(result, "Could not continue authentication")) {
              void Linking.openURL(props.action.url).catch(() =>
                Dialog.alert("Could not open the page", props.action.url),
              );
            }
          });
        }}
      />
    </View>
  );
}
