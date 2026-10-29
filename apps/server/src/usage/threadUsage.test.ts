import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2AppThreadLineage,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  buildThreadUsage,
  delegateThreadIds,
  threadUsageTurns,
  type ThreadUsageRecords,
} from "./threadUsage.ts";
import { createOverrideRateTable } from "./usagePricing.ts";

const MINUTE = 60_000;
const T0 = Date.parse("2026-10-29T14:00:00.000Z");
const at = (minutes: number) => DateTime.makeUnsafe(T0 + minutes * MINUTE);
const claude = ProviderInstanceId.make("claudeAgent");
const codex = ProviderInstanceId.make("codex");

const lineage = (
  parent: string | null,
  relationshipToParent: OrchestrationV2AppThreadLineage["relationshipToParent"] = "subagent",
): OrchestrationV2AppThreadLineage => ({
  parentThreadId: parent === null ? null : ThreadId.make(parent),
  relationshipToParent: parent === null ? null : relationshipToParent,
  rootThreadId: ThreadId.make("root"),
});

const usage = (input: number, output: number, cached = 0): TurnTokenUsage => ({
  usageScope: "main_agent",
  usageStatus: "complete",
  hasSubagents: false,
  inputTokens: input,
  cachedInputTokens: cached,
  outputTokens: output,
});

function records(
  threadId: string,
  instanceId: ProviderInstanceId,
  model: string,
  turns: ReadonlyArray<{
    readonly from: number;
    readonly to: number;
    readonly usage: TurnTokenUsage;
    readonly runThreadId?: string;
  }>,
): ThreadUsageRecords {
  const providerThreadId = ProviderThreadId.make(`${threadId}:provider`);
  return {
    thread: { id: ThreadId.make(threadId) },
    runs: turns.map((turn, index) => ({
      id: RunId.make(`${threadId}:run:${index}`),
      threadId: ThreadId.make(turn.runThreadId ?? threadId),
      modelSelection: { instanceId, model },
    })),
    attempts: turns.map((_, index) => ({
      id: RunAttemptId.make(`${threadId}:attempt:${index}`),
      runId: RunId.make(`${threadId}:run:${index}`),
      providerInstanceId: instanceId,
    })),
    providerThreads: [
      { id: providerThreadId, driver: ProviderDriverKind.make(String(instanceId)) },
    ],
    providerTurns: turns.map((turn, index) => ({
      providerThreadId,
      runAttemptId: RunAttemptId.make(`${threadId}:attempt:${index}`),
      startedAt: at(turn.from),
      completedAt: at(turn.to),
      turnTokenUsage: turn.usage,
    })),
  };
}

const pricing = {
  rates: createOverrideRateTable({
    "claude-opus-5-5": { inputCostPerMillionTokens: 10, outputCostPerMillionTokens: 50 },
  }),
  overrides: new Map(),
  modelAliases: new Map(),
};

describe("thread usage", () => {
  it("counts subagents at any depth as delegates but leaves forks out", () => {
    expect(
      delegateThreadIds(ThreadId.make("main"), [
        { id: ThreadId.make("main"), lineage: lineage(null) },
        { id: ThreadId.make("child"), lineage: lineage("main") },
        { id: ThreadId.make("grandchild"), lineage: lineage("child") },
        { id: ThreadId.make("fork"), lineage: lineage("main", "fork") },
        { id: ThreadId.make("fork-child"), lineage: lineage("fork") },
      ]),
    ).toEqual([ThreadId.make("child"), ThreadId.make("grandchild")]);
  });

  it("reads input net of cache and skips turns another thread ran", () => {
    const turns = threadUsageTurns(
      "main",
      records("main", claude, "claude-opus-5-5", [
        { from: 0, to: 1, usage: usage(1_000, 100, 800) },
        { from: 1, to: 2, usage: usage(5_000, 500), runThreadId: "source" },
        { from: 2, to: 3, usage: { ...usage(0, 0), usageStatus: "unavailable" } },
      ]),
      T0,
    );
    expect(turns.map((turn) => turn.totals)).toEqual([
      {
        uncachedInputTokens: 200,
        cachedInputTokens: 800,
        cacheCreationTokens: 0,
        outputTokens: 100,
        reasoningTokens: 0,
      },
    ]);
  });

  it("splits a turn's tokens across the buckets it ran in and prices each group", () => {
    const main = threadUsageTurns(
      "main",
      records("main", claude, "claude-opus-5-5", [
        { from: 0, to: 20, usage: usage(150_000, 50_000) },
        { from: 40, to: 40, usage: usage(10_000, 0) },
      ]),
      T0,
    );
    const delegates = [
      ...threadUsageTurns(
        "delegates",
        records("child-a", codex, "gpt-5.5", [{ from: 5, to: 15, usage: usage(80_000, 20_000) }]),
        T0,
      ),
      ...threadUsageTurns(
        "delegates",
        records("child-b", codex, "gpt-5.5", [{ from: 10, to: 15, usage: usage(30_000, 0) }]),
        T0,
      ),
    ];
    const result = buildThreadUsage({
      turns: [...main, ...delegates],
      compactedAtMs: [T0 + 30 * MINUTE],
      pricing,
      nowMs: T0 + 60 * MINUTE,
      active: false,
    });

    expect(result.startedAt).toBe("2026-10-29T14:00:00.000Z");
    expect(result.bucketMs).toBe(MINUTE);
    expect(result.compactedAt).toEqual(["2026-10-29T14:30:00.000Z"]);
    expect(
      result.models.map(({ group, model, threads, totalTokens, costUsd }) => ({
        group,
        model,
        threads,
        totalTokens,
        costUsd: costUsd === null ? null : Math.round(costUsd * 100) / 100,
      })),
    ).toEqual([
      { group: "main", model: "claude-opus-5-5", threads: 1, totalTokens: 210_000, costUsd: 4.1 },
      { group: "delegates", model: "gpt-5.5", threads: 2, totalTokens: 130_000, costUsd: null },
    ]);

    const [opus, gpt] = result.series;
    expect(opus?.buckets).toHaveLength(41);
    expect(opus?.buckets.slice(0, 20)).toEqual(Array.from({ length: 20 }, () => 10_000));
    expect(opus?.buckets[40]).toBe(10_000);
    // Both delegates ran gpt-5.5 at once, so their tokens share one line.
    expect(gpt?.buckets.slice(5, 15)).toEqual([
      ...Array.from({ length: 5 }, () => 10_000),
      ...Array.from({ length: 5 }, () => 16_000),
    ]);
  });

  it("runs the window to now while a turn is still going", () => {
    const result = buildThreadUsage({
      turns: threadUsageTurns(
        "main",
        records("main", claude, "claude-opus-5-5", [{ from: 0, to: 10, usage: usage(1_000, 0) }]),
        T0,
      ),
      compactedAtMs: [],
      pricing,
      nowMs: T0 + 3 * 60 * MINUTE,
      active: true,
    });
    expect(result.bucketMs).toBe(5 * MINUTE);
    expect(result.series[0]?.buckets).toHaveLength(37);
  });
});
