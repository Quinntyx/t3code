import type {
  ProviderInstanceId,
  ThreadConsumptionCap,
  ThreadConsumptionCapCondition,
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
  /** Instances the worker read for this cap's quota conditions. */
  readonly windowsByInstance: ReadonlyMap<string, ReadonlyArray<ConsumptionCapWindow>>;
  /** Model-scoped windows keyed by `capModelKey(instanceId, model)`. */
  readonly windowsByModel?: ReadonlyMap<string, ReadonlyArray<ConsumptionCapWindow>>;
  /** Active thread target used when an unscoped quota condition evaluates against `windowsByModel`. */
  readonly activeTarget?: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly model: string | null;
  } | null;
}

export interface ConsumptionCapBreach {
  readonly reason: string;
}

export interface ConsumptionCapEvaluation {
  readonly breach: ConsumptionCapBreach | null;
  /**
   * False when the snapshot cannot answer whether the cap is met, such as a
   * missing quota window or an unpriced model inside a dollar condition.
   * Callers must not clear an existing hit on an unknown result.
   */
  readonly known: boolean;
}

export const capModelKey = (providerInstanceId: string, model: string | null) =>
  `${providerInstanceId}\u0000${model ?? ""}`;

const modelKey = (providerInstanceId: string, model: string) =>
  `${providerInstanceId}\u0000${model}`;

/** A quota window resets on its own; stale percentages must not keep a thread limited. */
function windowIsCurrent(window: ConsumptionCapWindow, nowMs: number): boolean {
  if (window.resetsAt === null) return true;
  const resetsAt = Date.parse(window.resetsAt);
  return Number.isFinite(resetsAt) && resetsAt > nowMs;
}

function conditionModels(condition: ThreadConsumptionCapCondition) {
  const scope = condition.models;
  if (scope === undefined) return undefined;
  return new Set(scope.map((entry) => modelKey(entry.providerInstanceId, entry.model)));
}

function conditionScopeLabel(condition: ThreadConsumptionCapCondition): string {
  const scope = condition.models;
  if (scope === undefined) return "Thread";
  return scope.length === 1 ? scope[0]!.model : `${scope.length} models`;
}

/**
 * A thread stops on the first condition it meets, whether that condition counts
 * dollars or a provider usage window.
 */
export function evaluateConsumptionCap(
  cap: ThreadConsumptionCap,
  snapshot: ConsumptionCapSnapshot,
  nowMs: number,
): ConsumptionCapEvaluation {
  let known = true;

  for (const condition of cap.conditions) {
    const scope = conditionModels(condition);

    if (condition.kind === "spend") {
      let total = 0;
      let pricedModels = 0;
      let unpriced = false;
      for (const model of snapshot.models) {
        if (scope !== undefined && !scope.has(modelKey(model.providerInstanceId, model.model))) {
          continue;
        }
        if (model.costUsd === null) {
          unpriced = true;
          continue;
        }
        pricedModels += 1;
        total += model.costUsd;
      }
      if (pricedModels > 0 && total >= condition.limitUsd) {
        return {
          known: true,
          breach: {
            reason: `${conditionScopeLabel(condition)} API spend ${formatUsd(total)} reached ${formatUsd(condition.limitUsd)} cap.`,
          },
        };
      }
      // Unpriced spend is a floor, so a short total cannot clear the limit.
      if (unpriced) known = false;
      continue;
    }

    const windowLists: Array<ReadonlyArray<ConsumptionCapWindow>> =
      scope === undefined
        ? snapshot.windowsByModel !== undefined
          ? (() => {
              const targetKeys = new Set<string>();
              for (const model of snapshot.models) {
                targetKeys.add(capModelKey(model.providerInstanceId, model.model));
              }
              if (snapshot.activeTarget != null) {
                targetKeys.add(
                  capModelKey(
                    snapshot.activeTarget.providerInstanceId,
                    snapshot.activeTarget.model,
                  ),
                );
              }
              return [...targetKeys].map((key) => snapshot.windowsByModel!.get(key) ?? []);
            })()
          : [...snapshot.windowsByInstance.values()]
        : (condition.models ?? []).map(
            (entry) =>
              snapshot.windowsByModel?.get(capModelKey(entry.providerInstanceId, entry.model)) ??
              snapshot.windowsByInstance.get(entry.providerInstanceId) ??
              [],
          );
    let answered = false;
    for (const windows of windowLists) {
      const matching = windows.filter((candidate) => candidate.kind === condition.windowKind);
      if (matching.length === 0) continue;
      answered = true;
      for (const window of matching) {
        if (!windowIsCurrent(window, nowMs)) continue;
        if (window.usedPercent < condition.atPercent) continue;
        return {
          known: true,
          breach: {
            reason: `${window.label} usage ${Math.round(window.usedPercent)}% reached ${condition.atPercent}% cap.`,
          },
        };
      }
    }
    if (!answered) known = false;
  }

  return { breach: null, known };
}

/** Keeps the sweep from rewriting the same hit every scheduler tick. */
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
