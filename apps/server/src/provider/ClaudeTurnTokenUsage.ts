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

// Input includes both cache counts; comparing or subtracting needs the uncached part on its own.
function disjointCounts(usage: MeasuredTokenCounts): TokenCounts {
  const counts = tokenCounts(usage);
  counts.inputTokens = Math.max(
    0,
    counts.inputTokens - counts.cachedInputTokens - counts.cacheCreationTokens,
  );
  return counts;
}

function inclusiveCounts(counts: TokenCounts): TokenCounts {
  return {
    ...counts,
    inputTokens: counts.inputTokens + counts.cachedInputTokens + counts.cacheCreationTokens,
    reasoningTokens: Math.min(counts.outputTokens, counts.reasoningTokens),
  };
}

/**
 * Growth less usage already billed from frames of a window that settled without a result. The
 * kept baseline means a later growth holds all of that window's work, of which frames saw a
 * floor; a message still running reaches the ledger only in a later result, so what this growth
 * does not cover stays billed for the next one.
 */
export function deductClaudeLedgerUsage(
  growth: ClaudeModelLedger,
  billed: ReadonlyArray<TurnModelTokenUsage>,
  canonicalModel: (model: string) => string = (model) => model,
): { readonly growth: ClaudeModelLedger; readonly unbilled: TurnModelTokenUsage[] } {
  const remaining = new Map([...growth].map(([model, usage]) => [model, disjointCounts(usage)]));
  const unbilled: TurnModelTokenUsage[] = [];
  for (const row of billed) {
    const model = canonicalModel(row.model);
    const unclaimed = disjointCounts(row);
    for (const [key, usage] of growth) {
      if (canonicalModel(key) !== model && canonicalModel(usage.model) !== model) continue;
      const counts = remaining.get(key)!;
      for (const field of TOKEN_FIELDS) {
        const count = Math.min(counts[field], unclaimed[field]);
        counts[field] -= count;
        unclaimed[field] -= count;
      }
    }
    if (TOKEN_FIELDS.some((field) => unclaimed[field] > 0)) {
      unbilled.push(turnModelUsage(row.model, inclusiveCounts(unclaimed), false));
    }
  }
  return {
    growth: new Map(
      [...growth].map(([model, usage]) => [
        model,
        turnModelUsage(
          usage.model,
          inclusiveCounts(remaining.get(model)!),
          usage.reasoningTokens !== undefined,
        ),
      ]),
    ),
    unbilled,
  };
}

/**
 * Stream deltas and snapshots repeat a message's usage; keep each counter's largest report.
 * Returns whether the stored entry changed, so a caller can emit only on new usage.
 */
export function recordClaudeMessageUsage(
  messages: Map<string, TurnModelTokenUsage>,
  messageId: string,
  model: string,
  usage: unknown,
): boolean {
  if (model === "<synthetic>") return false;
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
  const grew = TOKEN_FIELDS.some((field) => counts[field] > (previous?.[field] ?? 0));
  if (grew || previous !== undefined) {
    messages.set(messageId, turnModelUsage(model, counts, withReasoning));
  }
  return grew;
}

interface ModelTotals {
  readonly countsByModel: Map<string, TokenCounts>;
  readonly withReasoning: Set<string>;
}

function totalsByModel(rows: Iterable<TurnModelTokenUsage>): ModelTotals {
  const countsByModel = new Map<string, TokenCounts>();
  const withReasoning = new Set<string>();
  for (const usage of rows) {
    const counts = countsByModel.get(usage.model) ?? tokenCounts({});
    for (const field of TOKEN_FIELDS) counts[field] += usage[field] ?? 0;
    if (usage.reasoningTokens !== undefined) withReasoning.add(usage.model);
    countsByModel.set(usage.model, counts);
  }
  return { countsByModel, withReasoning };
}

function sumCounts(rows: Iterable<MeasuredTokenCounts>): TokenCounts {
  const total = tokenCounts({});
  for (const row of rows) for (const field of TOKEN_FIELDS) total[field] += row[field] ?? 0;
  return total;
}

function modelRows({ countsByModel, withReasoning }: ModelTotals): TurnModelTokenUsage[] {
  return [...countsByModel].flatMap(([model, counts]) =>
    counts.inputTokens + counts.outputTokens === 0
      ? []
      : [turnModelUsage(model, counts, withReasoning.has(model))],
  );
}

function claudeResultUsage(counts: TokenCounts, withReasoning: boolean): Record<string, unknown> {
  return {
    input_tokens: Math.max(
      0,
      counts.inputTokens - counts.cachedInputTokens - counts.cacheCreationTokens,
    ),
    cache_read_input_tokens: counts.cachedInputTokens,
    cache_creation_input_tokens: counts.cacheCreationTokens,
    output_tokens: counts.outputTokens,
    ...(withReasoning
      ? { output_tokens_details: { thinking_tokens: counts.reasoningTokens } }
      : {}),
  };
}

interface ClaudeSegmentResult {
  readonly subtype: SDKResultMessage["subtype"] | undefined;
  // The SDK also reports API errors and aborts as a success with is_error.
  readonly is_error?: boolean | undefined;
  readonly usage?: unknown;
  readonly local_command?: unknown;
}

function hasValidSuccessUsage(result: ClaudeSegmentResult | undefined): boolean {
  const usage = result?.usage as Record<string, unknown> | undefined;
  return (
    result?.subtype === "success" &&
    result.is_error !== true &&
    finiteNonNegativeInteger(usage?.input_tokens) !== undefined &&
    finiteNonNegativeInteger(usage?.output_tokens) !== undefined &&
    BILLED_USAGE_FIELDS.every(
      (field) => usage?.[field] == null || finiteNonNegativeInteger(usage[field]) !== undefined,
    )
  );
}

/** One SDK result window of a turn. A steer closes one with its abort result; settlement the last. */
export interface ClaudeSegmentUsage {
  // The main agent's usage in the SDK result's shape, from the one source this segment chose.
  readonly mainUsage: unknown;
  readonly mainRows: ReadonlyArray<TurnModelTokenUsage>;
  readonly delegateRows: ReadonlyArray<TurnModelTokenUsage>;
  readonly otherUsage: { readonly inputTokens: number; readonly outputTokens: number } | undefined;
  readonly subtype: SDKResultMessage["subtype"] | undefined;
  readonly isError: boolean;
  readonly localCommand: boolean;
  // The main figure is exact: a valid success, or a tool-boundary abort whose result won.
  readonly mainComplete: boolean;
  readonly delegatesMeasured: boolean;
}

// Splits a result's main usage by the models its messages report; the rest goes to `mainModel`.
function claimMainUsage(
  measured: TurnTokenUsage,
  messages: Iterable<TurnModelTokenUsage>,
  mainModel: string,
  ledgerModel: (model: string) => string,
): ModelTotals {
  const remaining = tokenCounts(measured);
  const countsByModel = new Map<string, TokenCounts>();
  const claim = (model: string, usage: MeasuredTokenCounts) => {
    const counts = countsByModel.get(ledgerModel(model)) ?? tokenCounts({});
    for (const field of TOKEN_FIELDS) {
      const count = Math.min(remaining[field], usage[field] ?? 0);
      counts[field] += count;
      remaining[field] -= count;
    }
    countsByModel.set(ledgerModel(model), counts);
  };
  for (const message of messages) claim(message.model, message);
  if (mainModel !== "") claim(mainModel, { ...remaining });
  return {
    countsByModel,
    withReasoning: new Set(measured.reasoningTokens === undefined ? [] : countsByModel.keys()),
  };
}

// The ledger counts the main agent too; what the main agent did not claim ran outside it.
function ledgerResidual(growth: ClaudeModelLedger, main: ModelTotals): TurnModelTokenUsage[] {
  const residual = totalsByModel(growth.values());
  for (const [model, counts] of residual.countsByModel) {
    const claimed = main.countsByModel.get(model);
    for (const field of TOKEN_FIELDS) {
      counts[field] = Math.max(0, counts[field] - (claimed?.[field] ?? 0));
    }
    counts.reasoningTokens = Math.min(counts.outputTokens, counts.reasoningTokens);
  }
  return modelRows(residual);
}

export function sealClaudeSegment(input: {
  readonly result?: ClaudeSegmentResult | undefined;
  // This segment's growth of the process-wide ledger; undefined when unknown.
  readonly ledgerGrowth?: ClaudeModelLedger | undefined;
  readonly mainMessages: ReadonlyMap<string, TurnModelTokenUsage>;
  readonly subagentMessages: ReadonlyMap<string, TurnModelTokenUsage>;
  // The main agent's latest model; it takes result usage no root message accounts for.
  readonly mainModel?: string;
  // The id form live subagent rows are keyed by, to check the ledger covers them.
  readonly canonicalModel?: (model: string) => string;
  // The model the process's ledger names each raw model id, for windows without growth.
  readonly ledgerModelNames?: ReadonlyMap<string, string>;
  // Steering and interrupts abort a window with a result that can still read as a success.
  readonly abortedBy?: "aborted_streaming" | "aborted_tools" | undefined;
  // Messages of subagents still running at the result; the ledger records them once they end.
  readonly unfinishedMessageIds?: ReadonlySet<string>;
}): ClaudeSegmentUsage {
  const { result, ledgerGrowth: growth, ledgerModelNames: names } = input;
  const ledgerModel = (model: string) => growth?.get(model)?.model ?? names?.get(model) ?? model;
  const live = totalsByModel(
    growth === undefined && (names === undefined || names.size === 0)
      ? input.mainMessages.values()
      : [...input.mainMessages.values()].map((usage) => ({
          ...usage,
          model: ledgerModel(usage.model),
        })),
  );
  const liveTotal =
    live.countsByModel.size === 0 ? undefined : sumCounts(live.countsByModel.values());
  const measured =
    result === undefined
      ? undefined
      : normalizeClaudeMainAgentTokenUsage(result, false, "completed");
  // Closes other than a valid success can under-report, so take the larger source wholesale.
  const fromResult =
    measured !== undefined &&
    ((input.abortedBy === undefined && hasValidSuccessUsage(result)) ||
      (measured.inputTokens ?? 0) + (measured.outputTokens ?? 0) >=
        (liveTotal?.inputTokens ?? 0) + (liveTotal?.outputTokens ?? 0))
      ? measured
      : undefined;
  const main =
    fromResult === undefined
      ? live
      : claimMainUsage(
          fromResult,
          input.mainMessages.values(),
          input.mainModel ?? (growth?.size === 1 ? [...growth.keys()][0]! : ""),
          ledgerModel,
        );
  const mainCounts = fromResult ?? liveTotal;

  const liveDelegates = totalsByModel(input.subagentMessages.values());
  const delegateRows =
    growth === undefined ? modelRows(liveDelegates) : ledgerResidual(growth, main);
  const coveredDelegates =
    input.unfinishedMessageIds === undefined || input.unfinishedMessageIds.size === 0
      ? liveDelegates
      : totalsByModel(
          [...input.subagentMessages].flatMap(([id, usage]) =>
            input.unfinishedMessageIds!.has(id) ? [] : [usage],
          ),
        );
  const canonicalModel = input.canonicalModel ?? ((model: string) => model);
  const delegatesByModel = totalsByModel(
    delegateRows.map((usage) => ({ ...usage, model: canonicalModel(usage.model) })),
  ).countsByModel;
  // The result omits subagent and compaction work that the process-wide ledger records.
  const ledgerTotal = growth === undefined ? undefined : sumCounts(growth.values());
  return {
    mainUsage:
      fromResult !== undefined
        ? result?.usage
        : liveTotal === undefined
          ? undefined
          : claudeResultUsage(liveTotal, live.withReasoning.size > 0),
    mainRows: modelRows(main),
    delegateRows,
    otherUsage:
      ledgerTotal !== undefined &&
      mainCounts?.inputTokens !== undefined &&
      mainCounts.outputTokens !== undefined &&
      ledgerTotal.inputTokens >= mainCounts.inputTokens &&
      ledgerTotal.outputTokens >= mainCounts.outputTokens
        ? {
            inputTokens: ledgerTotal.inputTokens - mainCounts.inputTokens,
            outputTokens: ledgerTotal.outputTokens - mainCounts.outputTokens,
          }
        : undefined,
    subtype: result?.subtype,
    isError: result?.is_error === true,
    localCommand: typeof result?.local_command === "string" && result.local_command.length > 0,
    // An aborted_streaming close never got the cut message's final output, from either source.
    mainComplete:
      fromResult !== undefined &&
      (input.abortedBy === "aborted_tools" ||
        (input.abortedBy === undefined && hasValidSuccessUsage(result))),
    delegatesMeasured:
      growth !== undefined &&
      [...coveredDelegates.countsByModel].every(([model, live]) => {
        const measured = delegatesByModel.get(canonicalModel(model));
        if (measured === undefined) return false;
        const observed = disjointCounts(live);
        const billed = disjointCounts(measured);
        return TOKEN_FIELDS.every((field) => observed[field] <= billed[field]);
      }),
  };
}

/** Each segment's usage comes from one source, so segments add without matching across sources. */
export function claudeTurnTokenUsage(
  segments: ReadonlyArray<ClaudeSegmentUsage>,
  turn: {
    readonly hasSubagents: boolean;
    readonly status: RuntimeTurnState | "running";
    // Models on the turn's root assistant messages; without any, the main rows' models.
    readonly rootModels?: ReadonlySet<string>;
  },
): TurnTokenUsage {
  const last = segments.at(-1);
  const measured = normalizeClaudeMainAgentTokenUsage(
    { subtype: last?.subtype, is_error: last?.isError, usage: last?.mainUsage },
    turn.hasSubagents,
    turn.status,
    segments.slice(0, -1).map((segment) => segment.mainUsage),
  );
  const main =
    measured.usageStatus === "complete" && segments.some((segment) => !segment.mainComplete)
      ? { ...measured, usageStatus: "partial" as const }
      : measured;
  const mainAgentUsage = modelRows(totalsByModel(segments.flatMap((segment) => segment.mainRows)));
  const subagentUsage = modelRows(
    totalsByModel(segments.flatMap((segment) => segment.delegateRows)),
  );
  const otherUsages = segments.flatMap((segment) =>
    segment.otherUsage === undefined ? [] : [segment.otherUsage],
  );
  const models =
    turn.rootModels !== undefined && turn.rootModels.size > 0
      ? turn.rootModels
      : new Set(mainAgentUsage.map((usage) => usage.model));
  const observedFields = {
    ...(models.size > 0 ? { models: [...models] } : {}),
    ...(last?.localCommand === true ? { localCommand: true } : {}),
    ...(otherUsages.length > 0 && otherUsages.length === segments.length
      ? {
          otherUsage: {
            inputTokens: otherUsages.reduce((sum, usage) => sum + usage.inputTokens, 0),
            outputTokens: otherUsages.reduce((sum, usage) => sum + usage.outputTokens, 0),
          },
        }
      : {}),
    // One row still needs its model once the main agent ran several, or it is priced as one.
    ...(mainAgentUsage.length > 1 || (mainAgentUsage.length === 1 && models.size > 1)
      ? { mainAgentUsage }
      : {}),
    ...(subagentUsage.length === 0 ? {} : { subagentUsage }),
    ...(segments.some((segment) => !segment.delegatesMeasured)
      ? { otherUsageStatus: "partial" as const }
      : {}),
  };
  // Native subagents and workflows can bill a turn whose main agent reported nothing.
  return main.usageStatus === "unavailable" && subagentUsage.length > 0
    ? { ...main, ...observedFields, usageStatus: "partial" }
    : { ...main, ...observedFields };
}

/** The settled fold with the open segment closed as if it had no result. */
export function liveClaudeTurnTokenUsage(input: {
  readonly sealedSegments?: ReadonlyArray<ClaudeSegmentUsage>;
  readonly mainMessages: ReadonlyMap<string, TurnModelTokenUsage>;
  readonly subagentMessages: ReadonlyMap<string, TurnModelTokenUsage>;
  readonly hasSubagents: boolean;
  readonly ledgerModelNames?: ReadonlyMap<string, string>;
  readonly rootModels?: ReadonlySet<string>;
}): TurnTokenUsage | undefined {
  const open = sealClaudeSegment(input);
  const usage = claudeTurnTokenUsage(
    [
      ...(input.sealedSegments ?? []),
      // The open segment's ledger is not due yet; only delegate frames seen so far make it a floor.
      { ...open, delegatesMeasured: open.delegateRows.length === 0 },
    ],
    {
      hasSubagents: input.hasSubagents,
      status: "running",
      ...(input.rootModels === undefined ? {} : { rootModels: input.rootModels }),
    },
  );
  return usage.usageStatus === "unavailable" ? undefined : usage;
}

function normalizeClaudeMainAgentTokenUsage(
  result: ClaudeSegmentResult | undefined,
  hasSubagents: boolean,
  terminalStatus: RuntimeTurnState | "running",
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
    hasValidSuccessUsage(result) &&
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
