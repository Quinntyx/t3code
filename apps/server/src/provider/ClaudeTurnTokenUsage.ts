import type { SDKResultMessage } from "@anthropic-ai/claude-agent-sdk";
import type { RuntimeTurnState, TurnModelTokenUsage, TurnTokenUsage } from "@t3tools/contracts";

function finiteNonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.round(value)
    : undefined;
}

const BILLED_USAGE_FIELDS = [
  "input_tokens",
  "cache_read_input_tokens",
  "cache_creation_input_tokens",
  "output_tokens",
] as const;

function addKnownCount(finalCount: unknown, earlierCounts: ReadonlyArray<unknown>): unknown {
  const known = finiteNonNegativeInteger(finalCount);
  if (known === undefined) return finalCount;
  return earlierCounts.reduce<number>(
    (sum, count) => sum + (finiteNonNegativeInteger(count) ?? 0),
    known,
  );
}

// Steering aborts the current segment; each SDK result reports only that segment's usage.
function withEarlierSegmentUsage(
  usage: Record<string, unknown>,
  earlierSegmentUsage: ReadonlyArray<unknown>,
): Record<string, unknown> {
  if (earlierSegmentUsage.length === 0) return usage;
  const segments = earlierSegmentUsage.map((segment) => (segment ?? {}) as Record<string, unknown>);
  const total = { ...usage };
  for (const field of BILLED_USAGE_FIELDS) {
    total[field] = addKnownCount(
      usage[field],
      segments.map((segment) => segment[field]),
    );
  }
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  if (outputDetails != null) {
    total.output_tokens_details = {
      ...outputDetails,
      thinking_tokens: addKnownCount(
        outputDetails.thinking_tokens,
        segments.map(
          (segment) =>
            (segment.output_tokens_details as Record<string, unknown> | undefined)?.thinking_tokens,
        ),
      ),
    };
  }
  return total;
}

type ClaudeModelUsage = SDKResultMessage["modelUsage"];
type ClaudeUsageResult = {
  readonly subtype: SDKResultMessage["subtype"];
  readonly usage?: unknown;
  readonly modelUsage?: ClaudeModelUsage | undefined;
};

const MODEL_USAGE_FIELDS = [
  "inputTokens",
  "cacheReadInputTokens",
  "cacheCreationInputTokens",
  "outputTokens",
] as const;

const TOKEN_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheCreationTokens",
  "outputTokens",
  "reasoningTokens",
] as const;

export function recordClaudeMainMessageUsage(
  messages: Map<string, TurnModelTokenUsage>,
  messageId: string,
  model: string,
  usage: unknown,
): void {
  if (model === "<synthetic>") return;
  const current = normalizeClaudeMainAgentTokenUsage(
    { subtype: "success", usage },
    false,
    "completed",
  );
  const previous = messages.get(messageId);
  const counts = {
    model,
    inputTokens: 0,
    cachedInputTokens: 0,
    cacheCreationTokens: 0,
    outputTokens: 0,
  };
  for (const field of TOKEN_FIELDS) {
    if (field === "reasoningTokens") continue;
    counts[field] = Math.max(current[field] ?? 0, previous?.[field] ?? 0);
  }
  messages.set(messageId, {
    ...counts,
    ...(current.reasoningTokens === undefined && previous?.reasoningTokens === undefined
      ? {}
      : {
          reasoningTokens: Math.max(current.reasoningTokens ?? 0, previous?.reasoningTokens ?? 0),
        }),
  });
}

export function normalizeClaudeTurnTokenUsage(
  result: ClaudeUsageResult | undefined,
  hasSubagents: boolean,
  terminalStatus: RuntimeTurnState,
  earlierSegmentUsage: ReadonlyArray<unknown> = [],
  accounting: {
    readonly previousModelUsage?: ClaudeModelUsage | undefined;
    readonly mainModel?: string;
    readonly mainMessages?: ReadonlyMap<string, TurnModelTokenUsage>;
  } = {},
): TurnTokenUsage {
  const main = normalizeClaudeMainAgentTokenUsage(
    result,
    hasSubagents,
    terminalStatus,
    earlierSegmentUsage,
  );
  const entries = Object.entries(result?.modelUsage ?? {});
  // /clear resets every model's counters; a zeroed crash result is not a new baseline.
  const reset = entries.some(([model, usage]) =>
    MODEL_USAGE_FIELDS.some(
      (field) => usage[field] < (accounting.previousModelUsage?.[model]?.[field] ?? 0),
    ),
  );
  const remaining = {
    inputTokens: main.inputTokens ?? 0,
    cachedInputTokens: main.cachedInputTokens ?? 0,
    cacheCreationTokens: main.cacheCreationTokens ?? 0,
    outputTokens: main.outputTokens ?? 0,
    reasoningTokens: main.reasoningTokens ?? 0,
  };
  const mainByModel = new Map<string, typeof remaining>();
  const canonicalModel = (model: string) =>
    result?.modelUsage?.[model]?.canonicalModel?.trim() || model;
  for (const message of accounting.mainMessages?.values() ?? []) {
    const model = canonicalModel(message.model);
    const counts = mainByModel.get(model) ?? {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
    for (const field of TOKEN_FIELDS) {
      const count = Math.min(remaining[field], message[field] ?? 0);
      counts[field] += count;
      remaining[field] -= count;
    }
    mainByModel.set(model, counts);
  }
  const mainModel = accounting.mainModel ?? (entries.length === 1 ? entries[0]![0] : "");
  if (mainModel !== "") {
    const model = canonicalModel(mainModel);
    const counts = mainByModel.get(model) ?? {
      inputTokens: 0,
      cachedInputTokens: 0,
      cacheCreationTokens: 0,
      outputTokens: 0,
      reasoningTokens: 0,
    };
    for (const field of TOKEN_FIELDS) counts[field] += remaining[field];
    mainByModel.set(model, counts);
  }
  const deductions = new Map([...mainByModel].map(([model, counts]) => [model, { ...counts }]));
  const subagentUsage: TurnModelTokenUsage[] = [];
  for (const [key, usage] of entries) {
    if (!MODEL_USAGE_FIELDS.some((field) => usage[field] > 0)) continue;
    const model = canonicalModel(key);
    const previous = reset ? undefined : accounting.previousModelUsage?.[key];
    const delta = (field: (typeof MODEL_USAGE_FIELDS)[number] | "thinkingTokens") =>
      Math.max(
        0,
        (finiteNonNegativeInteger(usage[field]) ?? 0) -
          (finiteNonNegativeInteger(previous?.[field]) ?? 0),
      );
    const cachedInputTokens = delta("cacheReadInputTokens");
    const cacheCreationTokens = delta("cacheCreationInputTokens");
    const counts = {
      inputTokens: delta("inputTokens") + cachedInputTokens + cacheCreationTokens,
      cachedInputTokens,
      cacheCreationTokens,
      outputTokens: delta("outputTokens"),
      reasoningTokens: delta("thinkingTokens"),
    };
    const mainCounts = deductions.get(model);
    for (const field of TOKEN_FIELDS) {
      const count = Math.min(counts[field], mainCounts?.[field] ?? 0);
      counts[field] -= count;
      if (mainCounts !== undefined) mainCounts[field] -= count;
    }
    if (counts.inputTokens + counts.outputTokens === 0) continue;
    subagentUsage.push({
      model,
      inputTokens: counts.inputTokens,
      cachedInputTokens: counts.cachedInputTokens,
      cacheCreationTokens: counts.cacheCreationTokens,
      outputTokens: counts.outputTokens,
      ...(usage.thinkingTokens === undefined
        ? {}
        : { reasoningTokens: Math.min(counts.outputTokens, counts.reasoningTokens) }),
    });
  }
  const mainAgentUsage = [...mainByModel].flatMap(([model, { reasoningTokens, ...counts }]) =>
    counts.inputTokens + counts.outputTokens === 0
      ? []
      : [{ model, ...counts, ...(main.reasoningTokens === undefined ? {} : { reasoningTokens }) }],
  );
  const additionalUsage = {
    ...(mainAgentUsage.length > 1 ? { mainAgentUsage } : {}),
    ...(subagentUsage.length === 0 ? {} : { hasSubagents: true, subagentUsage }),
  };
  if (main.usageStatus === "unavailable" && subagentUsage.length > 0) {
    return { ...main, ...additionalUsage, usageStatus: "partial" };
  }
  return { ...main, ...additionalUsage };
}

function normalizeClaudeMainAgentTokenUsage(
  result: { readonly subtype: SDKResultMessage["subtype"]; readonly usage?: unknown } | undefined,
  hasSubagents: boolean,
  terminalStatus: RuntimeTurnState,
  earlierSegmentUsage: ReadonlyArray<unknown> = [],
): TurnTokenUsage {
  const finalUsage = result?.usage as Record<string, unknown> | undefined;
  const segmentUsage =
    finalUsage ??
    (earlierSegmentUsage.length === 0
      ? undefined
      : {
          input_tokens: 0,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
          output_tokens: 0,
        });
  const usage = segmentUsage && withEarlierSegmentUsage(segmentUsage, earlierSegmentUsage);
  if (!usage) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents,
    };
  }

  const uncachedInputTokens = finiteNonNegativeInteger(usage.input_tokens);
  const cachedInputTokens = finiteNonNegativeInteger(usage.cache_read_input_tokens);
  const cacheCreationTokens = finiteNonNegativeInteger(usage.cache_creation_input_tokens);
  const rawOutputTokens = finiteNonNegativeInteger(usage.output_tokens);
  const outputDetails = usage.output_tokens_details as Record<string, unknown> | undefined;
  const thinkingTokens = finiteNonNegativeInteger(outputDetails?.thinking_tokens);
  const cachedInputContribution = usage.cache_read_input_tokens == null ? 0 : cachedInputTokens;
  const cacheCreationContribution =
    usage.cache_creation_input_tokens == null ? 0 : cacheCreationTokens;
  const inputTokens =
    uncachedInputTokens !== undefined &&
    cachedInputContribution !== undefined &&
    cacheCreationContribution !== undefined
      ? uncachedInputTokens + cachedInputContribution + cacheCreationContribution
      : undefined;
  const hasKnownUsage =
    uncachedInputTokens !== undefined ||
    cachedInputTokens !== undefined ||
    cacheCreationTokens !== undefined ||
    rawOutputTokens !== undefined;
  const hasPositiveUsage =
    (uncachedInputTokens ?? 0) +
      (cachedInputTokens ?? 0) +
      (cacheCreationTokens ?? 0) +
      (rawOutputTokens ?? 0) >
    0;

  if (!hasKnownUsage || (result?.subtype !== "success" && !hasPositiveUsage)) {
    return {
      usageStatus: "unavailable",
      usageScope: "main_agent",
      hasSubagents,
    };
  }

  const commonUsage = {
    usageScope: "main_agent",
    ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
    ...(cacheCreationTokens !== undefined ? { cacheCreationTokens } : {}),
    ...(thinkingTokens !== undefined && rawOutputTokens !== undefined
      ? { reasoningTokens: Math.min(rawOutputTokens, thinkingTokens) }
      : {}),
    hasSubagents,
  } as const;
  if (
    terminalStatus === "completed" &&
    result?.subtype === "success" &&
    inputTokens !== undefined &&
    rawOutputTokens !== undefined
  ) {
    return {
      ...commonUsage,
      usageStatus: "complete",
      inputTokens,
      outputTokens: rawOutputTokens,
    };
  }
  return {
    ...commonUsage,
    usageStatus: "partial",
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(rawOutputTokens !== undefined ? { outputTokens: rawOutputTokens } : {}),
  };
}
