import {
  EnvironmentId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  antigravityWindowLimitsModel,
  collectLimitAccounts,
  collectLimitPools,
  collectProviderUsageLimits,
  displayLimitWindows,
  hubRoutes,
  isPiHubModelProvider,
  type LimitPoolAmount,
  type LimitPoolWindow,
  resolveInstanceHubRoutes,
} from "@t3tools/shared/usageLimits";
import { limitsNotice } from "@t3tools/shared/usageLimitsCopy";

export type ThreadDetailsLimits =
  | { readonly kind: "instance"; readonly limits: ServerProviderUsageLimits }
  | {
      readonly kind: "pool";
      readonly windows: readonly LimitPoolWindow[];
      readonly amounts: readonly LimitPoolAmount[];
    };

// collectLimitAccounts keys its input by environment; the card reads one, so any id serves.
const CARD_ENVIRONMENT = EnvironmentId.make("thread-details");

export function resolveThreadDetailsLimits(
  providerInstanceId: ProviderInstanceId | null,
  model: string | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): ThreadDetailsLimits | null {
  const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
  if (!provider) return null;
  const { driver: quotaDriver, hubs } = resolveInstanceHubRoutes(provider, sources, model);
  const modelProvider = model?.split(/[/:]/)[0];
  const piHubModel = provider.driver === "pi" && isPiHubModelProvider(modelProvider);
  if (hubs.length > 0) {
    // An instance routed to a hub spends that hub's pool for the selected model; never fall back
    // to an unrelated local CLI login when the hub pool is unreadable or empty.
    return hubPool(quotaDriver, model, providers, hubs, now);
  }
  if (piHubModel) {
    // Offline or unconfigured CLIProxyAPI hub on Pi must not display unrelated local limits.
    return null;
  }
  const ownDriver = provider.usageLimits?.ownerDriver ?? provider.driver;
  if (
    provider.usageLimits &&
    limitsNotice(provider.usageLimits) === null &&
    ownDriver === quotaDriver
  ) {
    return { kind: "instance", limits: provider.usageLimits };
  }
  const report = collectProviderUsageLimits(provider.instanceId, providers, sources, now, model);
  // Only this instance's data: the report keeps one instance per login, and any other entry may be
  // a different login or workspace, so prefer a usable entry matching the selected model's driver.
  const ownEntries =
    report?.accounts.filter((entry) => entry.instanceId === provider.instanceId) ?? [];
  const matchingOwn =
    ownEntries.find((entry) => entry.driver === quotaDriver && limitsNotice(entry.limits) === null)
      ?.limits ??
    ownEntries.find((entry) => entry.driver === quotaDriver)?.limits ??
    null;
  if (matchingOwn) return { kind: "instance", limits: matchingOwn };
  return provider.usageLimits && ownDriver === quotaDriver
    ? { kind: "instance", limits: provider.usageLimits }
    : null;
}

export function nextPoolReset(window: LimitPoolWindow, now: number) {
  const pooled = window.members.length > 1;
  return (
    window.resets.find((reset) => reset.at > now && (!pooled || reset.restoresPercent > 0)) ?? null
  );
}

function hubPool(
  driver: ServerProvider["driver"],
  model: string | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): ThreadDetailsLimits | null {
  const routes = hubRoutes(sources, driver, model);
  const routed = sources.map((source) => ({
    ...source,
    accounts: source.accounts.filter(routes).map((account) =>
      account.driver === "antigravity"
        ? {
            ...account,
            usageLimits: {
              ...account.usageLimits,
              windows: account.usageLimits.windows.filter((window) =>
                antigravityWindowLimitsModel(window, model),
              ),
            },
          }
        : account,
    ),
  }));
  const readable = routed
    .flatMap((source) => source.accounts)
    .filter((account) => limitsNotice(account.usageLimits) === null);
  if (readable.length === 0) return null;
  // A signed-in login joins the pool only as a fresher reading of an account the hub routes to;
  // strip unrelated usageLimits / usageSources on multi-source providers (such as Pi).
  const matchesHubAccount = (
    accountDriver: ServerProvider["driver"],
    workspaceId: string | undefined,
    email: string | undefined,
  ) =>
    readable.some((account) => {
      const accountEmail = account.email?.toLowerCase();
      return (
        accountEmail !== undefined &&
        account.driver === accountDriver &&
        account.workspaceId === workspaceId &&
        accountEmail === email?.toLowerCase()
      );
    });
  const signedIn: ServerProvider[] = [];
  for (const provider of providers) {
    const ownDriver = provider.usageLimits?.ownerDriver ?? provider.driver;
    const keepOwn =
      provider.usageLimits !== undefined &&
      matchesHubAccount(ownDriver, provider.auth.workspaceId, provider.auth.email);
    const matchingSources = (provider.usageSources ?? []).filter((source) =>
      matchesHubAccount(
        source.limits.ownerDriver ?? source.driver,
        source.workspaceId,
        source.email,
      ),
    );
    if (!keepOwn && matchingSources.length === 0) continue;
    signedIn.push({
      ...provider,
      usageLimits: keepOwn ? provider.usageLimits : undefined,
      usageSources: matchingSources,
    });
  }
  const presentations = new Map([
    [
      CARD_ENVIRONMENT,
      {
        entry: { target: { label: "" } },
        serverConfig: { providers: signedIn, usageLimitSources: routed },
      },
    ],
  ]);
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  return pools.length > 0
    ? {
        kind: "pool",
        windows: pools.flatMap(displayLimitWindows),
        amounts: pools.flatMap((pool) => pool.amounts),
      }
    : null;
}

export function poolSources(window: LimitPoolWindow) {
  const hubs = window.members.flatMap(({ account }) =>
    account.environments.length === 0 && account.sourceLabel ? [account.sourceLabel] : [],
  );
  const signedIn = window.members.some(({ account }) => account.environments.length > 0);
  return { hubs: [...new Set(hubs)], signedIn };
}
