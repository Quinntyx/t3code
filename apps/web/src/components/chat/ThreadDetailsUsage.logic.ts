import {
  type ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type UsageLimitSourceSnapshots,
} from "@t3tools/contracts";
import {
  collectProviderUsageLimits,
  filterUsageLimitsForModel,
  type LimitPoolAmount,
  type LimitPoolWindow,
  resolveProviderUsageTarget,
  resolveRoutedHubLimitPool,
} from "@t3tools/shared/usageLimits";
import { limitsNotice } from "@t3tools/shared/usageLimitsCopy";

export type ThreadDetailsLimits =
  | { readonly kind: "instance"; readonly limits: ServerProviderUsageLimits }
  | {
      readonly kind: "pool";
      readonly windows: readonly LimitPoolWindow[];
      readonly amounts: readonly LimitPoolAmount[];
    };

export function resolveThreadDetailsLimits(
  providerInstanceId: ProviderInstanceId | null,
  model: string | null,
  providers: readonly ServerProvider[],
  sources: UsageLimitSourceSnapshots,
  now: number,
): ThreadDetailsLimits | null {
  const provider = providers.find((entry) => entry.instanceId === providerInstanceId);
  if (!provider) return null;
  const target = resolveProviderUsageTarget(sources, provider, model);
  if (target.kind === "hub") {
    const pool = resolveRoutedHubLimitPool({ provider, model, providers, sources, now });
    return pool ? { kind: "pool", ...pool } : null;
  }
  if (target.kind === "none") return null;

  if (target.ownLimits && limitsNotice(target.ownLimits) === null) {
    const filtered = filterUsageLimitsForModel(provider.driver, target.ownLimits, model);
    if (limitsNotice(filtered) === null) {
      return { kind: "instance", limits: filtered };
    }
  }
  for (const source of target.nativeSources) {
    if (limitsNotice(source.limits) !== null) continue;
    const filtered = filterUsageLimitsForModel(source.driver, source.limits, model);
    if (limitsNotice(filtered) === null) {
      return { kind: "instance", limits: filtered };
    }
  }

  const report = collectProviderUsageLimits(provider.instanceId, providers, sources, now, model);
  const quotaDriver = target.route.driver;
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
  return target.ownLimits ? { kind: "instance", limits: target.ownLimits } : null;
}

export function nextPoolReset(window: LimitPoolWindow, now: number) {
  const pooled = window.members.length > 1;
  return (
    window.resets.find((reset) => reset.at > now && (!pooled || reset.restoresPercent > 0)) ?? null
  );
}

export function poolSources(window: LimitPoolWindow) {
  const hubs = window.members.flatMap(({ account }) =>
    account.environments.length === 0 && account.sourceLabel ? [account.sourceLabel] : [],
  );
  const signedIn = window.members.some(({ account }) => account.environments.length > 0);
  return { hubs: [...new Set(hubs)], signedIn };
}
