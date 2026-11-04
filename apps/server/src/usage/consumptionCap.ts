import type {
  ProviderInstanceId,
  ThreadConsumptionCap,
  ThreadConsumptionCapRule,
  ThreadConsumptionCapWindowKind,
  ThreadUsageModel,
} from "@t3tools/contracts";
import { formatUsd } from "@t3tools/shared/usageFormat";

export interface ConsumptionCapModelUsage {
  readonly providerInstanceId: ProviderInstanceId;
  readonly model: string;
  readonly costUsd: number | null;
}

export interface ConsumptionCapWindow {
  readonly id: string;
  readonly kind: ThreadConsumptionCapWindowKind;
  readonly label: string;
  readonly usedPercent: number;
  readonly resetsAt: string | null;
}

export interface ConsumptionCapSnapshot {
  readonly models: ReadonlyArray<ConsumptionCapModelUsage>;
  readonly windowsByInstance: ReadonlyMap<string, ReadonlyArray<ConsumptionCapWindow>>;
}

export interface ConsumptionCapBreach {
  readonly reason: string;
  readonly rule: ThreadConsumptionCapRule | null;
}

const modelKey = (providerInstanceId: string, model: string) =>
  `${providerInstanceId}\u0000${model}`;

/** A quota window resets on its own; stale percentages must not keep a thread limited. */
function windowIsCurrent(window: ConsumptionCapWindow, nowMs: number): boolean {
  if (window.resetsAt === null) return true;
  const resetsAt = Date.parse(window.resetsAt);
  return Number.isFinite(resetsAt) && resetsAt > nowMs;
}

function quotaWindow(rule: ThreadConsumptionCapRule, windows: ReadonlyArray<ConsumptionCapWindow>) {
  const byId =
    rule.windowId === undefined ? undefined : windows.find((w) => w.id === rule.windowId);
  if (byId !== undefined) return byId;
  return rule.windowKind === undefined
    ? undefined
    : windows.find((w) => w.kind === rule.windowKind);
}

/**
 * The thread's own and delegated turns count against one cap. Models without a
 * rate contribute no dollars, so a total is only ever a priced floor.
 */
export function evaluateConsumptionCap(
  cap: ThreadConsumptionCap,
  snapshot: ConsumptionCapSnapshot,
  nowMs: number,
): ConsumptionCapBreach | null {
  if (cap.mode === "quota") {
    for (const rule of cap.rules) {
      if (rule.atPercent === undefined) continue;
      const window = quotaWindow(
        rule,
        snapshot.windowsByInstance.get(rule.providerInstanceId) ?? [],
      );
      if (window === undefined || !windowIsCurrent(window, nowMs)) continue;
      if (window.usedPercent < rule.atPercent) continue;
      return {
        rule,
        reason: `${window.label} usage ${Math.round(window.usedPercent)}% reached ${rule.atPercent}% cap.`,
      };
    }
    return null;
  }

  const costs = new Map<string, number>();
  let total = 0;
  let pricedModels = 0;
  for (const model of snapshot.models) {
    if (model.costUsd === null) continue;
    pricedModels += 1;
    total += model.costUsd;
    const key = modelKey(model.providerInstanceId, model.model);
    costs.set(key, (costs.get(key) ?? 0) + model.costUsd);
  }

  if (cap.totalLimitUsd !== undefined && pricedModels > 0 && total >= cap.totalLimitUsd) {
    return {
      rule: null,
      reason: `Thread API spend ${formatUsd(total)} reached ${formatUsd(cap.totalLimitUsd)} cap.`,
    };
  }

  for (const rule of cap.rules) {
    if (rule.limitUsd === undefined) continue;
    const cost = costs.get(modelKey(rule.providerInstanceId, rule.model));
    if (cost === undefined || cost < rule.limitUsd) continue;
    return {
      rule,
      reason: `${rule.model} API spend ${formatUsd(cost)} reached ${formatUsd(rule.limitUsd)} cap.`,
    };
  }
  return null;
}

/** Keeps a duplicate check from writing the same hit every scheduler tick. */
export function consumptionCapHitMatches(
  hit: { readonly reason: string } | null | undefined,
  breach: ConsumptionCapBreach | null,
): boolean {
  return hit != null && breach !== null && hit.reason === breach.reason;
}

export function capModel(
  model: Pick<ThreadUsageModel, "providerInstanceId" | "model" | "costUsd">,
): ConsumptionCapModelUsage {
  return {
    providerInstanceId: model.providerInstanceId,
    model: model.model,
    costUsd: model.costUsd,
  };
}
