import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { providerClients } from "@t3tools/client-runtime/provider-clients";
import {
  deriveAvailableInstanceId,
  deriveInstanceId,
} from "@t3tools/client-runtime/provider-instance-ids";
import {
  ACP_REGISTRY_WIZARD_STEPS,
  ADD_PROVIDER_WIZARD_STEPS,
  deriveNewInstanceId,
  LOCAL_ACP_WIZARD_STEPS,
  reservedInstanceIds,
  resolveAcpRegistryWizardNavigation,
  resolveWizardNavigation,
  updateProviderIdentityDraft,
  validateInstanceId,
  type ProviderIdentityDraft,
  type WizardNavigation,
} from "@t3tools/client-runtime/provider-settings/add-instance";
import {
  deriveProviderSettingsFields,
  type ProviderClientDefinition,
} from "@t3tools/client-runtime/provider-settings/form";
import { managedInstanceLocks } from "@t3tools/client-runtime/provider-settings/instance";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  AuthProvidersManageScope,
  isManagedDriverAllowed,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveOfficialAcpRegistryIconUrl,
  type AcpRegistrySearchAgent,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
} from "@t3tools/contracts";
import { useState } from "react";
import { Linking, Platform, View } from "react-native";
import { useResolveClassNames } from "uniwind";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { ProviderIcon } from "../../../components/ProviderIcon";
import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { Button } from "../../../components/ui/Button";
import { ControlPill } from "../../../components/ui/ControlPill";
import { ListRow } from "../../../components/ui/ListRow";
import { RowPressable } from "../../../components/ui/RowPressable";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { readEnvironmentScope, useEnvironmentScope } from "../../../state/session";
import { SettingsScreen } from "../components/SettingsScreen";
import { SettingsSection } from "../components/SettingsSection";
import { AcpRegistryPicker } from "./AcpRegistry";
import {
  AccentColorPicker,
  FieldBlock,
  ProviderEnvironmentVariables,
  ProviderSettingsFields,
} from "./ProviderFields";
import { ProviderSignInSection } from "./ProviderSignInSection";
import {
  useEnvironmentLabel,
  useEnvironmentProviders,
  useProviderInstanceActions,
  useSecretSources,
} from "./useProviderSettings";

const ACP_REGISTRY_DRIVER = ProviderDriverKind.make("acpRegistry");
const CODEX_DRIVER = ProviderDriverKind.make("codex");
const DRIVER_OPTIONS = providerClients.definitions.filter(
  (option) => option.driverKind !== ACP_REGISTRY_DRIVER,
);
const FEATURED_DRIVER_OPTIONS = DRIVER_OPTIONS.filter((option) => option.featured !== false);
const MORE_DRIVER_OPTIONS = DRIVER_OPTIONS.filter((option) => option.featured === false);
const EMPTY_CONFIG: Record<string, unknown> = {};
const MULTIPLE_ACCOUNTS_FAQ_URL =
  "https://github.com/pingdotgg/t3code/blob/main/docs/user/faq.md#can-i-add-a-bunch-of-accounts-for-one-provider";

export function AddProviderRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId }>) {
  return (
    <AddProvider key={route.params.environmentId} environmentId={route.params.environmentId} />
  );
}

function AddProvider({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const environmentLabel = useEnvironmentLabel(environmentId);
  const actions = useProviderInstanceActions(environmentId);
  const providers = useEnvironmentProviders(environmentId);
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const sources = useSecretSources(environmentId);
  // Drivers the administrator's policy leaves out are not offered at all.
  const policy = actions.managedPolicy;
  const featuredOptions = FEATURED_DRIVER_OPTIONS.filter((option) =>
    isManagedDriverAllowed(policy, option.driverKind),
  );
  const moreOptions = MORE_DRIVER_OPTIONS.filter((option) =>
    isManagedDriverAllowed(policy, option.driverKind),
  );
  const acpRegistryAllowed = isManagedDriverAllowed(policy, ACP_REGISTRY_DRIVER);
  // A policy that owns Codex's launch settings also rules out ChatGPT's own runtime.
  const chatGptAllowed =
    isManagedDriverAllowed(policy, CODEX_DRIVER) &&
    managedInstanceLocks(policy, CODEX_DRIVER)?.configKeys.has("setupMode") !== true;

  const [step, setStep] = useState(0);
  const [driver, setDriver] = useState<ProviderDriverKind>(
    () =>
      (featuredOptions[0] ?? moreOptions[0])?.driverKind ??
      (acpRegistryAllowed ? ACP_REGISTRY_DRIVER : FEATURED_DRIVER_OPTIONS[0]!.driverKind),
  );
  const [identityByDriver, setIdentityByDriver] = useState<Record<string, ProviderIdentityDraft>>(
    {},
  );
  const [configByDriver, setConfigByDriver] = useState<Record<string, Record<string, unknown>>>({});
  const [selectedAcp, setSelectedAcp] = useState<AcpRegistrySearchAgent | null>(null);
  const [manualAcp, setManualAcp] = useState(false);
  const [localEnvironment, setLocalEnvironment] = useState<
    ReadonlyArray<ProviderInstanceEnvironmentVariable>
  >([]);
  const [showMore, setShowMore] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [createdId, setCreatedId] = useState<ProviderInstanceId | null>(null);

  const existingIds = reservedInstanceIds(actions.settings.providerInstances);
  const definition = providerClients.get(driver) ?? FEATURED_DRIVER_OPTIONS[0]!;
  const driverLocks = managedInstanceLocks(policy, driver);
  const managedConfig = driverLocks && { keys: driverLocks.configKeys, reason: driverLocks.reason };
  const isAcp = driver === ACP_REGISTRY_DRIVER;
  const identity = identityByDriver[driver] ?? {
    label: definition.label,
    accentColor: "",
    instanceIdOverride: null,
  };
  const instanceId =
    identity.instanceIdOverride ??
    deriveNewInstanceId({
      driver,
      driverLabel: definition.label,
      label: identity.label,
      existingIds,
    });
  const instanceIdError = validateInstanceId(instanceId, existingIds);
  const config = configByDriver[driver] ?? EMPTY_CONFIG;
  const isLocalAcp = isAcp && manualAcp && config.source === "local";
  const localCommand = typeof config.commandPath === "string" ? config.commandPath.trim() : "";
  const manualAgentId = typeof config.agentId === "string" ? config.agentId.trim() : "";
  const acpSelectionError = isLocalAcp
    ? localCommand.length > 0
      ? null
      : "Executable is required."
    : selectedAcp !== null || (manualAcp && manualAgentId.length > 0)
      ? null
      : "Select an agent or configure one manually.";
  const steps = isAcp
    ? isLocalAcp
      ? LOCAL_ACP_WIZARD_STEPS
      : ACP_REGISTRY_WIZARD_STEPS
    : ADD_PROVIDER_WIZARD_STEPS;
  const lastEditableStep = isAcp ? 1 : 2;

  const setIdentity = (update: Partial<ProviderIdentityDraft>) =>
    setIdentityByDriver((existing) => ({ ...existing, [driver]: { ...identity, ...update } }));
  const setConfig = (next: Record<string, unknown> | undefined) =>
    setConfigByDriver((existing) => {
      const copy = { ...existing };
      if (next === undefined || Object.keys(next).length === 0) delete copy[driver];
      else copy[driver] = next;
      return copy;
    });

  const navigate = (requested: number) => {
    const navigation_: WizardNavigation = isAcp
      ? isLocalAcp
        ? resolveWizardNavigation(step, requested, LOCAL_ACP_WIZARD_STEPS.length, {
            instanceIdError,
            prerequisite: { step: 0, error: acpSelectionError },
          })
        : resolveAcpRegistryWizardNavigation(step, requested, {
            instanceIdError,
            selectionError: acpSelectionError,
          })
      : resolveWizardNavigation(step, requested, ADD_PROVIDER_WIZARD_STEPS.length, {
          instanceIdError,
        });
    if (navigation_.kind === "blocked") setAttempted(true);
    setStep(navigation_.step);
  };

  const chooseDriver = (option: ProviderClientDefinition) => {
    setDriver(option.driverKind);
    setManualAcp(false);
    setSelectedAcp(null);
    setAttempted(false);
    setStep(1);
  };

  const finish = (id: ProviderInstanceId) =>
    navigation.dispatch(
      StackActions.replace("SettingsProviderInstance", { environmentId, instanceId: id }),
    );

  const save = async () => {
    if (!readEnvironmentScope(environmentId, AuthProvidersManageScope) || saving) return;
    setAttempted(true);
    if (instanceIdError !== null || (isAcp && acpSelectionError !== null)) return;
    const savedConfig = driver === "codex" ? { ...config, setupMode: "existing" } : config;
    const accentColor = normalizeProviderAccentColor(identity.accentColor);
    const instance: ProviderInstanceConfig = {
      driver,
      enabled: true,
      ...(identity.label.trim().length > 0 ? { displayName: identity.label.trim() } : {}),
      ...(accentColor ? { accentColor } : {}),
      ...(Object.keys(savedConfig).length > 0 ? { config: savedConfig } : {}),
      ...(isLocalAcp && localEnvironment.length > 0 ? { environment: localEnvironment } : {}),
    };
    const id = ProviderInstanceId.make(instanceId);
    setSaving(true);
    const created = await actions.createInstance(id, instance);
    setSaving(false);
    if (!created) return;
    if (isAcp && !isLocalAcp) {
      setCreatedId(id);
      setStep(2);
      return;
    }
    finish(id);
  };

  const prepareAcp = (agent: AcpRegistrySearchAgent) => {
    const registryIconUrl = resolveOfficialAcpRegistryIconUrl(agent.icon);
    setDriver(ACP_REGISTRY_DRIVER);
    setSelectedAcp(agent);
    setManualAcp(false);
    setIdentityByDriver((existing) =>
      updateProviderIdentityDraft(existing, ACP_REGISTRY_DRIVER, {
        label: agent.name,
        instanceIdOverride: deriveAvailableInstanceId(
          (label) => deriveInstanceId(ACP_REGISTRY_DRIVER, label),
          agent.name,
          existingIds,
        ),
      }),
    );
    setConfigByDriver((existing) => ({
      ...existing,
      [ACP_REGISTRY_DRIVER]: {
        agentId: agent.id,
        distribution: "auto",
        ...(registryIconUrl ? { registryIconUrl } : {}),
      },
    }));
    setAttempted(false);
    setStep(1);
  };

  const configureAcpManually = (local: boolean) => {
    setDriver(ACP_REGISTRY_DRIVER);
    setSelectedAcp(null);
    setManualAcp(true);
    setConfigByDriver((existing) => {
      const copy = { ...existing };
      if (local) copy[ACP_REGISTRY_DRIVER] = { source: "local", commandArgs: [] };
      else delete copy[ACP_REGISTRY_DRIVER];
      return copy;
    });
    setIdentityByDriver((existing) =>
      updateProviderIdentityDraft(existing, ACP_REGISTRY_DRIVER, {
        label: local ? "Local ACP" : "",
        instanceIdOverride: null,
      }),
    );
    setLocalEnvironment([]);
    setAttempted(false);
  };

  const signedInAccount = providers.some(
    (provider) =>
      provider.driver === driver &&
      (driver === "codex" || driver === "claudeAgent") &&
      provider.auth.status === "authenticated",
  );

  const footer =
    createdId !== null ? (
      <Button label="Done" onPress={() => finish(createdId)} fullWidth />
    ) : step === 0 && !(isAcp && manualAcp) ? null : (
      <View className="flex-row gap-3">
        <View className="flex-1">
          <Button
            label="Back"
            tone="secondary"
            disabled={saving}
            fullWidth
            onPress={() => {
              if (step === 0) {
                setManualAcp(false);
                setAttempted(false);
              } else setStep(step - 1);
            }}
          />
        </View>
        <View className="flex-1">
          {step < lastEditableStep ? (
            <Button label="Next" fullWidth onPress={() => navigate(step + 1)} />
          ) : (
            <Button
              label={isAcp && !isLocalAcp ? "Continue to sign-in" : "Add provider"}
              loading={saving}
              disabled={saving || !canManage}
              fullWidth
              onPress={() => void save()}
            />
          )}
        </View>
      </View>
    );

  return (
    <SettingsScreen title="Add provider">
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {step > 0 || createdId !== null ? (
          <StepIndicator steps={steps} current={step} />
        ) : (
          <Text textRole="footnote" className="px-1 text-foreground-muted">
            {`Add an account or configure a provider on ${environmentLabel}.`}
          </Text>
        )}

        {step === 0 && createdId === null ? (
          isAcp && manualAcp ? (
            <SettingsSection
              title={isLocalAcp ? "Local ACP command" : "Registry agent"}
              trailing={
                <ControlPill
                  variant="pill"
                  label="Search registry"
                  onPress={() => {
                    setManualAcp(false);
                    setAttempted(false);
                  }}
                />
              }
              footer={
                isLocalAcp
                  ? `Runs an installed ACP executable on ${environmentLabel}.`
                  : "Enter an official registry ID and any local executable or auth override."
              }
            >
              <ProviderSettingsFields
                definition={definition}
                value={config}
                disabled={false}
                sources={sources}
                managed={managedConfig}
                onChange={setConfig}
              />
              {isLocalAcp ? (
                <View className="border-t border-border-subtle">
                  <ProviderEnvironmentVariables
                    environment={localEnvironment}
                    disabled={false}
                    sources={sources}
                    onChange={setLocalEnvironment}
                  />
                </View>
              ) : null}
              {attempted && acpSelectionError ? <ErrorText message={acpSelectionError} /> : null}
            </SettingsSection>
          ) : (
            <>
              {chatGptAllowed ? (
                <SettingsSection title="Connect an account">
                  <ListRow
                    label="Continue with ChatGPT"
                    description="Sign in a managed Codex account."
                    onPress={() =>
                      navigation.navigate("SettingsProviderAddChatGpt", { environmentId })
                    }
                  />
                </SettingsSection>
              ) : null}
              <SettingsSection title="Providers">
                {featuredOptions.map((option, index) => (
                  <DriverRow
                    key={option.driverKind}
                    option={option}
                    separated={index > 0}
                    onPress={() => chooseDriver(option)}
                  />
                ))}
                {showMore
                  ? moreOptions.map((option) => (
                      <DriverRow
                        key={option.driverKind}
                        option={option}
                        separated
                        onPress={() => chooseDriver(option)}
                      />
                    ))
                  : null}
                {moreOptions.length > 0 ? (
                  <View
                    className={
                      featuredOptions.length > 0 ? "border-t border-border-subtle" : undefined
                    }
                  >
                    <RowPressable
                      accessibilityRole="button"
                      onPress={() => setShowMore((value) => !value)}
                      className="bg-grouped-card"
                    >
                      <View className="min-h-12 flex-row items-center justify-center gap-2 px-4 py-3">
                        <Text textRole="footnote" className="font-t3-medium text-primary-text">
                          {showMore ? "Show fewer providers" : "Show more providers"}
                        </Text>
                        <SymbolView
                          name={showMore ? "chevron.up" : "chevron.down"}
                          size={12}
                          tintColorClassName="accent-primary-text"
                          type="monochrome"
                        />
                      </View>
                    </RowPressable>
                  </View>
                ) : null}
              </SettingsSection>
              {acpRegistryAllowed ? (
                <View className="gap-2">
                  <Text textRole="footnote" className="px-2 font-t3-medium text-foreground-muted">
                    ACP Registry
                  </Text>
                  <AcpRegistryPicker
                    environmentId={environmentId}
                    providerInstances={actions.settings.providerInstances}
                    onPrepared={prepareAcp}
                    onManualConfiguration={() => configureAcpManually(false)}
                    onLocalConfiguration={() => configureAcpManually(true)}
                  />
                </View>
              ) : null}
            </>
          )
        ) : null}

        {step === 1 && createdId === null ? (
          <>
            {isAcp && selectedAcp ? (
              <SettingsSection>
                <FieldBlock
                  label={selectedAcp.name}
                  description={`v${selectedAcp.version} · ${selectedAcp.distribution}`}
                  trailing={
                    <View className="flex-row gap-2">
                      {selectedAcp.website ? (
                        <ControlPill
                          variant="pill"
                          label="Docs"
                          onPress={() => void Linking.openURL(selectedAcp.website!)}
                        />
                      ) : null}
                      {selectedAcp.repository ? (
                        <ControlPill
                          variant="pill"
                          label="Source"
                          onPress={() => void Linking.openURL(selectedAcp.repository!)}
                        />
                      ) : null}
                    </View>
                  }
                />
              </SettingsSection>
            ) : null}
            <SettingsSection
              title={isAcp ? "Identity" : `${definition.label} identity`}
              footer={
                signedInAccount
                  ? `${environmentLabel} already has a ${definition.label} account signed in. Managing several ${definition.label} accounts in T3 Code is not recommended.`
                  : undefined
              }
            >
              <FieldBlock label="Label" description="Shown in the provider list.">
                <AppTextInput
                  accessibilityLabel="Label"
                  value={identity.label}
                  placeholder="e.g. Work"
                  autoCorrect={false}
                  className="min-h-11 rounded-xl px-3 py-2 text-base"
                  onChangeText={(label) => setIdentity({ label })}
                />
              </FieldBlock>
              <FieldBlock label="Instance ID" description="Letters, digits, '-', or '_'." separated>
                <AppTextInput
                  accessibilityLabel="Instance ID"
                  value={instanceId}
                  placeholder={`${driver}_work`}
                  autoCapitalize="none"
                  autoCorrect={false}
                  className="min-h-11 rounded-xl px-3 py-2 font-mono text-sm"
                  onChangeText={(value) => setIdentity({ instanceIdOverride: value })}
                />
                {attempted && instanceIdError ? (
                  <ErrorText message={instanceIdError} inline />
                ) : null}
              </FieldBlock>
              <FieldBlock
                label="Accent color"
                description="Optional marker shown in the picker."
                separated
              >
                <AccentColorPicker
                  value={identity.accentColor || undefined}
                  disabled={false}
                  onCommit={(accentColor) => setIdentity({ accentColor })}
                />
              </FieldBlock>
            </SettingsSection>
            {signedInAccount ? (
              <ControlPill
                variant="pill"
                label="Why not several accounts?"
                onPress={() => void Linking.openURL(MULTIPLE_ACCOUNTS_FAQ_URL)}
              />
            ) : null}
          </>
        ) : null}

        {step === 2 && createdId === null && !isAcp ? (
          <SettingsSection title="Configuration">
            {deriveProviderSettingsFields(definition).length > 0 ? (
              <ProviderSettingsFields
                definition={definition}
                value={config}
                disabled={false}
                sources={sources}
                managed={managedConfig}
                onChange={setConfig}
              />
            ) : (
              <FieldBlock
                label="Nothing to configure"
                description="This provider has no required configuration. You can add it now."
              />
            )}
          </SettingsSection>
        ) : null}

        {createdId !== null ? (
          <CreatedProviderSignIn
            environmentId={environmentId}
            environmentLabel={environmentLabel}
            instanceId={createdId}
          />
        ) : null}

        {footer}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function StepIndicator(props: { readonly steps: readonly string[]; readonly current: number }) {
  return (
    <View
      accessible
      accessibilityLabel={`Step ${props.current + 1} of ${props.steps.length}: ${props.steps[props.current]}`}
      className="flex-row gap-2 px-1"
    >
      {props.steps.map((label, index) => (
        <View key={label} className="flex-1 gap-1.5">
          <View
            className={
              index <= props.current
                ? "h-1 rounded-full bg-primary"
                : "h-1 rounded-full bg-subtle-strong"
            }
          />
          <Text
            textRole="caption"
            className={index === props.current ? "text-foreground" : "text-foreground-muted"}
            numberOfLines={1}
          >
            {label}
          </Text>
        </View>
      ))}
    </View>
  );
}

function DriverRow(props: {
  readonly option: ProviderClientDefinition;
  readonly separated: boolean;
  readonly onPress: () => void;
}) {
  const rippleStyle = useResolveClassNames("bg-subtle-strong");
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={[props.option.label, props.option.badgeLabel].filter(Boolean).join(", ")}
      onPress={props.onPress}
      android_ripple={{ color: rippleStyle.backgroundColor }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className={
        props.separated ? "border-t border-border-subtle bg-grouped-card" : "bg-grouped-card"
      }
    >
      <View className="min-h-14 flex-row items-center gap-3 px-4 py-3">
        <View className="size-9 items-center justify-center rounded-xl bg-subtle">
          <ProviderIcon provider={props.option.driverKind} size={20} />
        </View>
        <Text textRole="body" className="min-w-0 flex-1 text-foreground" numberOfLines={1}>
          {props.option.label}
        </Text>
        {props.option.badgeLabel ? (
          <View className="rounded-full bg-warning/15 px-2 py-0.5">
            <Text textRole="caption" className="text-warning-foreground">
              {props.option.badgeLabel}
            </Text>
          </View>
        ) : null}
        <SymbolView
          name="chevron.right"
          size={16}
          tintColorClassName="accent-chevron"
          type="monochrome"
          weight="semibold"
        />
      </View>
    </RowPressable>
  );
}

function ErrorText(props: { readonly message: string; readonly inline?: boolean }) {
  return (
    <Text
      accessibilityRole="alert"
      textRole="footnote"
      className={props.inline ? "text-danger-foreground" : "px-4 pb-3 text-danger-foreground"}
    >
      {props.message}
    </Text>
  );
}

function CreatedProviderSignIn(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
}) {
  const provider = useEnvironmentProviders(props.environmentId).find(
    (candidate) => candidate.instanceId === props.instanceId,
  );
  return (
    <SettingsSection title="Sign-in" footer="You can sign in later from this provider's settings.">
      {provider ? (
        <ProviderSignInSection
          environment={{ environmentId: props.environmentId, label: props.environmentLabel }}
          provider={provider}
        />
      ) : (
        <FieldBlock
          label="Account"
          description={`Waiting for ${props.environmentLabel} to start the provider…`}
        />
      )}
    </SettingsSection>
  );
}
