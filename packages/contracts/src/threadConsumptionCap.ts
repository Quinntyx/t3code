import * as Schema from "effect/Schema";

import { IsoDateTime, RunId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";

/** Quota conditions watch one provider-reported window kind, such as the 5-hour session. */
export const ThreadConsumptionCapWindowKind = Schema.Literals([
  "session",
  "weekly",
  "monthly",
  "other",
]);
export type ThreadConsumptionCapWindowKind = typeof ThreadConsumptionCapWindowKind.Type;

/** One model a condition applies to. `driver` is a display hint, so a removed account still renders. */
export const ThreadConsumptionCapModel = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  model: TrimmedNonEmptyString,
});
export type ThreadConsumptionCapModel = typeof ThreadConsumptionCapModel.Type;

const conditionFields = {
  /** Absent applies the condition to every model the thread runs. */
  models: Schema.optional(
    Schema.Array(ThreadConsumptionCapModel).check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  ),
};

/**
 * One reason to stop a thread. A cap holds any number of conditions and the
 * thread stops when any one of them is met.
 */
export const ThreadConsumptionCapCondition = Schema.Union([
  Schema.Struct({
    ...conditionFields,
    kind: Schema.Literal("spend"),
    limitUsd: Schema.Number.check(Schema.isFinite(), Schema.isGreaterThan(0)),
  }),
  Schema.Struct({
    ...conditionFields,
    kind: Schema.Literal("quota"),
    atPercent: Schema.Number.check(
      Schema.isFinite(),
      Schema.isBetween({ minimum: 1, maximum: 100 }),
    ),
    windowKind: ThreadConsumptionCapWindowKind,
    windowLabel: Schema.optional(TrimmedNonEmptyString),
  }),
]);
export type ThreadConsumptionCapCondition = typeof ThreadConsumptionCapCondition.Type;

export const ThreadConsumptionCap = Schema.Struct({
  conditions: Schema.Array(ThreadConsumptionCapCondition).check(Schema.isMaxLength(100)),
});
export type ThreadConsumptionCap = typeof ThreadConsumptionCap.Type;

/** Written by the consumption-cap sweep; removing the cap clears it. */
export const ThreadConsumptionCapHit = Schema.Struct({
  at: IsoDateTime,
  reason: TrimmedNonEmptyString.check(Schema.isMaxLength(512)),
  runId: Schema.optional(RunId),
});
export type ThreadConsumptionCapHit = typeof ThreadConsumptionCapHit.Type;
