import { describe, expect, it } from "vite-plus/test";
import {
  addClaudeLedgerUsage,
  claudeLedgerDelta,
  claudeModelLedger,
  normalizeClaudeTurnTokenUsage,
  recordClaudeMainMessageUsage,
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
  addClaudeLedgerUsage(
    { growth: new Map(), complete: true },
    claudeLedgerDelta(
      previous === undefined ? new Map() : claudeModelLedger(previous),
      claudeModelLedger(current),
    ),
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
      normalizeClaudeTurnTokenUsage(
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
    { previous: 500, input: 120, output: 25, expected: undefined },
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
    const current = normalizeClaudeTurnTokenUsage(
      { subtype: "success", usage: { input_tokens: 100, output_tokens: 20 } },
      false,
      "completed",
      [],
      {
        mainModel: "claude-opus-5-5",
        ledger: ledgerSince(
          row.previous === undefined
            ? undefined
            : { "provider-opus": modelUsage(row.previous, row.previous === 150 ? 30 : 100) },
          { "provider-opus": modelUsage(row.input, row.output) },
        ),
      },
    );
    expect(current).toMatchObject({ inputTokens: 100, outputTokens: 20 });
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
    recordClaudeMainMessageUsage(mainMessages, "sonnet-response", "claude-sonnet-4-6", {
      input_tokens: 100,
      output_tokens: 1,
    });
    recordClaudeMainMessageUsage(mainMessages, "sonnet-response", "claude-sonnet-4-6", {
      input_tokens: 100,
      output_tokens: 20,
    });
    recordClaudeMainMessageUsage(mainMessages, "sonnet-response", "claude-sonnet-4-6", {
      input_tokens: 0,
      output_tokens: 20,
    });
    recordClaudeMainMessageUsage(mainMessages, "opus-response", "claude-opus-5-5", {
      input_tokens: 20,
      output_tokens: 4,
    });
    recordClaudeMainMessageUsage(mainMessages, "notice", "<synthetic>", {
      input_tokens: 500,
      output_tokens: 100,
    });
    const current = normalizeClaudeTurnTokenUsage(
      { subtype: "success", usage: { input_tokens: 120, output_tokens: 24 } },
      true,
      "completed",
      [],
      {
        mainModel: "claude-opus-5-5",
        mainMessages,
        ledger: ledgerSince(undefined, {
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
    const result = normalizeClaudeTurnTokenUsage(
      { subtype: "error_during_execution", usage: { input_tokens: 0, output_tokens: 0 } },
      false,
      "failed",
      [],
      {
        ledger: ledgerSince(undefined, {
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
      normalizeClaudeTurnTokenUsage(
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
      normalizeClaudeTurnTokenUsage(
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
        normalizeClaudeTurnTokenUsage(
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
      expect(
        normalizeClaudeTurnTokenUsage({ subtype: "success", usage }, false, "completed")
          .usageStatus,
      ).toBe("unavailable");
    },
  );

  it("retains measured thinking tokens without a final result", () => {
    expect(
      normalizeClaudeTurnTokenUsage(undefined, false, "failed", [
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
        normalizeClaudeTurnTokenUsage(undefined, false, "failed", [
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
        normalizeClaudeTurnTokenUsage(
          { subtype: "success", usage: { input_tokens: 5, output_tokens: 3, [field]: -1 } },
          false,
          "completed",
          [{ input_tokens: 100, output_tokens: 20, [field]: 40 }],
        ),
      ).toMatchObject({ usageStatus: "partial", inputTokens: 145, outputTokens: 23 });
    },
  );

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
  });

  it("adds Claude steering segments to the final measured result once", () => {
    expect(
      normalizeClaudeTurnTokenUsage(
        { subtype: "success", usage: { input_tokens: 5, output_tokens: 3 } },
        false,
        "completed",
        [{ input_tokens: 4, output_tokens: 2 }],
      ),
    ).toMatchObject({ usageStatus: "complete", inputTokens: 9, outputTokens: 5 });
  });
});
