import * as Schema from "effect/Schema";

import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { UsageLimitSourceId } from "./usageLimitSourceId.ts";

/** Money in major units of one lowercase ISO 4217 currency, such as `usd` or `eur`. */
export const ServerProviderUsageAmount = Schema.Struct({
  currency: TrimmedNonEmptyString,
  used: Schema.optional(Schema.Number),
  limit: Schema.optional(Schema.Number),
  remaining: Schema.optional(Schema.Number),
});
export type ServerProviderUsageAmount = typeof ServerProviderUsageAmount.Type;

/** Money the provider reports without an allowance, so it is a line rather than a bar. */
export const ServerProviderUsageAmountLine = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  amount: ServerProviderUsageAmount,
  resetsAt: Schema.optional(IsoDateTime),
});
export type ServerProviderUsageAmountLine = typeof ServerProviderUsageAmountLine.Type;

/** Stable per-provider ids let sparse updates merge with full probes. */
export const ServerProviderUsageWindow = Schema.Struct({
  id: TrimmedNonEmptyString,
  kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
  label: TrimmedNonEmptyString,
  /** When present, this limit applies only to these provider model IDs. */
  modelIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  providerIds: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  usedPercent: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(NonNegativeInt),
  amount: Schema.optional(ServerProviderUsageAmount),
});
export type ServerProviderUsageWindow = typeof ServerProviderUsageWindow.Type;

/** One kind of banked reset, such as Claude's weekly reset or its Fable-only reset. */
export const ServerProviderResetCreditOption = Schema.Struct({
  creditId: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  availableCount: NonNegativeInt,
  expiresAt: Schema.optional(IsoDateTime),
});
export type ServerProviderResetCreditOption = typeof ServerProviderResetCreditOption.Type;

export const ServerProviderResetCredits = Schema.Struct({
  availableCount: NonNegativeInt,
  nextExpiresAt: Schema.optional(IsoDateTime),
  /** Pins hub redemption to the displayed credit, including retries from another client. */
  nextCreditId: Schema.optional(TrimmedNonEmptyString),
  /** Present when resets differ in what they refill; redeem one by its `creditId`. */
  options: Schema.optional(ForwardCompatibleArray(ServerProviderResetCreditOption)),
});
export type ServerProviderResetCredits = typeof ServerProviderResetCredits.Type;

/** Clear bars for unavailable accounts; retain last good bars after a failed probe. */
export const ServerProviderUsageLimits = Schema.Struct({
  checkedAt: IsoDateTime,
  windows: ForwardCompatibleArray(ServerProviderUsageWindow),
  amounts: Schema.optional(ForwardCompatibleArray(ServerProviderUsageAmountLine)),
  /** A $0 monthly spend cap has no percentage, so it cannot be a window. */
  zeroSpendCap: Schema.optional(Schema.Boolean),
  credentialFingerprint: Schema.optional(TrimmedNonEmptyString),
  /** The provider whose login these limits read, when it is not the reporting provider. */
  ownerDriver: Schema.optional(ProviderDriverKind),
  resetCredits: Schema.optional(ServerProviderResetCredits),
  externalUsage: Schema.optional(
    Schema.Struct({
      label: TrimmedNonEmptyString,
      url: TrimmedNonEmptyString,
    }),
  ),
  unavailable: Schema.optional(
    Schema.Struct({
      reason: Schema.Literals(["unsupported", "probeFailed"]),
      message: Schema.optional(TrimmedNonEmptyString),
    }),
  ),
});
export type ServerProviderUsageLimits = typeof ServerProviderUsageLimits.Type;

/** Partial updates merge windows by id; omitted windows remain unchanged. */
export const ProviderUsageLimitsUpdate = Schema.Struct({
  windows: Schema.Array(ServerProviderUsageWindow),
});
export type ProviderUsageLimitsUpdate = typeof ProviderUsageLimitsUpdate.Type;

export const ServerProviderUsageRoute = Schema.Struct({
  driver: ProviderDriverKind,
  origin: TrimmedNonEmptyString,
});
export type ServerProviderUsageRoute = typeof ServerProviderUsageRoute.Type;

/** A quota the provider reads from one of its own logins, beside its primary limits. */
export const ServerProviderUsageSource = Schema.Struct({
  id: TrimmedNonEmptyString,
  label: TrimmedNonEmptyString,
  driver: ProviderDriverKind,
  email: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  limits: ServerProviderUsageLimits,
});
export type ServerProviderUsageSource = typeof ServerProviderUsageSource.Type;

export const UsageLimitSourceAccount = Schema.Struct({
  id: TrimmedNonEmptyString,
  /** A hub provider's own id when no T3 driver reads it, e.g. `mistral`. */
  driver: ProviderDriverKind,
  email: Schema.optional(TrimmedNonEmptyString),
  /** Hub display name for an account without an e-mail. */
  label: Schema.optional(TrimmedNonEmptyString),
  plan: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  usageLimits: ServerProviderUsageLimits,
});
export type UsageLimitSourceAccount = typeof UsageLimitSourceAccount.Type;

export const UsageLimitSourceSnapshot = Schema.Struct({
  id: UsageLimitSourceId,
  kind: Schema.Literal("cliproxy"),
  label: TrimmedNonEmptyString,
  /** Origin of the hub, which also serves the agents sent through it. */
  origin: Schema.optional(TrimmedNonEmptyString),
  /** Origin and base path of the hub, which tell apart hubs served from one origin. */
  endpoint: Schema.optional(TrimmedNonEmptyString),
  checkedAt: IsoDateTime,
  accounts: ForwardCompatibleArray(UsageLimitSourceAccount),
  error: Schema.optional(TrimmedNonEmptyString),
});
export type UsageLimitSourceSnapshot = typeof UsageLimitSourceSnapshot.Type;

export const UsageLimitSourceSnapshots = ForwardCompatibleArray(UsageLimitSourceSnapshot);
export type UsageLimitSourceSnapshots = typeof UsageLimitSourceSnapshots.Type;

export const UsageLimitSourceConsumeResetCreditInput = Schema.Struct({
  sourceId: UsageLimitSourceId,
  accountId: TrimmedNonEmptyString,
  creditId: TrimmedNonEmptyString,
});
export type UsageLimitSourceConsumeResetCreditInput =
  typeof UsageLimitSourceConsumeResetCreditInput.Type;

export const ProviderConsumeResetCreditInput = Schema.Union([
  Schema.Struct({
    instanceId: ProviderInstanceId,
    creditId: Schema.optional(TrimmedNonEmptyString),
  }),
  UsageLimitSourceConsumeResetCreditInput,
]);
export type ProviderConsumeResetCreditInput = typeof ProviderConsumeResetCreditInput.Type;

export class UsageLimitSourceError extends Schema.TaggedError<UsageLimitSourceError>()(
  "UsageLimitSourceError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

export const ProviderConsumeResetCreditOutcome = Schema.Literals([
  "reset",
  "nothingToReset",
  "noCredit",
  "alreadyRedeemed",
]);
export type ProviderConsumeResetCreditOutcome = typeof ProviderConsumeResetCreditOutcome.Type;

export const ProviderConsumeResetCreditResult = Schema.Struct({
  outcome: ProviderConsumeResetCreditOutcome,
  warning: Schema.optional(TrimmedNonEmptyString),
});
export type ProviderConsumeResetCreditResult = typeof ProviderConsumeResetCreditResult.Type;

export const UsageLimitsReport = Schema.Struct({
  createdAt: IsoDateTime,
  accounts: Schema.Array(
    Schema.Struct({
      id: TrimmedNonEmptyString,
      driver: ProviderDriverKind,
      label: TrimmedNonEmptyString,
      plan: Schema.optional(TrimmedNonEmptyString),
      email: Schema.optional(TrimmedNonEmptyString),
      sourceLabel: Schema.optional(TrimmedNonEmptyString),
      instanceId: Schema.optional(ProviderInstanceId),
      resetCreditInput: Schema.optional(ProviderConsumeResetCreditInput),
      displayName: Schema.optional(Schema.String),
      accentColor: Schema.optional(Schema.String),
      limits: ServerProviderUsageLimits,
    }),
  ),
  notices: Schema.Array(Schema.String),
});
export type UsageLimitsReport = typeof UsageLimitsReport.Type;
