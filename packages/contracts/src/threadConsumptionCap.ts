import * as Schema from "effect/Schema";

import { IsoDateTime, RunId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/**
 * API mode prices the thread's turns with the usage rate table. Quota mode watches
 * a provider-reported usage window, such as the 5-hour session or the week.
 */
export const ThreadConsumptionCapMode = Schema.Literals(["api", "quota"]);
export type ThreadConsumptionCapMode = typeof ThreadConsumptionCapMode.Type;

export const ThreadConsumptionCapWindowKind = Schema.Literals([
  "session",
  "weekly",
  "monthly",
  "other",
]);
export type ThreadConsumptionCapWindowKind = typeof ThreadConsumptionCapWindowKind.Type;

/**
 * One model's share of the thread cap. A rule is active in the mode it carries:
 * API rules use `limitUsd`, quota rules use `windowId`/`windowKind`/`atPercent`.
 * `driver` and `windowLabel` are display hints, so a removed account or a reset
 * window still renders where the rule was configured.
 */
export const ThreadConsumptionCapRule = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  model: TrimmedNonEmptyString,
  limitUsd: Schema.optional(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))),
  windowId: Schema.optional(TrimmedNonEmptyString),
  windowKind: Schema.optional(ThreadConsumptionCapWindowKind),
  windowLabel: Schema.optional(TrimmedNonEmptyString),
  atPercent: Schema.optional(
    Schema.Number.check(Schema.isFinite(), Schema.isBetween({ minimum: 1, maximum: 100 })),
  ),
});
export type ThreadConsumptionCapRule = typeof ThreadConsumptionCapRule.Type;

export const ThreadConsumptionCap = Schema.Struct({
  mode: ThreadConsumptionCapMode,
  /** API mode: the whole thread's spend, across models and delegates. */
  totalLimitUsd: Schema.optional(Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0))),
  rules: Schema.Array(ThreadConsumptionCapRule).check(Schema.isMaxLength(100)),
});
export type ThreadConsumptionCap = typeof ThreadConsumptionCap.Type;

/** Written by the consumption-cap sweep; removing or loosening the cap clears it. */
export const ThreadConsumptionCapHit = Schema.Struct({
  at: IsoDateTime,
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  runId: Schema.optional(RunId),
});
export type ThreadConsumptionCapHit = typeof ThreadConsumptionCapHit.Type;

function ruleKey(rule: ThreadConsumptionCapRule): string {
  return `${rule.providerInstanceId}\u0000${rule.model}`;
}

function rulesByKey(rules: ReadonlyArray<ThreadConsumptionCapRule>) {
  return new Map(rules.map((rule) => [ruleKey(rule), rule]));
}

/**
 * True only when every previous limit still exists and was raised, or a rule
 * was removed. The cap hit stays when the comparison is ambiguous.
 */
export function consumptionCapIsMorePermissive(
  next: ThreadConsumptionCap | null,
  previous: ThreadConsumptionCap | null,
): boolean {
  if (next === null) return true;
  if (previous === null || next.mode !== previous.mode) return false;

  let increased = false;
  const nextRules = rulesByKey(next.rules);
  const previousRules = rulesByKey(previous.rules);

  if (next.mode === "api") {
    if (previous.totalLimitUsd !== undefined) {
      if (next.totalLimitUsd === undefined) increased = true;
      else if (next.totalLimitUsd < previous.totalLimitUsd) return false;
      else if (next.totalLimitUsd > previous.totalLimitUsd) increased = true;
    } else if (next.totalLimitUsd !== undefined) {
      return false;
    }

    for (const [key, previousRule] of previousRules) {
      if (previousRule.limitUsd === undefined) continue;
      const nextRule = nextRules.get(key);
      if (nextRule === undefined || nextRule.limitUsd === undefined) {
        increased = true;
        continue;
      }
      if (nextRule.limitUsd < previousRule.limitUsd) return false;
      if (nextRule.limitUsd > previousRule.limitUsd) increased = true;
    }
    for (const [key, nextRule] of nextRules) {
      if (nextRule.limitUsd === undefined) continue;
      if (previousRules.get(key)?.limitUsd === undefined) return false;
    }
    return increased;
  }

  for (const [key, previousRule] of previousRules) {
    if (previousRule.atPercent === undefined) continue;
    const nextRule = nextRules.get(key);
    if (nextRule === undefined || nextRule.atPercent === undefined) {
      increased = true;
      continue;
    }
    if (
      nextRule.windowId !== previousRule.windowId ||
      nextRule.windowKind !== previousRule.windowKind
    ) {
      return false;
    }
    if (nextRule.atPercent < previousRule.atPercent) return false;
    if (nextRule.atPercent > previousRule.atPercent) increased = true;
  }
  for (const [key, nextRule] of nextRules) {
    if (nextRule.atPercent === undefined) continue;
    if (previousRules.get(key)?.atPercent === undefined) return false;
  }
  return increased;
}
