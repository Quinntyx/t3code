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
  threadRunDurationMs,
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
      status: "completed",
      startedAt: at(turn.from),
      completedAt: at(turn.to),
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
    const { turns } = threadUsageTurns(
      "main",
      records("main", claude, "claude-opus-5-5", [
        { from: 0, to: 1, usage: usage(1_000, 100, 800) },
        { from: 1, to: 2, usage: usage(5_000, 500), runThreadId: "source" },
        { from: 2, to: 3, usage: { ...usage(0, 0), usageStatus: "unavailable" } },
        { from: 3, to: 4, usage: { ...usage(5_000, 500), localCommand: true } },
        {
          from: 4,
          to: 5,
          usage: {
            ...usage(1_000, 100, 800),
            cacheCreationTokens: 400,
            reasoningTokens: 150,
          },
        },
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
      {
        uncachedInputTokens: 0,
        cachedInputTokens: 800,
        cacheCreationTokens: 200,
        outputTokens: 100,
        reasoningTokens: 100,
      },
    ]);
  });

  it("uses a reported model rather than pricing an automatic selection literally", () => {
    const { turns } = threadUsageTurns(
      "main",
      records("main", claude, "opus", [
        { from: 0, to: 1, usage: { ...usage(1_000, 100), models: ["claude-opus-5-5"] } },
      ]),
      T0,
    );
    const result = buildThreadUsage({
      turns,
      compactedAtMs: [],
      pricing,
      nowMs: T0,
      active: false,
    });
    expect(result.models[0]?.model).toBe("claude-opus-5-5");
    expect(result.models[0]?.costUsd).toBeCloseTo(0.015);
    const saved = records("main", claude, "opus", [{ from: 0, to: 1, usage: usage(1_000, 100) }]);
    expect(
      threadUsageTurns(
        "main",
        {
          ...saved,
          providerTurns: saved.providerTurns.map((turn) => ({
            ...turn,
            model: "claude-opus-5-5",
          })),
        },
        T0,
      ).turns[0]?.model,
    ).toBe("claude-opus-5-5");
    expect(
      buildThreadUsage({
        turns,
        compactedAtMs: [],
        pricing: {
          ...pricing,
          modelAliases: new Map([["claude-opus-5-5", "account-price"]]),
          overrides: createOverrideRateTable({
            "account-price": { inputCostPerMillionTokens: 20, outputCostPerMillionTokens: 100 },
          }),
        },
        nowMs: T0,
        active: false,
      }).models[0]?.costUsd,
    ).toBeCloseTo(0.03);
  });

  it.each(
    (["main", "delegates"] as const).flatMap((group) =>
      [false, true].map((mixed) => ({ group, mixed })),
    ),
  )(
    "includes native workflow usage for $group with mixed main models=$mixed without double counting",
    ({ group, mixed }) => {
      const nativeUsage = {
        model: "claude-haiku-4-5",
        inputTokens: 150,
        cachedInputTokens: 40,
        cacheCreationTokens: 10,
        outputTokens: 20,
        reasoningTokens: 5,
      };
      const { turns, incompleteGroups } = threadUsageTurns(
        group,
        records("main", claude, "claude-opus-5-5", [
          {
            from: 0,
            to: 1,
            usage: {
              ...usage(1_000, 100),
              subagentUsage: [nativeUsage],
              ...(mixed
                ? {
                    mainAgentUsage: [
                      {
                        model: "claude-opus-5-5",
                        inputTokens: 800,
                        outputTokens: 80,
                        cachedInputTokens: 0,
                        cacheCreationTokens: 0,
                      },
                      {
                        model: "claude-sonnet-4-6",
                        inputTokens: 200,
                        outputTokens: 20,
                        cachedInputTokens: 0,
                        cacheCreationTokens: 0,
                      },
                    ],
                  }
                : {}),
            },
          },
          { from: 1, to: 2, usage: { ...usage(0, 0), subagentUsage: [nativeUsage] } },
          {
            from: 2,
            to: 3,
            usage: {
              ...usage(0, 0),
              localCommand: true,
              subagentUsage: [nativeUsage],
              otherUsageStatus: "partial",
            },
          },
        ]),
        T0,
      );
      expect(turns.map(({ group, model, totals }) => ({ group, model, totals }))).toEqual([
        {
          group,
          model: "claude-opus-5-5",
          totals: {
            uncachedInputTokens: mixed ? 800 : 1_000,
            cachedInputTokens: 0,
            cacheCreationTokens: 0,
            outputTokens: mixed ? 80 : 100,
            reasoningTokens: 0,
          },
        },
        ...(mixed
          ? [
              {
                group,
                model: "claude-sonnet-4-6",
                totals: {
                  uncachedInputTokens: 200,
                  cachedInputTokens: 0,
                  cacheCreationTokens: 0,
                  outputTokens: 20,
                  reasoningTokens: 0,
                },
              },
            ]
          : []),
        ...Array.from({ length: 2 }, () => ({
          group: "delegates",
          model: "claude-haiku-4-5",
          totals: {
            uncachedInputTokens: 100,
            cachedInputTokens: 40,
            cacheCreationTokens: 10,
            outputTokens: 20,
            reasoningTokens: 5,
          },
        })),
      ]);
      const report = buildThreadUsage({
        turns,
        incompleteGroups,
        compactedAtMs: [],
        pricing,
        nowMs: T0,
        active: false,
      });
      expect(report.models.map(({ model, totalTokens }) => ({ model, totalTokens }))).toEqual([
        { model: "claude-opus-5-5", totalTokens: mixed ? 880 : 1_100 },
        ...(mixed ? [{ model: "claude-sonnet-4-6", totalTokens: 220 }] : []),
        { model: "claude-haiku-4-5", totalTokens: 340 },
      ]);
      expect(report.incompleteGroups).toBeUndefined();
    },
  );

  it("sums own run durations without quota gaps, inherited runs, or a usage requirement", () => {
    const main = records("main", claude, "claude-opus-5-5", [
      { from: 0, to: 15, usage: usage(1_000, 100) },
      { from: 195, to: 322, usage: { ...usage(0, 0), usageStatus: "unavailable" } },
      { from: 0, to: 300, usage: usage(1_000, 100), runThreadId: "source" },
    ]);
    expect(threadRunDurationMs(main, T0 + 600 * MINUTE)).toBe(142 * MINUTE);
    expect(
      threadRunDurationMs(
        {
          ...main,
          runs: [
            main.runs[0]!,
            { ...main.runs[1]!, status: "running", completedAt: null },
            { ...main.runs[2]!, threadId: main.thread.id, startedAt: null, completedAt: null },
            { ...main.runs[2]!, threadId: main.thread.id, status: "failed", completedAt: null },
          ],
        },
        T0 + 200 * MINUTE,
      ),
    ).toBe(20 * MINUTE);
  });

  it("splits a turn's tokens across the buckets it ran in and prices each group", () => {
    const main = threadUsageTurns(
      "main",
      records("main", claude, "claude-opus-5-5", [
        { from: 0, to: 20, usage: usage(150_000, 50_000) },
        { from: 40, to: 40, usage: usage(10_000, 0) },
        // Nothing measured, yet native work it could not measure still makes delegates a floor.
        { from: 40, to: 40, usage: { ...usage(0, 0), otherUsageStatus: "partial" } },
      ]),
      T0,
    );
    const delegates = [
      ...threadUsageTurns(
        "delegates",
        records("child-a", codex, "gpt-5.5", [{ from: 5, to: 15, usage: usage(80_000, 20_000) }]),
        T0,
      ).turns,
      ...threadUsageTurns(
        "delegates",
        records("child-b", codex, "gpt-5.5", [{ from: 10, to: 15, usage: usage(30_000, 0) }]),
        T0,
      ).turns,
    ];
    const result = buildThreadUsage({
      turns: [...main.turns, ...delegates],
      incompleteGroups: main.incompleteGroups,
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
    expect(result.incompleteGroups).toEqual(["delegates"]);

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
      ).turns,
      compactedAtMs: [],
      pricing,
      nowMs: T0 + 3 * 60 * MINUTE,
      active: true,
    });
    expect(result.bucketMs).toBe(5 * MINUTE);
    expect(result.series[0]?.buckets).toHaveLength(37);
  });
});
