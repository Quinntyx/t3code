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

    const instanceIds =
      scope === undefined
        ? [...snapshot.windowsByInstance.keys()]
        : [...new Set((condition.models ?? []).map((entry) => entry.providerInstanceId as string))];
    let answered = false;
    for (const instanceId of instanceIds) {
      const window = (snapshot.windowsByInstance.get(instanceId) ?? []).find(
        (candidate) => candidate.kind === condition.windowKind,
      );
      if (window === undefined) continue;
      answered = true;
      if (!windowIsCurrent(window, nowMs)) continue;
      if (window.usedPercent < condition.atPercent) continue;
      return {
        known: true,
        breach: {
          reason: `${window.label} usage ${Math.round(window.usedPercent)}% reached ${condition.atPercent}% cap.`,
        },
      };
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
