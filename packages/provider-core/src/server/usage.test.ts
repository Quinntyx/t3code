import { describe, expect, it } from "@effect/vitest";

import { normalizeUsageTokens, totalTokens } from "./usage.ts";

describe("normalizeUsageTokens", () => {
  it.each([
    { inputKind: "inclusive" as const, inputTokens: 1_000 },
    { inputKind: "uncached" as const, inputTokens: 100 },
  ])("normalizes $inputKind input without adding reasoning twice", ({ inputKind, inputTokens }) => {
    const totals = normalizeUsageTokens(
      {
        inputTokens,
        cachedInputTokens: 800,
        cacheCreationTokens: 100,
        outputTokens: 200,
        reasoningTokens: 50,
      },
      inputKind,
    );
    expect(totals).toEqual({
      uncachedInputTokens: 100,
      cachedInputTokens: 800,
      cacheCreationTokens: 100,
      outputTokens: 200,
      reasoningTokens: 50,
    });
    expect(totalTokens(totals)).toBe(1_200);
  });

  it("bounds subset counters and sanitizes non-token values", () => {
    expect(
      normalizeUsageTokens(
        {
          inputTokens: 100.9,
          cachedInputTokens: 80.9,
          cacheCreationTokens: 50,
          outputTokens: 10,
          reasoningTokens: 50,
        },
        "inclusive",
      ),
    ).toEqual({
      uncachedInputTokens: 0,
      cachedInputTokens: 80,
      cacheCreationTokens: 20,
      outputTokens: 10,
      reasoningTokens: 10,
    });
    expect(
      normalizeUsageTokens(
        { cachedInputTokens: 80, cacheCreationTokens: 20, reasoningTokens: 10 },
        "inclusive",
      ),
    ).toEqual({
      uncachedInputTokens: 0,
      cachedInputTokens: 80,
      cacheCreationTokens: 20,
      outputTokens: 10,
      reasoningTokens: 10,
    });
    expect(
      normalizeUsageTokens(
        {
          inputTokens: NaN,
          cachedInputTokens: Infinity,
          cacheCreationTokens: -1,
          outputTokens: "10",
        },
        "uncached",
      ),
    ).toEqual({
      uncachedInputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    });
  });
});
