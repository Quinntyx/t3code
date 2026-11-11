import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { managedAcpRegistryAgentId } from "@t3tools/client-runtime/provider-settings/instance";
import {
  configuredSecretSources,
  type SecretRequestSource,
} from "@t3tools/client-runtime/secret-request";
import {
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  defaultInstanceIdForDriver,
  resolveProviderInstanceEnabled,
  type EnvironmentId,
  type ManagedPolicySummary,
  type ProviderDriverKind,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { resolveModelPreferences } from "@t3tools/shared/serverSettings";
import { AsyncResult } from "effect/reactivity";
import Constants from "expo-constants";
import { useState } from "react";

import * as Dialog from "../../../components/ui/Dialog";
import { useEnvironments } from "../../../state/environments";
import { mobilePreferencesAtom } from "../../../state/preferences";
import { serverEnvironment } from "../../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";

const NO_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const NO_SECRET_SOURCES: ReadonlyArray<SecretRequestSource> = [];

export function failureMessage(
  result: { readonly cause: Parameters<typeof squashAtomCommandFailure>[0]["cause"] },
  fallback: string,
) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : fallback;
}

/** Alerts on failure; an interrupted command is not a failure the user needs to hear about. */
export function reportCommandFailure(
  result: AtomCommandResult<unknown, unknown>,
  title: string,
  fallback = "The settings update failed.",
): boolean {
  if (result._tag === "Success") return true;
  if (!isAtomCommandInterrupted(result)) Dialog.alert(title, failureMessage(result, fallback));
  return false;
}

/** Holds a switch where the user put it until the settings stream echoes the write. */
export function usePendingSwitch(saved: boolean) {
  const [pending, setPending] = useState<boolean | null>(null);
  if (pending !== null && pending === saved) setPending(null);
  return {
    value: pending ?? saved,
    change: (next: boolean, write: Promise<boolean>) => {
      setPending(next);
      void write.then((saved) => {
        if (!saved) setPending(null);
      });
    },
  };
}

const NO_LEGACY_FAVORITES: ServerSettings["favorites"] & {} = [];

/**
 * Server model preferences, falling back to this device's favorites from before they moved to the
 * server. A favorite write migrates that list; an empty one must not claim the server's slot.
 */
export function useModelPreferences(settings: ServerSettings) {
  const local = useAtomValue(mobilePreferencesAtom);
  const legacyFavorites = AsyncResult.isSuccess(local)
    ? (local.value.modelFavorites ?? NO_LEGACY_FAVORITES)
    : NO_LEGACY_FAVORITES;
  const preferences = resolveModelPreferences(settings, { favorites: legacyFavorites });
  return {
    preferences,
    favoritesLoaded: settings.favorites !== null || AsyncResult.isSuccess(local),
    favoritesMigration:
      settings.favorites === null
        ? { migrateModelPreferences: { favorites: preferences.favorites } }
        : {},
  };
}

export function useEnvironmentLabel(environmentId: EnvironmentId) {
  return (
    useEnvironments().environments.find(
      (environment) => environment.environmentId === environmentId,
    )?.label ?? "this device"
  );
}

export function useEnvironmentProviders(environmentId: EnvironmentId) {
  return useAtomValue(serverEnvironment.providersValueAtom(environmentId)) ?? NO_PROVIDERS;
}

/** The policy an environment's administrator applies, or undefined when it is unmanaged. */
export function useManagedPolicy(environmentId: EnvironmentId): ManagedPolicySummary | undefined {
  return useAtomValue(serverEnvironment.configValueAtom(environmentId))?.managedPolicy;
}

/** Secret providers a setting can point at; empty when the environment cannot read references. */
export function useSecretSources(environmentId: EnvironmentId): ReadonlyArray<SecretRequestSource> {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  if (Constants.expoConfig?.extra?.secretsFeatureEnabled !== true || !config?.secretReferences) {
    return NO_SECRET_SOURCES;
  }
  return configuredSecretSources(config.settings.secretProviders);
}

export function useEnvironmentServerSettings(environmentId: EnvironmentId) {
  return (
    useAtomValue(serverEnvironment.settingsValueAtom(environmentId)) ?? DEFAULT_SERVER_SETTINGS
  );
}

/** The provider-instance writes the desktop provider settings make, for one environment. */
export function useProviderInstanceActions(environmentId: EnvironmentId) {
  const settings = useEnvironmentServerSettings(environmentId);
  const managedPolicy = useManagedPolicy(environmentId);
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const canWriteSettings = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const mutate = useAtomCommand(serverEnvironment.mutateProviderInstance, { reportFailure: false });
  const saveSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const uninstallManagedBinary = useAtomCommand(
    serverEnvironment.uninstallAcpRegistryManagedBinary,
    { reportFailure: false },
  );

  // Rendering checks scopes once; deferred commits and confirmations run later, so recheck then.
  const allowed = (scope: typeof AuthProvidersManageScope | typeof AuthSettingsWriteScope) => {
    if (readEnvironmentScope(environmentId, scope)) return true;
    Dialog.alert("Not allowed", "This connection can no longer change these settings.");
    return false;
  };

  const persistInstance = async (
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
    patch: ServerSettingsPatch = {},
  ) =>
    allowed(AuthProvidersManageScope) &&
    reportCommandFailure(
      await mutate({
        environmentId,
        input: { patch, providerInstanceMutation: { operation: "upsert", instanceId, instance } },
      }),
      "Could not update provider",
    );

  const updateInstance = (
    instanceId: ProviderInstanceId,
    previous: ProviderInstanceConfig,
    next: ProviderInstanceConfig,
  ) => {
    // Turning off the instance that writes titles and commit messages falls back to the default.
    const clearsTextGeneration =
      next.enabled === false &&
      resolveProviderInstanceEnabled(previous) &&
      settings.textGenerationModelSelection?.instanceId === instanceId &&
      readEnvironmentScope(environmentId, AuthSettingsWriteScope);
    return persistInstance(
      instanceId,
      next,
      clearsTextGeneration
        ? { textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection }
        : {},
    );
  };

  const createInstance = async (instanceId: ProviderInstanceId, instance: ProviderInstanceConfig) =>
    allowed(AuthProvidersManageScope) &&
    reportCommandFailure(
      await mutate({
        environmentId,
        input: {
          patch: {},
          providerInstanceMutation: { operation: "create", instanceId, instance },
        },
      }),
      "Could not add provider",
    );

  const deleteInstance = async (
    instanceId: ProviderInstanceId,
    instance: ProviderInstanceConfig,
  ) => {
    if (!allowed(AuthProvidersManageScope)) return false;
    const removed = reportCommandFailure(
      await mutate({
        environmentId,
        input: { patch: {}, providerInstanceMutation: { operation: "remove", instanceId } },
      }),
      "Could not delete provider",
    );
    const agentId = removed ? managedAcpRegistryAgentId(instance) : null;
    if (agentId === null) return removed;
    // Concurrent removals race client snapshots; the server decides whether the agent is still used.
    const uninstall = await uninstallManagedBinary({ environmentId, input: { agentId } });
    reportCommandFailure(
      uninstall,
      "Provider deleted, but managed files remain",
      "Managed binary cleanup failed.",
    );
    return removed;
  };

  const resetDefaultInstance = async (driver: ProviderDriverKind) =>
    allowed(AuthProvidersManageScope) &&
    reportCommandFailure(
      await mutate({
        environmentId,
        input: {
          patch: {},
          providerInstanceMutation: {
            operation: "remove",
            instanceId: defaultInstanceIdForDriver(driver),
          },
        },
      }),
      "Could not reset provider",
    );

  const updateSettings = async (patch: ServerSettingsPatch) =>
    allowed(AuthSettingsWriteScope) &&
    reportCommandFailure(
      await saveSettings({ environmentId, input: { patch } }),
      "Could not save settings",
    );

  return {
    settings,
    managedPolicy,
    canManage,
    canWriteSettings,
    updateInstance,
    persistInstance,
    createInstance,
    deleteInstance,
    resetDefaultInstance,
    updateSettings,
  };
}
