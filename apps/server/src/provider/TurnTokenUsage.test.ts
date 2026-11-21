import { describe, expect, it } from "vite-plus/test";
import type { RuntimeTurnState, TurnModelTokenUsage } from "@t3tools/contracts";
import {
  claudeLedgerDelta,
  claudeModelLedger,
  claudeTurnTokenUsage,
  deductClaudeLedgerUsage,
  liveClaudeTurnTokenUsage,
  recordClaudeMessageUsage,
  sealClaudeSegment,
  type ClaudeModelLedger,
} from "./ClaudeTurnTokenUsage.ts";
import {
  accumulateCodexTurnTokenUsage,
  completeCodexTurnTokenUsage,
  getCodexTurnAccumulator,
  makeCodexTurnTokenUsageState,
} from "./CodexTurnTokenUsage.ts";

const breakdown = (input: number, cached: number, output: number) => ({
  totalTokens: input + output,
  inputTokens: input,
  cachedInputTokens: cached,
  outputTokens: output,
  reasoningOutputTokens: 0,
});
// A turn's ledger growth; without `previous` the CLI process started fresh.
const ledgerSince = (previous: unknown, current: unknown) =>
  claudeLedgerDelta(
    previous === undefined ? new Map() : claudeModelLedger(previous),
    claudeModelLedger(current),
  );
// Settles a turn whose earlier segments steers closed with `earlierSegmentUsage`.
const settleClaudeTurn = (
  result:
    | { readonly subtype: "success" | "error_during_execution"; readonly usage?: unknown }
    | undefined,
  hasSubagents: boolean,
  status: RuntimeTurnState,
  earlierSegmentUsage: ReadonlyArray<unknown> = [],
  observed: {
    readonly ledgerGrowth?: ClaudeModelLedger | undefined;
    readonly mainMessages?: ReadonlyMap<string, TurnModelTokenUsage>;
    readonly mainModel?: string;
  } = {},
) =>
  claudeTurnTokenUsage(
    [
      ...earlierSegmentUsage.map((usage) =>
        sealClaudeSegment({
          result: { subtype: "success", usage },
          ledgerGrowth: new Map(),
          mainMessages: new Map(),
          subagentMessages: new Map(),
        }),
      ),
      sealClaudeSegment({
        result,
        ledgerGrowth: "ledgerGrowth" in observed ? observed.ledgerGrowth : new Map(),
        mainMessages: observed.mainMessages ?? new Map(),
        subagentMessages: new Map(),
        ...(observed.mainModel === undefined ? {} : { mainModel: observed.mainModel }),
      }),
    ],
    { hasSubagents, status, rootModels: new Set() },
  );
const update = (total: ReturnType<typeof breakdown>, last = total) => ({
  total,
  last,
  modelContextWindow: 200_000,
});

describe("billable native turn usage", () => {
  it("adds each Codex response once and excludes the prior resumed history", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "turn";
    const first = update(breakdown(1010, 505, 102), breakdown(10, 5, 2));
    accumulateCodexTurnTokenUsage(state, "turn", first);
    accumulateCodexTurnTokenUsage(state, "turn", first);
    accumulateCodexTurnTokenUsage(
      state,
      "turn",
      update(breakdown(1030, 515, 108), breakdown(20, 10, 6)),
    );
    expect(completeCodexTurnTokenUsage(state, "turn", true)).toEqual({
      usageStatus: "complete",
      usageScope: "main_agent",
      hasSubagents: false,
      inputTokens: 30,
      cachedInputTokens: 15,
      outputTokens: 8,
      reasoningTokens: 0,
    });
  });

  it("keeps previous responses when compaction resets Codex cumulative counters", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "turn";
    accumulateCodexTurnTokenUsage(state, "turn", update(breakdown(100, 40, 20)));
    accumulateCodexTurnTokenUsage(state, "turn", update(breakdown(20, 5, 3)));
    getCodexTurnAccumulator(state, "turn").hasSubagents = true;
    expect(completeCodexTurnTokenUsage(state, "turn", false)).toMatchObject({
      usageStatus: "partial",
      hasSubagents: true,
      inputTokens: 120,
      cachedInputTokens: 45,
      outputTokens: 23,
    });
  });

  it("does not bill late Codex updates against the next active turn", () => {
    const state = makeCodexTurnTokenUsageState();
    state.activeTurnId = "next";
    accumulateCodexTurnTokenUsage(state, "previous", update(breakdown(100, 10, 20)));
    accumulateCodexTurnTokenUsage(
      state,
      "next",
      update(breakdown(104, 12, 21), breakdown(4, 2, 1)),
    );
    expect(completeCodexTurnTokenUsage(state, "next", true)).toMatchObject({
      inputTokens: 4,
      outputTokens: 1,
    });
    expect(completeCodexTurnTokenUsage(state, "missing", false).usageStatus).toBe("unavailable");
  });

  it("counts Claude cached input inside total input and bounds thinking output", () => {
    expect(
      settleClaudeTurn(
        {
          subtype: "success",
          usage: {
            input_tokens: 100,
            cache_read_input_tokens: 40,
            cache_creation_input_tokens: 10,
            output_tokens: 20,
            output_tokens_details: { thinking_tokens: 25 },
          },
        },
        true,
        "completed",
      ),
    ).toEqual({
      usageStatus: "complete",
      usageScope: "main_agent",
      hasSubagents: true,
      inputTokens: 150,
      cachedInputTokens: 40,
      cacheCreationTokens: 10,
      outputTokens: 20,
      reasoningTokens: 20,
    });
  });

  it.each([
    {
      previous: undefined,
      input: 150,
      output: 30,
      expected: { inputTokens: 50, outputTokens: 10 },
    },
    { previous: 150, input: 280, output: 55, expected: { inputTokens: 30, outputTokens: 5 } },
    // A ledger that went backwards, as after /clear, leaves the turn's growth unknown.
    { previous: 500, input: 120, output: 25, expected: undefined, otherUsageStatus: "partial" },
  ])("separates cumulative Claude model usage from the main loop: $previous", (row) => {
    const modelUsage = (inputTokens: number, outputTokens: number) => ({
      inputTokens,
      outputTokens,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0,
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      webSearchRequests: 0,
      canonicalModel: "claude-opus-5-5",
    });
    const current = settleClaudeTurn(
      { subtype: "success", usage: { input_tokens: 100, output_tokens: 20 } },
      false,
      "completed",
      [],
      {
        mainModel: "claude-opus-5-5",
        ledgerGrowth: ledgerSince(
          row.previous === undefined
            ? undefined
            : { "provider-opus": modelUsage(row.previous, row.previous === 150 ? 30 : 100) },
          { "provider-opus": modelUsage(row.input, row.output) },
        ),
      },
    );
    expect(current).toMatchObject({ inputTokens: 100, outputTokens: 20 });
    expect(current.otherUsageStatus).toBe(row.otherUsageStatus);
    expect(current.otherUsage).toEqual(row.expected);
    expect(current.subagentUsage).toEqual(
      row.expected && [
        { model: "claude-opus-5-5", ...row.expected, cachedInputTokens: 0, cacheCreationTokens: 0 },
      ],
    );
  });

  it("separates a shared delegate model after the main agent switches models", () => {
    const modelUsage = (inputTokens: number, outputTokens: number) => ({
      inputTokens,
      outputTokens,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      costUSD: 0,
      contextWindow: 200_000,
      maxOutputTokens: 32_000,
      webSearchRequests: 0,
    });
    const main = (model: string, inputTokens: number, outputTokens: number) => ({
      model,
      inputTokens,
      outputTokens,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    });
    const mainMessages = new Map([
      ["sonnet-response", main("claude-sonnet-4-6", 0, 0)],
      ["opus-response", main("claude-opus-5-5", 0, 0)],
    ]);
    recordClaudeMessageUsage(mainMessages, "sonnet-response", "claude-sonnet-4-6", {
      input_tokens: 100,
      output_tokens: 1,
    });
    recordClaudeMessageUsage(mainMessages, "sonnet-response", "claude-sonnet-4-6", {
      input_tokens: 100,
      output_tokens: 20,
    });
    recordClaudeMessageUsage(mainMessages, "sonnet-response", "claude-sonnet-4-6", {
      input_tokens: 0,
      output_tokens: 20,
    });
    recordClaudeMessageUsage(mainMessages, "opus-response", "claude-opus-5-5", {
      input_tokens: 20,
      output_tokens: 4,
    });
    recordClaudeMessageUsage(mainMessages, "notice", "<synthetic>", {
      input_tokens: 500,
      output_tokens: 100,
    });
    const current = settleClaudeTurn(
      { subtype: "success", usage: { input_tokens: 120, output_tokens: 24 } },
      true,
      "completed",
      [],
      {
        mainModel: "claude-opus-5-5",
        mainMessages,
        ledgerGrowth: ledgerSince(undefined, {
          "claude-sonnet-4-6": modelUsage(100, 20),
          "claude-opus-5-5": modelUsage(70, 14),
        }),
      },
    );
    expect(current.subagentUsage).toEqual([main("claude-opus-5-5", 50, 10)]);
    expect(current.mainAgentUsage).toEqual([
      main("claude-sonnet-4-6", 100, 20),
      main("claude-opus-5-5", 20, 4),
    ]);
  });

  it("includes workflow models, cache writes and thinking even without main-loop usage", () => {
    const result = settleClaudeTurn(
      { subtype: "error_during_execution", usage: { input_tokens: 0, output_tokens: 0 } },
      false,
      "failed",
      [],
      {
        ledgerGrowth: ledgerSince(undefined, {
          "claude-haiku-4-5": {
            inputTokens: 10,
            cacheReadInputTokens: 30,
            cacheCreationInputTokens: 20,
            outputTokens: 40,
            thinkingTokens: 50,
            costUSD: 0,
            contextWindow: 200_000,
            maxOutputTokens: 32_000,
            webSearchRequests: 0,
          },
        }),
      },
    );
    expect(result.usageStatus).toBe("partial");
    expect(result.subagentUsage).toEqual([
      {
        model: "claude-haiku-4-5",
        inputTokens: 60,
        cachedInputTokens: 30,
        cacheCreationTokens: 20,
        outputTokens: 40,
        reasoningTokens: 40,
      },
    ]);
  });

  it("does not turn a zeroed Claude crash result into a measured zero-cost turn", () => {
    expect(
      settleClaudeTurn(
        {
          subtype: "error_during_execution",
          usage: {
            input_tokens: 0,
            output_tokens: 0,
          },
        },
        false,
        "failed",
      ).usageStatus,
    ).toBe("unavailable");
    expect(
      settleClaudeTurn(
        {
          subtype: "success",
          usage: {
            input_tokens: 4,
            output_tokens: 2,
          },
        },
        false,
        "interrupted",
      ),
    ).toMatchObject({ usageStatus: "partial", inputTokens: 4, outputTokens: 2 });
  });

  it.each(["failed", "interrupted", "completed"] as const)(
    "retains measured Claude steering usage as partial after %s without final usage",
    (status) => {
      expect(
        settleClaudeTurn(
          status === "completed" ? { subtype: "success" } : undefined,
          true,
          status,
          [
            { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 20 },
            { input_tokens: 5, cache_read_input_tokens: 2, output_tokens: 3 },
          ],
        ),
      ).toEqual({
        usageStatus: "partial",
        usageScope: "main_agent",
        hasSubagents: true,
        inputTokens: 147,
        cachedInputTokens: 42,
        outputTokens: 23,
      });
    },
  );

  it.each([undefined, null, {}])(
    "keeps unavailable Claude usage unavailable without measured segments (%s)",
    (usage) => {
      expect(settleClaudeTurn({ subtype: "success", usage }, false, "completed").usageStatus).toBe(
        "unavailable",
      );
    },
  );

  it("retains measured thinking tokens without a final result", () => {
    expect(
      settleClaudeTurn(undefined, false, "failed", [
        { input_tokens: 4, output_tokens: 3, output_tokens_details: { thinking_tokens: 2 } },
      ]),
    ).toMatchObject({
      usageStatus: "partial",
      inputTokens: 4,
      outputTokens: 3,
      reasoningTokens: 2,
    });
  });

  it.each([undefined, null])(
    "retains earlier cache counts when a steering segment reports %s",
    (cache) => {
      expect(
        settleClaudeTurn(undefined, false, "failed", [
          { input_tokens: 100, cache_read_input_tokens: 40, output_tokens: 20 },
          { input_tokens: 5, cache_read_input_tokens: cache, output_tokens: 3 },
        ]),
      ).toMatchObject({
        usageStatus: "partial",
        inputTokens: 145,
        cachedInputTokens: 40,
        outputTokens: 23,
      });
    },
  );

  it.each(["cache_read_input_tokens", "cache_creation_input_tokens"])(
    "keeps Claude usage partial when the final %s is invalid",
    (field) => {
      expect(
        settleClaudeTurn(
          { subtype: "success", usage: { input_tokens: 5, output_tokens: 3, [field]: -1 } },
          false,
          "completed",
          [{ input_tokens: 100, output_tokens: 20, [field]: 40 }],
        ),
      ).toMatchObject({ usageStatus: "partial", inputTokens: 145, outputTokens: 23 });
    },
  );

  it("totals Claude's live main agent and subagent usage by model", () => {
    const mainMessages = new Map<string, TurnModelTokenUsage>();
    const subagentMessages = new Map<string, TurnModelTokenUsage>();
    const mainUsage = {
      input_tokens: 100,
      cache_read_input_tokens: 40,
      cache_creation_input_tokens: 10,
      output_tokens: 5,
    };
    expect(recordClaudeMessageUsage(mainMessages, "first", "claude-sonnet-4-6", mainUsage)).toBe(
      true,
    );
    expect(recordClaudeMessageUsage(mainMessages, "first", "claude-sonnet-4-6", mainUsage)).toBe(
      false,
    );
    expect(
      recordClaudeMessageUsage(mainMessages, "second", "claude-sonnet-4-6", {
        input_tokens: 20,
        output_tokens: 3,
      }),
    ).toBe(true);
    expect(
      recordClaudeMessageUsage(subagentMessages, "child", "claude-haiku-4-5-20251001", {
        input_tokens: 30,
        cache_read_input_tokens: 5,
        cache_creation_input_tokens: 2,
        output_tokens: 7,
      }),
    ).toBe(true);
    expect(recordClaudeMessageUsage(mainMessages, "notice", "<synthetic>", mainUsage)).toBe(false);
    expect(
      recordClaudeMessageUsage(subagentMessages, "empty", "claude-haiku-4-5", {
        input_tokens: 0,
        output_tokens: 0,
      }),
    ).toBe(false);

    expect(
      liveClaudeTurnTokenUsage({ mainMessages, subagentMessages, hasSubagents: true }),
    ).toEqual({
      usageScope: "main_agent",
      usageStatus: "partial",
      hasSubagents: true,
      inputTokens: 170,
      cachedInputTokens: 40,
      cacheCreationTokens: 10,
      outputTokens: 8,
      models: ["claude-sonnet-4-6"],
      subagentUsage: [
        {
          model: "claude-haiku-4-5-20251001",
          inputTokens: 37,
          cachedInputTokens: 5,
          cacheCreationTokens: 2,
          outputTokens: 7,
        },
      ],
      otherUsageStatus: "partial",
    });
    expect(
      liveClaudeTurnTokenUsage({
        mainMessages: new Map(),
        subagentMessages: new Map(),
        hasSubagents: false,
      }),
    ).toBeUndefined();
  });

  it("measures Claude ledger growth only from a known, nondecreasing baseline", () => {
    const ledger = (output: number) =>
      claudeModelLedger({ "claude-sonnet-4-6": { inputTokens: 100, outputTokens: output } });
    expect(claudeLedgerDelta(ledger(10), ledger(25))?.get("claude-sonnet-4-6")).toMatchObject({
      inputTokens: 0,
      outputTokens: 15,
    });
    expect(claudeLedgerDelta(ledger(25), ledger(10))).toBeUndefined();
    expect(claudeLedgerDelta(undefined, ledger(10))).toBeUndefined();
    expect(claudeModelLedger({})).toBeUndefined();
    const usage = (model: string, inputTokens: number, outputTokens: number) => ({
      model,
      inputTokens,
      outputTokens,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
    });
    // Billed rows spread across aliases of their model and clip at zero; what the growth does
    // not cover stays billed for a later result.
    const deducted = deductClaudeLedgerUsage(
      new Map([
        ["claude-haiku-4-5-20251001", usage("claude-haiku-4-5", 30, 5)],
        ["haiku-alias", usage("claude-haiku-4-5", 20, 3)],
        ["claude-sonnet-4-6", usage("claude-sonnet-4-6", 100, 20)],
      ]),
      [
        usage("claude-haiku-4-5", 40, 6),
        usage("claude-opus-5-5", 10, 1),
        usage("claude-sonnet-4-6", 150, 10),
      ],
    );
    expect([...deducted.growth]).toEqual([
      ["claude-haiku-4-5-20251001", usage("claude-haiku-4-5", 0, 0)],
      ["haiku-alias", usage("claude-haiku-4-5", 10, 2)],
      ["claude-sonnet-4-6", usage("claude-sonnet-4-6", 0, 10)],
    ]);
    expect(deducted.unbilled).toEqual([
      usage("claude-opus-5-5", 10, 1),
      usage("claude-sonnet-4-6", 50, 0),
    ]);
    // Uncached billed input cannot use up cache reads the growth recorded.
    const cached = deductClaudeLedgerUsage(
      new Map([
        ["claude-haiku-4-5", { ...usage("claude-haiku-4-5", 100, 5), cachedInputTokens: 100 }],
      ]),
      [usage("claude-haiku-4-5", 100, 5)],
    );
    expect([...cached.growth]).toEqual([
      ["claude-haiku-4-5", { ...usage("claude-haiku-4-5", 100, 0), cachedInputTokens: 100 }],
    ]);
    expect(cached.unbilled).toEqual([usage("claude-haiku-4-5", 100, 0)]);
    // The carry comes out of what the main agent left; another model's growth cannot absorb it.
    const reserved = sealClaudeSegment({
      result: { subtype: "success", usage: { input_tokens: 100, output_tokens: 20 } },
      ledgerGrowth: new Map([
        ["claude-sonnet-4-6", usage("claude-sonnet-4-6", 100, 20)],
        ["claude-haiku-4-5", usage("claude-haiku-4-5", 30, 7)],
      ]),
      mainMessages: new Map(),
      subagentMessages: new Map(),
      mainModel: "claude-sonnet-4-6",
      carry: [usage("claude-sonnet-4-6", 40, 1)],
    });
    expect(reserved.delegateRows).toEqual([usage("claude-haiku-4-5", 30, 7)]);
    expect(reserved.carry).toEqual([usage("claude-sonnet-4-6", 40, 1)]);
    // Frames name a gateway alias that the ledger reports under its canonical id.
    const alias = {
      result: { subtype: "success", usage: { input_tokens: 100, output_tokens: 20 } },
      ledgerGrowth: new Map([
        ["claude-sonnet-4-6", usage("claude-sonnet-4-6", 100, 20)],
        ["gateway-haiku", usage("claude-haiku-4-5", 30, 7)],
      ]),
      mainMessages: new Map(),
      mainModel: "claude-sonnet-4-6",
    } as const;
    const aliasCarry = sealClaudeSegment({
      ...alias,
      subagentMessages: new Map(),
      carry: [usage("gateway-haiku", 30, 1)],
    });
    expect(aliasCarry.delegateRows).toEqual([usage("claude-haiku-4-5", 0, 6)]);
    expect(aliasCarry.carry).toEqual([]);
    expect(
      sealClaudeSegment({
        ...alias,
        subagentMessages: new Map([["msg_child", usage("gateway-haiku", 30, 1)]]),
      }).delegatesMeasured,
    ).toBe(true);
  });

  it("adds Claude steering segments to the final measured result once", () => {
    expect(
      settleClaudeTurn(
        { subtype: "success", usage: { input_tokens: 5, output_tokens: 3 } },
        false,
        "completed",
        [{ input_tokens: 4, output_tokens: 2 }],
      ),
    ).toMatchObject({ usageStatus: "complete", inputTokens: 9, outputTokens: 5 });
  });

  const row = (model: string, inputTokens: number, outputTokens: number) => ({
    model,
    inputTokens,
    outputTokens,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
  });
  const byId = (...rows: ReadonlyArray<readonly [string, TurnModelTokenUsage]>) => new Map(rows);
  const ledger = (...rows: ReadonlyArray<TurnModelTokenUsage>) =>
    new Map(rows.map((usage) => [usage.model, usage]));
  const sonnet = "claude-sonnet-4-6";
  const success = (input_tokens: number, output_tokens: number) => ({
    subtype: "success" as const,
    usage: { input_tokens, output_tokens },
  });
  const steered = sealClaudeSegment({
    result: success(90, 10),
    ledgerGrowth: ledger(row(sonnet, 90, 10), row("claude-haiku-4-5", 20, 5)),
    mainMessages: byId(["main-1", row(sonnet, 90, 10)]),
    subagentMessages: byId(["child-1", row("claude-haiku-4-5", 20, 5)]),
    mainModel: sonnet,
  });
  const open = {
    mainMessages: byId(["main-2", row(sonnet, 180, 20)]),
    subagentMessages: byId(["child-2", row("claude-haiku-4-5", 15, 3)]),
  };
  const interruptedAfterSteer = {
    hasSubagents: true,
    status: "interrupted" as const,
    rootModels: [sonnet],
    segments: [steered, sealClaudeSegment({ ...open, mainModel: sonnet })],
  };
  const liveAfterError = {
    result: {
      subtype: "error_during_execution" as const,
      usage: { input_tokens: 5, output_tokens: 0 },
    },
    mainMessages: byId(["main", row(sonnet, 450, 50)]),
    mainModel: sonnet,
  };
  it.each([
    {
      name: "a steer then an interrupt adds the live last segment to the measured first",
      ...interruptedAfterSteer,
      expected: {
        usageScope: "main_agent",
        usageStatus: "partial",
        hasSubagents: true,
        inputTokens: 270,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 30,
        models: [sonnet],
        subagentUsage: [row("claude-haiku-4-5", 35, 8)],
        otherUsageStatus: "partial",
      },
    },
    {
      name: "a settlement without a result ends at the last live figure",
      ...interruptedAfterSteer,
      expected: liveClaudeTurnTokenUsage({
        sealedSegments: [steered],
        ...open,
        hasSubagents: true,
      }),
    },
    {
      name: "a result without ledger growth keeps live delegates as a floor",
      hasSubagents: true,
      status: "completed" as const,
      rootModels: [sonnet],
      segments: [
        sealClaudeSegment({
          result: success(100, 20),
          mainMessages: byId(["main", row(sonnet, 100, 20)]),
          subagentMessages: byId(["child", row("claude-haiku-4-5", 30, 7)]),
          mainModel: sonnet,
        }),
      ],
      expected: {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: true,
        inputTokens: 100,
        outputTokens: 20,
        models: [sonnet],
        subagentUsage: [row("claude-haiku-4-5", 30, 7)],
        otherUsageStatus: "partial",
      },
    },
    {
      name: "a ledger that misses a live delegate model drops its live row and marks a floor",
      hasSubagents: true,
      status: "completed" as const,
      rootModels: [sonnet],
      segments: [
        sealClaudeSegment({
          result: success(100, 20),
          ledgerGrowth: ledger(row(sonnet, 100, 20), row("claude-haiku-4-5", 30, 7)),
          mainMessages: byId(["main", row(sonnet, 100, 20)]),
          subagentMessages: byId(
            ["haiku", row("claude-haiku-4-5", 30, 7)],
            ["opus", row("claude-opus-5-5", 40, 5)],
          ),
          mainModel: sonnet,
        }),
      ],
      expected: {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: true,
        inputTokens: 100,
        outputTokens: 20,
        models: [sonnet],
        subagentUsage: [row("claude-haiku-4-5", 30, 7)],
        otherUsage: { inputTokens: 30, outputTokens: 7 },
        otherUsageStatus: "partial",
      },
    },
    {
      name: "an error result below live main usage yields to live, measuring delegates from the ledger",
      hasSubagents: false,
      status: "failed" as const,
      rootModels: [sonnet],
      segments: [
        sealClaudeSegment({
          ...liveAfterError,
          ledgerGrowth: ledger(row(sonnet, 560, 60)),
          subagentMessages: new Map(),
        }),
      ],
      expected: {
        usageScope: "main_agent",
        usageStatus: "partial",
        hasSubagents: false,
        inputTokens: 450,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 50,
        models: [sonnet],
        subagentUsage: [row(sonnet, 110, 10)],
        otherUsage: { inputTokens: 110, outputTokens: 10 },
      },
    },
    {
      name: "an error result below live main usage yields to live, with live delegates as a floor",
      hasSubagents: true,
      status: "failed" as const,
      rootModels: [sonnet],
      segments: [
        sealClaudeSegment({
          ...liveAfterError,
          subagentMessages: byId(["child", row("claude-haiku-4-5", 20, 2)]),
        }),
      ],
      expected: {
        usageScope: "main_agent",
        usageStatus: "partial",
        hasSubagents: true,
        inputTokens: 450,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 50,
        models: [sonnet],
        subagentUsage: [row("claude-haiku-4-5", 20, 2)],
        otherUsageStatus: "partial",
      },
    },
    {
      name: "a model switch then an interrupt prices each model's segment as that model",
      hasSubagents: false,
      status: "interrupted" as const,
      rootModels: [sonnet, "claude-opus-5-5"],
      segments: [
        sealClaudeSegment({
          result: success(100, 20),
          ledgerGrowth: ledger(row(sonnet, 100, 20)),
          mainMessages: byId(["sonnet", row(sonnet, 100, 20)]),
          subagentMessages: new Map(),
          mainModel: sonnet,
        }),
        sealClaudeSegment({
          mainMessages: byId(["opus", row("claude-opus-5-5", 200, 30)]),
          subagentMessages: new Map(),
          mainModel: "claude-opus-5-5",
        }),
      ],
      expected: {
        usageScope: "main_agent",
        usageStatus: "partial",
        hasSubagents: false,
        inputTokens: 300,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 50,
        models: [sonnet, "claude-opus-5-5"],
        mainAgentUsage: [row(sonnet, 100, 20), row("claude-opus-5-5", 200, 30)],
        otherUsageStatus: "partial",
      },
    },
    {
      name: "one delegate model's surplus does not hide another's shortfall",
      hasSubagents: true,
      status: "completed" as const,
      rootModels: ["claude-opus-5-5"],
      segments: [
        sealClaudeSegment({
          result: success(100, 20),
          ledgerGrowth: ledger(
            row("claude-opus-5-5", 100, 20),
            row("claude-haiku-4-5", 50, 10),
            row(sonnet, 10, 2),
          ),
          mainMessages: byId(["main", row("claude-opus-5-5", 100, 20)]),
          subagentMessages: byId(
            ["haiku", row("claude-haiku-4-5", 20, 5)],
            ["sonnet", row(sonnet, 30, 5)],
          ),
          mainModel: "claude-opus-5-5",
        }),
      ],
      expected: {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: true,
        inputTokens: 100,
        outputTokens: 20,
        models: ["claude-opus-5-5"],
        subagentUsage: [row("claude-haiku-4-5", 50, 10), row(sonnet, 10, 2)],
        otherUsage: { inputTokens: 60, outputTokens: 12 },
        otherUsageStatus: "partial",
      },
    },
    {
      name: "an abort result labelled success yields to larger live main usage",
      hasSubagents: false,
      status: "interrupted" as const,
      rootModels: [sonnet],
      segments: [
        sealClaudeSegment({
          result: success(10, 0),
          abortedBy: "aborted_streaming",
          mainMessages: byId(["main", row(sonnet, 90, 10)]),
          subagentMessages: new Map(),
          mainModel: sonnet,
        }),
      ],
      expected: {
        usageScope: "main_agent",
        usageStatus: "partial",
        hasSubagents: false,
        inputTokens: 90,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 10,
        models: [sonnet],
        otherUsageStatus: "partial",
      },
    },
    {
      name: "a ledger residual missing observed cache reads marks a floor",
      hasSubagents: true,
      status: "completed" as const,
      rootModels: ["claude-opus-5-5"],
      segments: [
        sealClaudeSegment({
          result: success(100, 20),
          ledgerGrowth: ledger(row("claude-opus-5-5", 100, 20), row("claude-haiku-4-5", 50, 10)),
          mainMessages: byId(["main", row("claude-opus-5-5", 100, 20)]),
          subagentMessages: byId([
            "haiku",
            { ...row("claude-haiku-4-5", 40, 5), cachedInputTokens: 30 },
          ]),
          mainModel: "claude-opus-5-5",
        }),
      ],
      expected: {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: true,
        inputTokens: 100,
        outputTokens: 20,
        models: ["claude-opus-5-5"],
        subagentUsage: [row("claude-haiku-4-5", 50, 10)],
        otherUsage: { inputTokens: 50, outputTokens: 10 },
        otherUsageStatus: "partial",
      },
    },
    {
      name: "residual cache reads do not cover observed uncached delegate input",
      hasSubagents: true,
      status: "completed" as const,
      rootModels: ["claude-opus-5-5"],
      segments: [
        sealClaudeSegment({
          result: success(100, 20),
          ledgerGrowth: ledger(row("claude-opus-5-5", 100, 20), {
            ...row("claude-haiku-4-5", 100, 10),
            cachedInputTokens: 100,
          }),
          mainMessages: byId(["main", row("claude-opus-5-5", 100, 20)]),
          subagentMessages: byId(["haiku", row("claude-haiku-4-5", 100, 5)]),
          mainModel: "claude-opus-5-5",
        }),
      ],
      expected: {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: true,
        inputTokens: 100,
        outputTokens: 20,
        models: ["claude-opus-5-5"],
        subagentUsage: [{ ...row("claude-haiku-4-5", 100, 10), cachedInputTokens: 100 }],
        otherUsage: { inputTokens: 100, outputTokens: 10 },
        otherUsageStatus: "partial",
      },
    },
    ...(["aborted_streaming", "aborted_tools"] as const).map((abortedBy) => ({
      name: `a steer window closed by ${abortedBy} whose result won, then a success`,
      hasSubagents: false,
      status: "completed" as const,
      rootModels: [sonnet],
      segments: [
        sealClaudeSegment({
          result: success(100, 20),
          abortedBy,
          ledgerGrowth: ledger(row(sonnet, 100, 20)),
          mainMessages: byId(["first", row(sonnet, 90, 10)]),
          subagentMessages: new Map(),
          mainModel: sonnet,
        }),
        sealClaudeSegment({
          result: success(50, 5),
          ledgerGrowth: ledger(row(sonnet, 50, 5)),
          mainMessages: byId(["second", row(sonnet, 50, 5)]),
          subagentMessages: new Map(),
          mainModel: sonnet,
        }),
      ],
      expected: {
        usageScope: "main_agent",
        // The cut message's final output never reached either source.
        usageStatus: abortedBy === "aborted_streaming" ? "partial" : "complete",
        hasSubagents: false,
        inputTokens: 150,
        outputTokens: 25,
        models: [sonnet],
        otherUsage: { inputTokens: 0, outputTokens: 0 },
      },
    })),
    {
      name: "a zero-count success flagged is_error yields to live main usage",
      hasSubagents: false,
      status: "failed" as const,
      rootModels: [sonnet],
      segments: [
        sealClaudeSegment({
          result: { ...success(0, 0), is_error: true },
          mainMessages: byId(["main", row(sonnet, 450, 50)]),
          subagentMessages: new Map(),
          mainModel: sonnet,
        }),
      ],
      expected: {
        usageScope: "main_agent",
        usageStatus: "partial",
        hasSubagents: false,
        inputTokens: 450,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 50,
        models: [sonnet],
        otherUsageStatus: "partial",
      },
    },
    {
      name: "an interrupt before any assistant snapshot names the streamed model",
      hasSubagents: false,
      status: "interrupted" as const,
      rootModels: [],
      segments: [
        sealClaudeSegment({
          mainMessages: byId(["main", row("claude-opus-5-5", 200, 30)]),
          subagentMessages: new Map(),
          mainModel: "claude-opus-5-5",
        }),
      ],
      expected: {
        usageScope: "main_agent",
        usageStatus: "partial",
        hasSubagents: false,
        inputTokens: 200,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 30,
        models: ["claude-opus-5-5"],
        otherUsageStatus: "partial",
      },
    },
    {
      name: "a window without ledger growth names models as the process ledger does",
      hasSubagents: false,
      status: "interrupted" as const,
      rootModels: ["provider-opus"],
      segments: [
        sealClaudeSegment({
          result: success(100, 20),
          ledgerGrowth: new Map([["provider-opus", row("claude-opus-5-5", 100, 20)]]),
          mainMessages: byId(["first", row("provider-opus", 100, 20)]),
          subagentMessages: new Map(),
          mainModel: "provider-opus",
        }),
        sealClaudeSegment({
          mainMessages: byId(["second", row("provider-opus", 200, 30)]),
          subagentMessages: new Map(),
          mainModel: "provider-opus",
          ledgerModelNames: new Map([["provider-opus", "claude-opus-5-5"]]),
        }),
      ],
      expected: {
        usageScope: "main_agent",
        usageStatus: "partial",
        hasSubagents: false,
        inputTokens: 300,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 50,
        models: ["provider-opus"],
        otherUsageStatus: "partial",
      },
    },
    {
      name: "ledger aliases of one billing model sum",
      hasSubagents: true,
      status: "completed" as const,
      rootModels: [sonnet],
      segments: [
        sealClaudeSegment({
          result: success(100, 20),
          ledgerGrowth: new Map([
            [sonnet, row(sonnet, 100, 20)],
            ["claude-haiku-4-5-20251001", row("claude-haiku-4-5", 30, 5)],
            ["haiku-alias", row("claude-haiku-4-5", 20, 3)],
          ]),
          mainMessages: byId(["main", row(sonnet, 100, 20)]),
          subagentMessages: new Map(),
          mainModel: sonnet,
        }),
      ],
      expected: {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: true,
        inputTokens: 100,
        outputTokens: 20,
        models: [sonnet],
        subagentUsage: [row("claude-haiku-4-5", 50, 8)],
        otherUsage: { inputTokens: 50, outputTokens: 8 },
      },
    },
  ])(
    "settles Claude usage per segment: $name",
    ({ segments, hasSubagents, status, rootModels, expected }) => {
      expect(
        claudeTurnTokenUsage(segments, { hasSubagents, status, rootModels: new Set(rootModels) }),
      ).toEqual(expected);
    },
  );
});
