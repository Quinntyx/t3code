import { useNavigation } from "@react-navigation/native";
import { getProviderVersionLabel } from "@t3tools/client-runtime/provider-settings/status";
import {
  deriveProviderInstanceRows,
  providerInstanceName,
  type ProviderInstanceRow,
} from "@t3tools/client-runtime/provider-settings/instance";
import {
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  isManagedDriverAllowed,
  type EnvironmentId,
  type ServerProvider,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Platform, View } from "react-native";
import { useResolveClassNames } from "uniwind";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppText as Text } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { ControlPill } from "../../../components/ui/ControlPill";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListRow } from "../../../components/ui/ListRow";
import { RowPressable } from "../../../components/ui/RowPressable";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { ThemedSwitch } from "../../../components/ui/ThemedSwitch";
import { relativeTime } from "../../../lib/time";
import { serverEnvironment } from "../../../state/server";
import { useEnvironmentScope, useEnvironmentsWithScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { useSettingsEnvironmentMenu } from "../components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "../components/SettingsScreen";
import { SettingsSection } from "../components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "../settings-environment-filter";
import {
  describeProviderInstance,
  isProviderUpdating,
  ProviderInstanceGlyph,
  ProviderStatusDot,
} from "./ProviderStatus";
import {
  reportCommandFailure,
  useEnvironmentProviders,
  usePendingSwitch,
  useProviderInstanceActions,
} from "./useProviderSettings";

export function ProvidersRouteScreen() {
  const environmentMenu = useSettingsEnvironmentMenu();
  const { selectedTargets } = useSettingsEnvironmentFilter();
  const permitted = useEnvironmentsWithScope(selectedTargets, AuthProvidersManageScope);
  const insets = useSafeAreaInsets();
  return (
    <SettingsScreen title="Providers" menus={[environmentMenu]}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {selectedTargets.length === 0 ? (
          <Text className="text-foreground-muted">Select a connected environment.</Text>
        ) : (
          selectedTargets.map((environment) => (
            <EnvironmentProviders
              key={environment.environmentId}
              environment={environment}
              readOnly={!permitted.has(environment.environmentId)}
              showOptionsTitle={selectedTargets.length > 1}
            />
          ))
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function EnvironmentProviders(props: {
  readonly environment: SettingsTarget;
  readonly readOnly: boolean;
  readonly showOptionsTitle: boolean;
}) {
  const { environmentId, label } = props.environment;
  const navigation = useNavigation();
  const providers = useEnvironmentProviders(environmentId);
  const actions = useProviderInstanceActions(environmentId);
  const rows = deriveProviderInstanceRows({
    providerInstances: actions.settings.providerInstances,
    serverProviders: providers,
  });
  // A policy that allows no provider leaves nothing to add.
  const canAdd =
    !props.readOnly && actions.managedPolicy?.limits?.providers?.allowedDrivers?.length !== 0;
  return (
    <View className="gap-6">
      <SettingsSection
        title={label}
        trailing={<RefreshProvidersControl environmentId={environmentId} providers={providers} />}
        footer={
          props.readOnly
            ? `This session can view ${label}'s providers but can't change their settings.`
            : undefined
        }
      >
        {rows.map((row, index) => (
          <ProviderListRow
            key={row.instanceId}
            environmentId={environmentId}
            row={row}
            provider={providers.find((candidate) => candidate.instanceId === row.instanceId)}
            separated={index > 0}
            readOnly={props.readOnly}
            driverAllowed={isManagedDriverAllowed(actions.managedPolicy, row.driver)}
            onToggle={(enabled) => {
              const instance = row.explicitInstance ?? { driver: row.driver };
              return actions.updateInstance(row.instanceId, instance, { ...instance, enabled });
            }}
          />
        ))}
        {canAdd ? (
          <View className={rows.length > 0 ? "border-t border-border-subtle" : undefined}>
            <ListActionRow
              icon="plus"
              label="Add provider"
              onPress={() => navigation.navigate("SettingsProviderAdd", { environmentId })}
            />
          </View>
        ) : null}
      </SettingsSection>
      <SettingsSection title={props.showOptionsTitle ? `${label} options` : undefined}>
        <ListRow
          icon="chart.bar.xaxis"
          label="Usage and background checks"
          description="Usage hubs, health check interval, and idle compaction"
          onPress={() =>
            navigation.navigate("SettingsProviderEnvironmentOptions", { environmentId })
          }
        />
      </SettingsSection>
    </View>
  );
}

function RefreshProvidersControl(props: {
  readonly environmentId: EnvironmentId;
  readonly providers: ReadonlyArray<ServerProvider>;
}) {
  const canRefresh = useEnvironmentScope(props.environmentId, AuthOrchestrationReadScope);
  const refresh = useAtomCommand(serverEnvironment.refreshProviders, { reportFailure: false });
  const [refreshing, setRefreshing] = useState(false);
  const refreshingRef = useRef(false);
  const lastChecked = props.providers.reduce<string | null>(
    (latest, provider) =>
      latest === null || provider.checkedAt > latest ? provider.checkedAt : latest,
    null,
  );
  return (
    <View
      className={
        Platform.OS === "android"
          ? "flex-row items-center gap-2 pr-2"
          : "flex-row items-center gap-2"
      }
    >
      {lastChecked && !refreshing ? (
        <Text textRole="footnote" className="text-foreground-muted">
          {`Checked ${relativeTime(lastChecked)}`}
        </Text>
      ) : null}
      {refreshing ? (
        <View className="size-9 items-center justify-center">
          <AppActivityIndicator colorClassName="accent-icon" />
        </View>
      ) : (
        <ControlPill
          icon="arrow.clockwise"
          accessibilityLabel="Refresh provider status"
          disabled={!canRefresh}
          onPress={() => {
            if (refreshingRef.current) return;
            refreshingRef.current = true;
            setRefreshing(true);
            void refresh({
              environmentId: props.environmentId,
              input: { refreshModels: true, reloadSecrets: true },
            }).then((result) => {
              refreshingRef.current = false;
              setRefreshing(false);
              reportCommandFailure(result, "Could not refresh providers", "The refresh failed.");
            });
          }}
        />
      )}
    </View>
  );
}

function ProviderListRow(props: {
  readonly environmentId: EnvironmentId;
  readonly row: ProviderInstanceRow;
  readonly provider: ServerProvider | undefined;
  readonly separated: boolean;
  readonly readOnly: boolean;
  readonly driverAllowed: boolean;
  readonly onToggle: (enabled: boolean) => Promise<boolean>;
}) {
  const navigation = useNavigation();
  const rippleStyle = useResolveClassNames("bg-subtle-strong");
  const instance = props.row.explicitInstance ?? { driver: props.row.driver };
  const status = describeProviderInstance(instance, props.provider);
  const enabledSwitch = usePendingSwitch(status.enabled);
  const enabled = enabledSwitch.value;
  const name = providerInstanceName(instance);
  const version = getProviderVersionLabel(props.provider?.version);
  const hasUpdate =
    status.enabled &&
    (props.provider?.versionAdvisory?.status === "behind_latest" ||
      (props.provider?.compatibilityAdvisory !== undefined &&
        props.provider.compatibilityAdvisory.status !== "supported" &&
        props.provider.compatibilityAdvisory.status !== "unknown"));
  const statusLine =
    status.needsAttention && status.detail && !isProviderUpdating(props.provider)
      ? `${status.headline} · ${status.detail}`
      : status.headline;
  return (
    <RowPressable
      accessibilityRole="button"
      accessibilityLabel={[name, version, statusLine].filter(Boolean).join(", ")}
      accessibilityHint="Opens provider settings"
      onPress={() =>
        navigation.navigate("SettingsProviderInstance", {
          environmentId: props.environmentId,
          instanceId: props.row.instanceId,
        })
      }
      android_ripple={{ color: rippleStyle.backgroundColor }}
      unstable_pressDelay={Platform.OS === "android" ? 50 : undefined}
      className={
        props.separated ? "border-t border-border-subtle bg-grouped-card" : "bg-grouped-card"
      }
    >
      <View className="min-h-18 flex-row items-center gap-3 px-4 py-3">
        <View className={enabled ? undefined : "opacity-50"}>
          <ProviderInstanceGlyph instance={instance} size={20} />
        </View>
        <View className="min-w-0 flex-1 gap-1">
          <View className="flex-row items-center gap-2">
            <Text textRole="body" className="shrink text-foreground" numberOfLines={1}>
              {name}
            </Text>
            {version ? (
              <Text
                textRole="footnote"
                className="shrink-0 font-mono text-foreground-muted"
                numberOfLines={1}
              >
                {version}
              </Text>
            ) : null}
            {hasUpdate ? (
              <SymbolView
                name="arrow.up.circle"
                size={14}
                tintColorClassName={
                  status.needsAttention ? "accent-warning" : "accent-primary-text"
                }
                type="monochrome"
              />
            ) : null}
          </View>
          <View className="flex-row items-center gap-1.5">
            <ProviderStatusDot status={status.statusKey} />
            <Text
              accessibilityLiveRegion="polite"
              textRole="footnote"
              className="shrink text-foreground-muted"
              numberOfLines={2}
            >
              {statusLine}
            </Text>
          </View>
        </View>
        <ThemedSwitch
          accessibilityLabel={`Turn on ${name}`}
          // The policy refuses switching it on; switching it off stays the user's call.
          disabled={props.readOnly || (!enabled && !props.driverAllowed)}
          value={enabled}
          onValueChange={(value) => enabledSwitch.change(value, props.onToggle(value))}
        />
      </View>
    </RowPressable>
  );
}
