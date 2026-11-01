import {
  DeusObservation,
  DeusPonderReceipt,
  DeusSessionRef,
  DeusTranscript,
  DeusStateError,
  ModelSelection,
  ThreadId,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const PONDER_LIMITS = {
  observations: 32,
  observationBytes: 4096,
  snapshotBytes: 48_000,
  history: 16,
  entries: 16,
  resultBytes: 32_000,
  timeoutMs: 600_000,
} as const;
const text = (maximum: number) =>
  Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(maximum));
export const PromotionKind = Schema.Literals([
  "preference",
  "fact",
  "correction",
  "diagnosis",
  "proposal",
]);
export const PromotionEntry = Schema.Struct({
  kind: PromotionKind,
  scope: Schema.Literal("project"),
  text: text(4000),
  paths: Schema.Array(text(512)).check(Schema.isMaxLength(16)),
  evidence: Schema.Array(
    Schema.Struct({ observationId: DeusObservation.fields.id, quote: text(2048) }),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
});
export const PromotionResult = Schema.Struct({
  disposition: Schema.Literals(["promote", "no-change"]),
  reason: text(2000),
  consumedObservationIds: Schema.Array(DeusObservation.fields.id).check(
    Schema.isMaxLength(PONDER_LIMITS.observations),
  ),
  entries: Schema.Array(PromotionEntry).check(Schema.isMaxLength(PONDER_LIMITS.entries)),
});
export type PromotionResult = typeof PromotionResult.Type;
export const PonderRun = Schema.Struct({
  ...DeusSessionRef.fields,
  localDate: text(10),
  receipt: DeusPonderReceipt,
  model: Schema.NullOr(ModelSelection),
  attempt: Schema.Int.check(Schema.isGreaterThan(0)),
  threadId: ThreadId,
  observations: Schema.Array(DeusObservation),
  history: Schema.Array(DeusTranscript),
  omitted: Schema.Int,
  intent: Schema.NullOr(PromotionResult),
  commit: Schema.NullOr(Schema.String),
});
export type PonderRun = typeof PonderRun.Type;
export const ponderError = (message: string) => new DeusStateError({ reason: "conflict", message });
export const localDay = (
  epoch: number,
  timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone,
) => {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(epoch);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)!.value;
  return { date: `${part("year")}-${part("month")}-${part("day")}`, hour: Number(part("hour")) };
};
export function dailyPonderDue(before: number, now: number, timeZone?: string) {
  if (now <= before || now - before > 15_000) return false;
  const previous = localDay(before, timeZone);
  const current = localDay(now, timeZone);
  return previous.date === current.date && previous.hour < 4 && current.hour === 4;
}
export function validatePromotion(run: PonderRun, result: PromotionResult) {
  if (Buffer.byteLength(JSON.stringify(result)) > PONDER_LIMITS.resultBytes)
    throw ponderError("Learning result exceeds its bound.");
  const consumed = new Set(result.consumedObservationIds);
  const records = new Map(run.observations.map((item) => [item.id, item]));
  if (
    consumed.size === 0 ||
    consumed.size !== result.consumedObservationIds.length ||
    [...consumed].some((id) => !records.has(id))
  )
    throw ponderError("Learning must explicitly consume complete snapshot records.");
  if ((result.disposition === "promote") !== result.entries.length > 0)
    throw ponderError("Learning result is empty or has an invalid no-change disposition.");
  for (const entry of result.entries) {
    for (const path of entry.paths) {
      if (
        path.startsWith("/") ||
        path.includes("\\") ||
        path.includes("\0") ||
        path.split("/").some((part) => !part || part === "." || part === ".." || part === ".git")
      )
        throw ponderError("Learning memory paths must be safe project-relative paths.");
    }
    for (const evidence of entry.evidence) {
      const record = records.get(evidence.observationId);
      if (
        !record ||
        !consumed.has(record.id) ||
        !record.source ||
        !record.text.includes(evidence.quote)
      )
        throw ponderError("Learning evidence does not quote a consumed snapshot record.");
    }
  }
}
