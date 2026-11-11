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
  const counts = [finalCount, ...earlierCounts]
    .map(finiteNonNegativeInteger)
    .filter((count) => count !== undefined);
  return counts.length === 0 ? finalCount : counts.reduce((sum, count) => sum + count, 0);
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
  total.output_tokens_details = {
    ...outputDetails,
    thinking_tokens: addKnownCount(
      outputDetails?.thinking_tokens,
      segments.map(
        (segment) =>
          (segment.output_tokens_details as Record<string, unknown> | undefined)?.thinking_tokens,
      ),
    ),
  };
  return total;
}

const TOKEN_FIELDS = [
  "inputTokens",
  "cachedInputTokens",
  "cacheCreationTokens",
  "outputTokens",
  "reasoningTokens",
] as const;

type TokenField = (typeof TOKEN_FIELDS)[number];
type TokenCounts = Record<TokenField, number>;
type MeasuredTokenCounts = { readonly [Field in TokenField]?: number | undefined };

function tokenCounts(usage: MeasuredTokenCounts): TokenCounts {
  return {
    inputTokens: usage.inputTokens ?? 0,
    cachedInputTokens: usage.cachedInputTokens ?? 0,
    cacheCreationTokens: usage.cacheCreationTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    reasoningTokens: usage.reasoningTokens ?? 0,
  };
}

function turnModelUsage(
  model: string,
  { reasoningTokens, ...counts }: TokenCounts,
  withReasoning: boolean,
): TurnModelTokenUsage {
  return { model, ...counts, ...(withReasoning ? { reasoningTokens } : {}) };
}

/**
 * Per-model totals from the SDK's `modelUsage`, which grows for the life of one CLI process.
 * Keyed by the SDK's model id; `model` is the canonical id Claude Code priced the work as.
 */
export type ClaudeModelLedger = ReadonlyMap<string, TurnModelTokenUsage>;

/** Unknown when absent or empty: a process that did model work never reports an empty ledger. */
export function claudeModelLedger(modelUsage: unknown): ClaudeModelLedger | undefined {
  if (typeof modelUsage !== "object" || modelUsage === null) return undefined;
  if (Object.keys(modelUsage).length === 0) return undefined;
  const ledger = new Map<string, TurnModelTokenUsage>();
  for (const [model, entry] of Object.entries(modelUsage as Record<string, unknown>)) {
    const fields = (entry ?? {}) as Record<string, unknown>;
    const input = finiteNonNegativeInteger(fields.inputTokens);
    const outputTokens = finiteNonNegativeInteger(fields.outputTokens);
    if (input === undefined || outputTokens === undefined) return undefined;
    const cachedInputTokens = finiteNonNegativeInteger(fields.cacheReadInputTokens) ?? 0;
    const cacheCreationTokens = finiteNonNegativeInteger(fields.cacheCreationInputTokens) ?? 0;
    const reasoningTokens = finiteNonNegativeInteger(fields.thinkingTokens);
    const canonicalModel =
      typeof fields.canonicalModel === "string" ? fields.canonicalModel.trim() : "";
    ledger.set(model, {
      model: canonicalModel || model,
      inputTokens: input + cachedInputTokens + cacheCreationTokens,
      cachedInputTokens,
      cacheCreationTokens,
      outputTokens,
      ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
    });
  }
  return ledger;
}

/** The window each model in the SDK's `modelUsage` is measured against, as Claude Code resolved it. */
export function claudeReportedContextWindows(modelUsage: unknown): ReadonlyMap<string, number> {
  const windows = new Map<string, number>();
  if (typeof modelUsage !== "object" || modelUsage === null) return windows;
  for (const [model, entry] of Object.entries(modelUsage as Record<string, unknown>)) {
    const window = finiteNonNegativeInteger(
      (entry as Record<string, unknown> | null)?.contextWindow,
    );
    if (window !== undefined && window > 0) windows.set(model, window);
  }
  return windows;
}

/** Ledger growth since `previous`. Unknown without a baseline or when a counter goes backwards. */
export function claudeLedgerDelta(
  previous: ClaudeModelLedger | undefined,
  current: ClaudeModelLedger | undefined,
): ClaudeModelLedger | undefined {
  if (previous === undefined || current === undefined) return undefined;
  if ([...previous.keys()].some((model) => !current.has(model))) return undefined;
  const growth = new Map<string, TurnModelTokenUsage>();
  for (const [model, after] of current) {
    const before = tokenCounts(previous.get(model) ?? {});
    const counts = tokenCounts(after);
    for (const field of TOKEN_FIELDS) counts[field] -= before[field];
    if (TOKEN_FIELDS.some((field) => counts[field] < 0)) return undefined;
    growth.set(model, turnModelUsage(after.model, counts, after.reasoningTokens !== undefined));
  }
  return growth;
}

/** Ledger growth across the results a turn consumed; incomplete once any result's is unknown. */
export interface ClaudeTurnLedger {
  readonly growth: ClaudeModelLedger;
  readonly complete: boolean;
}

export function addClaudeLedgerUsage(
  turn: ClaudeTurnLedger,
  growth: ClaudeModelLedger | undefined,
): ClaudeTurnLedger {
  if (growth === undefined) return { growth: turn.growth, complete: false };
  const total = new Map(turn.growth);
  for (const [model, usage] of growth) {
    const previous = total.get(model);
    const counts = tokenCounts(previous ?? {});
    for (const field of TOKEN_FIELDS) counts[field] += usage[field] ?? 0;
    const withReasoning =
      usage.reasoningTokens !== undefined || previous?.reasoningTokens !== undefined;
    total.set(model, turnModelUsage(usage.model, counts, withReasoning));
  }
  return { growth: total, complete: turn.complete };
}

/** Stream deltas and snapshots repeat a root message's usage; keep each counter's largest report. */
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
  const counts = tokenCounts({});
  for (const field of TOKEN_FIELDS) {
    counts[field] = Math.max(current[field] ?? 0, previous?.[field] ?? 0);
  }
  const withReasoning =
    current.reasoningTokens !== undefined || previous?.reasoningTokens !== undefined;
  messages.set(messageId, turnModelUsage(model, counts, withReasoning));
}

export interface ClaudeTurnObservations {
  // Models on the turn's root assistant messages.
  readonly rootModels?: ReadonlySet<string>;
  // Ledger growth across every result this turn consumed, including steered segments.
  readonly ledger?: ClaudeTurnLedger;
  // Root message usage by message id, which splits the main agent's usage by model.
  readonly mainMessages?: ReadonlyMap<string, TurnModelTokenUsage>;
  // The main agent's latest model; it takes main usage no root message accounts for.
  readonly mainModel?: string;
}

export function normalizeClaudeTurnTokenUsage(
  result:
    | {
        readonly subtype: SDKResultMessage["subtype"];
        readonly usage?: unknown;
        readonly local_command?: unknown;
      }
    | undefined,
  hasSubagents: boolean,
  terminalStatus: RuntimeTurnState,
  earlierSegmentUsage: ReadonlyArray<unknown> = [],
  observed: ClaudeTurnObservations = {},
): TurnTokenUsage {
  const main = normalizeClaudeMainAgentTokenUsage(
    result,
    hasSubagents,
    terminalStatus,
    earlierSegmentUsage,
  );
  const ledger = observed.ledger?.growth ?? new Map<string, TurnModelTokenUsage>();
  const canonicalModel = (model: string) => ledger.get(model)?.model ?? model;

  const remaining = tokenCounts(main);
  const mainByModel = new Map<string, TokenCounts>();
  const claimMainUsage = (model: string, usage: MeasuredTokenCounts) => {
    const counts = mainByModel.get(canonicalModel(model)) ?? tokenCounts({});
    for (const field of TOKEN_FIELDS) {
      const count = Math.min(remaining[field], usage[field] ?? 0);
      counts[field] += count;
      remaining[field] -= count;
    }
    mainByModel.set(canonicalModel(model), counts);
  };
  for (const message of observed.mainMessages?.values() ?? []) {
    claimMainUsage(message.model, message);
  }
  const mainModel = observed.mainModel ?? (ledger.size === 1 ? [...ledger.keys()][0]! : "");
  if (mainModel !== "") claimMainUsage(mainModel, { ...remaining });

  // The ledger counts the main agent too; what the main agent did not claim ran outside it.
  const unclaimed = new Map([...mainByModel].map(([model, counts]) => [model, { ...counts }]));
  const subagentUsage: TurnModelTokenUsage[] = [];
  for (const usage of ledger.values()) {
    const counts = tokenCounts(usage);
    const claimed = unclaimed.get(usage.model);
    for (const field of TOKEN_FIELDS) {
      const count = Math.min(counts[field], claimed?.[field] ?? 0);
      counts[field] -= count;
      if (claimed !== undefined) claimed[field] -= count;
    }
    if (counts.inputTokens + counts.outputTokens === 0) continue;
    counts.reasoningTokens = Math.min(counts.outputTokens, counts.reasoningTokens);
    subagentUsage.push(turnModelUsage(usage.model, counts, usage.reasoningTokens !== undefined));
  }
  const mainAgentUsage = [...mainByModel].flatMap(([model, counts]) =>
    counts.inputTokens + counts.outputTokens === 0
      ? []
      : [turnModelUsage(model, counts, main.reasoningTokens !== undefined)],
  );

  // The result omits subagent and compaction work that the process-wide ledger records.
  const ledgerInputTokens = [...ledger.values()].reduce((sum, usage) => sum + usage.inputTokens, 0);
  const ledgerOutputTokens = [...ledger.values()].reduce(
    (sum, usage) => sum + usage.outputTokens,
    0,
  );
  const otherUsage =
    observed.ledger?.complete === true &&
    main.inputTokens !== undefined &&
    main.outputTokens !== undefined &&
    ledgerInputTokens >= main.inputTokens &&
    ledgerOutputTokens >= main.outputTokens
      ? {
          inputTokens: ledgerInputTokens - main.inputTokens,
          outputTokens: ledgerOutputTokens - main.outputTokens,
        }
      : undefined;
  const observedFields = {
    ...(observed.rootModels !== undefined && observed.rootModels.size > 0
      ? { models: [...observed.rootModels] }
      : {}),
    ...(typeof result?.local_command === "string" && result.local_command.length > 0
      ? { localCommand: true }
      : {}),
    ...(otherUsage === undefined ? {} : { otherUsage }),
    ...(mainAgentUsage.length > 1 ? { mainAgentUsage } : {}),
    ...(subagentUsage.length === 0 ? {} : { subagentUsage }),
    ...(observed.ledger?.complete === false ? { otherUsageStatus: "partial" as const } : {}),
  };
  // Native subagents and workflows can bill a turn whose main agent reported nothing.
  return main.usageStatus === "unavailable" && subagentUsage.length > 0
    ? { ...main, ...observedFields, usageStatus: "partial" }
    : { ...main, ...observedFields };
}

function normalizeClaudeMainAgentTokenUsage(
  result: { readonly subtype: SDKResultMessage["subtype"]; readonly usage?: unknown } | undefined,
  hasSubagents: boolean,
  terminalStatus: RuntimeTurnState,
  earlierSegmentUsage: ReadonlyArray<unknown> = [],
): TurnTokenUsage {
  const finalUsage = result?.usage as Record<string, unknown> | undefined;
  const usage = withEarlierSegmentUsage(finalUsage ?? {}, earlierSegmentUsage);
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
    finiteNonNegativeInteger(finalUsage?.input_tokens) !== undefined &&
    finiteNonNegativeInteger(finalUsage?.output_tokens) !== undefined &&
    inputTokens !== undefined &&
    rawOutputTokens !== undefined &&
    BILLED_USAGE_FIELDS.every(
      (field) =>
        finalUsage?.[field] == null || finiteNonNegativeInteger(finalUsage[field]) !== undefined,
    )
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
