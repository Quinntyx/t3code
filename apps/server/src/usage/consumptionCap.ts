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

export interface ConsumptionCapEvaluation {
  readonly breach: ConsumptionCapBreach | null;
  /**
   * False when the snapshot cannot answer whether the cap is met, such as a
   * missing quota window or an unpriced model contributing to a dollar cap.
   * Callers must not clear an existing hit on an unknown result.
   */
  readonly known: boolean;
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
): ConsumptionCapEvaluation {
  if (cap.mode === "quota") {
    let known = true;
    for (const rule of cap.rules) {
      if (rule.atPercent === undefined) continue;
      const window = quotaWindow(
        rule,
        snapshot.windowsByInstance.get(rule.providerInstanceId) ?? [],
      );
      if (window === undefined) {
        known = false;
        continue;
      }
      // A passed reset means the window is current at zero, not that the data is stale.
      if (!windowIsCurrent(window, nowMs)) continue;
      if (window.usedPercent < rule.atPercent) continue;
      return {
        known: true,
        breach: {
          rule,
          reason: `${window.label} usage ${Math.round(window.usedPercent)}% reached ${rule.atPercent}% cap.`,
        },
      };
    }
    return { breach: null, known };
  }

  const costs = new Map<string, number>();
  const unpriced = new Set<string>();
  let total = 0;
  let pricedModels = 0;
  for (const model of snapshot.models) {
    const key = modelKey(model.providerInstanceId, model.model);
    if (model.costUsd === null) {
      unpriced.add(key);
      continue;
    }
    pricedModels += 1;
    total += model.costUsd;
    costs.set(key, (costs.get(key) ?? 0) + model.costUsd);
  }

  if (cap.totalLimitUsd !== undefined && pricedModels > 0 && total >= cap.totalLimitUsd) {
    return {
      known: true,
      breach: {
        rule: null,
        reason: `Thread API spend ${formatUsd(total)} reached ${formatUsd(cap.totalLimitUsd)} cap.`,
      },
    };
  }

  for (const rule of cap.rules) {
    if (rule.limitUsd === undefined) continue;
    const key = modelKey(rule.providerInstanceId, rule.model);
    const cost = costs.get(key);
    if (cost === undefined || cost < rule.limitUsd) continue;
    return {
      known: true,
      breach: {
        rule,
        reason: `${rule.model} API spend ${formatUsd(cost)} reached ${formatUsd(rule.limitUsd)} cap.`,
      },
    };
  }

  let known = true;
  if (cap.totalLimitUsd !== undefined) {
    known = snapshot.models.length === 0 || (pricedModels > 0 && unpriced.size === 0);
  }
  for (const rule of cap.rules) {
    if (rule.limitUsd === undefined) continue;
    if (unpriced.has(modelKey(rule.providerInstanceId, rule.model))) known = false;
  }
  return { breach: null, known };
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
