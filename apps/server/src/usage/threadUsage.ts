import type {
  ModelSelection,
  OrchestrationV2AppThread,
  OrchestrationV2ProviderThread,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Run,
  OrchestrationV2RunAttempt,
  OrchestrationV2ThreadShell,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  ThreadUsage,
  ThreadUsageGroup,
  ThreadUsageModel,
  UsageTokenTotals,
} from "@t3tools/contracts";
import { EMPTY_TOTALS, type UsageSpeed } from "@t3tools/provider-core/server/usage";
import {
  getModelSelectionBooleanOptionValue,
  getModelSelectionStringOptionValue,
} from "@t3tools/shared/model";
import * as DateTime from "effect/DateTime";

import { priceUsage, type RateTable } from "./usagePricing.ts";

const MINUTE_MS = 60_000;
const BUCKET_STEPS_MS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1_440, 2_880, 10_080].map(
  (minutes) => minutes * MINUTE_MS,
);
const MAX_BUCKETS = 48;

export interface ThreadUsageTurn {
  readonly group: ThreadUsageGroup;
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver: ProviderDriverKind;
  readonly model: string;
  readonly speed: UsageSpeed;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly totals: UsageTokenTotals;
}

export interface ThreadUsagePricing {
  readonly rates: RateTable;
  readonly overrides: RateTable;
  readonly modelAliases: ReadonlyMap<string, string>;
}

export interface ThreadUsageRecords {
  readonly thread: Pick<OrchestrationV2AppThread, "id">;
  readonly runs: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "threadId" | "modelSelection">>;
  readonly attempts: ReadonlyArray<
    Pick<OrchestrationV2RunAttempt, "id" | "runId" | "providerInstanceId">
  >;
  readonly providerThreads: ReadonlyArray<Pick<OrchestrationV2ProviderThread, "id" | "driver">>;
  readonly providerTurns: ReadonlyArray<
    Pick<
      OrchestrationV2ProviderTurn,
      "providerThreadId" | "runAttemptId" | "startedAt" | "completedAt" | "turnTokenUsage"
    >
  >;
}

function usageSpeed(selection: ModelSelection): UsageSpeed {
  if (getModelSelectionBooleanOptionValue(selection, "fastMode") === true) return "fast";
  const tier = getModelSelectionStringOptionValue(selection, "serviceTier");
  if (tier === "priority" || tier === "fast") return "fast";
  return tier === "ultrafast" ? "ultrafast" : "standard";
}

/** Subagent threads below `threadId`, at any depth. Forks are their own threads, not delegates. */
export function delegateThreadIds(
  threadId: ThreadId,
  family: ReadonlyArray<Pick<OrchestrationV2ThreadShell, "id" | "lineage">>,
): ReadonlyArray<ThreadId> {
  const children = new Map<ThreadId, ThreadId[]>();
  for (const thread of family) {
    const { parentThreadId, relationshipToParent } = thread.lineage;
    if (parentThreadId === null || relationshipToParent !== "subagent") continue;
    children.set(parentThreadId, [...(children.get(parentThreadId) ?? []), thread.id]);
  }
  const found: ThreadId[] = [];
  const pending = [...(children.get(threadId) ?? [])];
  for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
    if (next === threadId || found.includes(next)) continue;
    found.push(next);
    pending.push(...(children.get(next) ?? []));
  }
  return found;
}

/** Turns the provider reported usage for. A fork's inherited turns belong to its source's runs. */
export function threadUsageTurns(
  group: ThreadUsageGroup,
  records: ThreadUsageRecords,
  nowMs: number,
): ReadonlyArray<ThreadUsageTurn> {
  const runs = new Map(records.runs.map((run) => [run.id, run]));
  const attempts = new Map(records.attempts.map((attempt) => [attempt.id, attempt]));
  const drivers = new Map(records.providerThreads.map((thread) => [thread.id, thread.driver]));
  const turns: ThreadUsageTurn[] = [];
  for (const turn of records.providerTurns) {
    const usage = turn.turnTokenUsage;
    if (usage === undefined || usage.usageStatus === "unavailable") continue;
    const attempt = turn.runAttemptId === null ? undefined : attempts.get(turn.runAttemptId);
    const run = attempt === undefined ? undefined : runs.get(attempt.runId);
    const driver = drivers.get(turn.providerThreadId);
    if (attempt === undefined || run?.threadId !== records.thread.id || driver === undefined) {
      continue;
    }
    const input = usage.inputTokens ?? 0;
    const cachedInputTokens = usage.cachedInputTokens ?? 0;
    const cacheCreationTokens = usage.cacheCreationTokens ?? 0;
    const outputTokens = usage.outputTokens ?? 0;
    if (input + outputTokens === 0) continue;
    const completedAtMs =
      turn.completedAt === null ? nowMs : DateTime.toEpochMillis(turn.completedAt);
    turns.push({
      group,
      threadId: records.thread.id,
      providerInstanceId: attempt.providerInstanceId,
      driver,
      model: run.modelSelection.model,
      speed: usageSpeed(run.modelSelection),
      startedAtMs: turn.startedAt === null ? completedAtMs : DateTime.toEpochMillis(turn.startedAt),
      completedAtMs,
      totals: {
        uncachedInputTokens: Math.max(0, input - cachedInputTokens - cacheCreationTokens),
        cachedInputTokens,
        cacheCreationTokens,
        outputTokens,
        reasoningTokens: usage.reasoningTokens ?? 0,
      },
    });
  }
  return turns;
}

const totalTokens = (totals: UsageTokenTotals) =>
  totals.uncachedInputTokens +
  totals.cachedInputTokens +
  totals.cacheCreationTokens +
  totals.outputTokens;

const addTotals = (left: UsageTokenTotals, right: UsageTokenTotals): UsageTokenTotals => ({
  uncachedInputTokens: left.uncachedInputTokens + right.uncachedInputTokens,
  cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
  cacheCreationTokens: left.cacheCreationTokens + right.cacheCreationTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  reasoningTokens: left.reasoningTokens + right.reasoningTokens,
});

function bucketStep(spanMs: number): number {
  return (
    BUCKET_STEPS_MS.find((step) => Math.ceil(spanMs / step) <= MAX_BUCKETS) ??
    Math.ceil(spanMs / MAX_BUCKETS / MINUTE_MS) * MINUTE_MS
  );
}

/**
 * Spreads each turn's tokens over the wall-clock time it ran, so delegates working in parallel
 * show side by side. The window ends now while anything in it is running.
 */
export function buildThreadUsage(input: {
  readonly turns: ReadonlyArray<ThreadUsageTurn>;
  readonly compactedAtMs: ReadonlyArray<number>;
  readonly pricing: ThreadUsagePricing;
  readonly nowMs: number;
  readonly active: boolean;
}): ThreadUsage {
  const { turns, pricing } = input;
  const models = new Map<
    string,
    {
      readonly model: Omit<ThreadUsageModel, "threads" | "tokens" | "totalTokens" | "costUsd">;
      readonly threads: Set<ThreadId>;
      tokens: UsageTokenTotals;
      costUsd: number | null;
    }
  >();
  for (const turn of turns) {
    const key = [turn.group, turn.providerInstanceId, turn.model].join("\u0000");
    const entry = models.get(key) ?? {
      model: {
        group: turn.group,
        providerInstanceId: turn.providerInstanceId,
        driver: turn.driver,
        model: turn.model,
      },
      threads: new Set<ThreadId>(),
      tokens: { ...EMPTY_TOTALS },
      costUsd: null,
    };
    const priced = priceUsage(
      pricing.rates,
      {
        model: pricing.modelAliases.get(turn.model) ?? turn.model,
        totals: turn.totals,
        speed: turn.speed,
        reportedCostUsd: null,
      },
      pricing.overrides,
    );
    entry.threads.add(turn.threadId);
    entry.tokens = addTotals(entry.tokens, turn.totals);
    if (priced.costSource !== "unpriced") entry.costUsd = (entry.costUsd ?? 0) + priced.costUsd;
    models.set(key, entry);
  }

  const compactedAt = input.compactedAtMs.toSorted((a, b) => a - b);
  const starts = [...turns.map((turn) => turn.startedAtMs), ...compactedAt];
  if (turns.length === 0 || starts.length === 0) {
    return { startedAt: null, bucketMs: MINUTE_MS, models: [], series: [], compactedAt: [] };
  }
  const firstMs = Math.min(...starts);
  const lastMs = Math.max(
    ...turns.map((turn) => turn.completedAtMs),
    ...compactedAt,
    input.active ? input.nowMs : firstMs,
  );
  const bucketMs = bucketStep(Math.max(1, lastMs - firstMs));
  const startMs = Math.floor(firstMs / bucketMs) * bucketMs;
  const bucketCount = Math.max(2, Math.ceil((lastMs - startMs + 1) / bucketMs));
  const indexAt = (ms: number) =>
    Math.min(bucketCount - 1, Math.max(0, Math.floor((ms - startMs) / bucketMs)));

  const series = new Map<string, { readonly turn: ThreadUsageTurn; readonly buckets: number[] }>();
  for (const turn of turns) {
    const key = [turn.providerInstanceId, turn.model].join("\u0000");
    const entry = series.get(key) ?? {
      turn,
      buckets: Array.from({ length: bucketCount }, () => 0),
    };
    const tokens = totalTokens(turn.totals);
    const durationMs = turn.completedAtMs - turn.startedAtMs;
    if (durationMs <= 0) {
      entry.buckets[indexAt(turn.completedAtMs)]! += tokens;
    } else {
      for (let index = indexAt(turn.startedAtMs); index <= indexAt(turn.completedAtMs); index++) {
        const bucketStart = startMs + index * bucketMs;
        const overlapMs =
          Math.min(turn.completedAtMs, bucketStart + bucketMs) -
          Math.max(turn.startedAtMs, bucketStart);
        if (overlapMs > 0) entry.buckets[index]! += (tokens * overlapMs) / durationMs;
      }
    }
    series.set(key, entry);
  }

  return {
    startedAt: DateTime.formatIso(DateTime.makeUnsafe(startMs)),
    bucketMs,
    models: [...models.values()].map(({ model, threads, tokens, costUsd }) => ({
      ...model,
      threads: threads.size,
      tokens,
      totalTokens: totalTokens(tokens),
      costUsd,
    })),
    series: [...series.values()].map(({ turn, buckets }) => ({
      providerInstanceId: turn.providerInstanceId,
      driver: turn.driver,
      model: turn.model,
      buckets: buckets.map(Math.round),
    })),
    compactedAt: compactedAt.map((ms) => DateTime.formatIso(DateTime.makeUnsafe(ms))),
  };
}
