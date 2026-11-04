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

/** Written by the consumption-cap sweep; changing the cap clears it. */
export const ThreadConsumptionCapHit = Schema.Struct({
  at: IsoDateTime,
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  runId: Schema.optional(RunId),
});
export type ThreadConsumptionCapHit = typeof ThreadConsumptionCapHit.Type;
