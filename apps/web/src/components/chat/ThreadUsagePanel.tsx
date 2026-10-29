import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveModelShortName } from "@t3tools/client-runtime/provider-clients";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import type {
  EnvironmentId,
  ProviderDriverKind,
  ServerProvider,
  ThreadId,
  ThreadUsageGroup,
  ThreadUsageModel,
} from "@t3tools/contracts";
import { formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { ChevronDownIcon, GaugeIcon, UsersIcon } from "lucide-react";
import { useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import {
  deriveProviderInstanceEntries,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useQuietThreadShell } from "../../state/entities";
import { useEnvironmentQuery } from "../../state/query";
import { revisionedQuery } from "../../state/revisionedQuery";
import { serverEnvironment } from "../../state/server";
import { formatDayAwareTimestamp, formatShortTimestamp } from "../../timestampFormat";
import { ThreadUsageChart, type ThreadUsageChartSeries } from "../usage/ThreadUsageChart";
import { PROVIDER_PRESENTATION } from "../usage/usageProviders";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import { ThreadDetailsControl } from "./ThreadDetailsControl";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  THREAD_DETAILS_PANEL_CHEVRON_CLASS,
  THREAD_DETAILS_PANEL_ICON_CLASS,
  THREAD_DETAILS_PANEL_LABEL_CLASS,
  THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS,
} from "./threadDetailsPanelStyles";

const EMPTY_PROVIDERS: ReadonlyArray<ServerProvider> = [];
const GROUP_LABEL: Record<ThreadUsageGroup, string> = {
  main: "Main agent",
  delegates: "Delegates",
};

function providerColor(driver: ProviderDriverKind): string {
  return (
    Object.values(PROVIDER_PRESENTATION).find((entry) => entry.driverKind === driver)?.color ??
    "var(--muted-foreground)"
  );
}

/** Unpriced models leave the sum short, so it reads as a floor. */
function costLabel(models: ReadonlyArray<Pick<ThreadUsageModel, "costUsd">>): string | null {
  const priced = models.filter((model) => model.costUsd !== null);
  if (priced.length === 0) return null;
  const total = formatUsd(priced.reduce((sum, model) => sum + (model.costUsd ?? 0), 0));
  return priced.length < models.length ? `${total}+` : total;
}

function UsageFigures({ models }: { readonly models: ReadonlyArray<ThreadUsageModel> }) {
  const cost = costLabel(models);
  return (
    <span className="flex shrink-0 items-center gap-0.5 text-xs font-normal tabular-nums">
      <span className="text-foreground/85">
        {formatTokens(models.reduce((sum, model) => sum + model.totalTokens, 0))}
      </span>
      {cost === null ? null : <span className="text-muted-foreground">· {cost}</span>}
    </span>
  );
}

interface ModelPresentation {
  readonly label: string;
  readonly color: string;
  readonly entry: ProviderInstanceEntry | undefined;
  readonly showBadge: boolean;
}

function ModelIcon({
  model,
  presentation,
  size = "default",
}: {
  readonly model: Pick<ThreadUsageModel, "driver">;
  readonly presentation: ModelPresentation;
  readonly size?: "default" | "compact";
}) {
  return (
    <ProviderInstanceIcon
      driverKind={model.driver}
      displayName={presentation.entry?.displayName ?? model.driver}
      accentColor={presentation.entry?.accentColor}
      acpRegistryIconUrl={presentation.entry?.acpRegistryIconUrl}
      showBadge={size === "default" && presentation.showBadge}
      size={size}
      iconClassName={size === "compact" ? "size-3" : "size-4"}
    />
  );
}

/** A group naming its one model, or "Mixed" with a breakdown when it ran several. */
function UsageGroupRow({
  group,
  models,
  present,
  open,
  onToggle,
}: {
  readonly group: ThreadUsageGroup;
  readonly models: ReadonlyArray<ThreadUsageModel>;
  readonly present: (model: ThreadUsageModel) => ModelPresentation;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  const [first] = models;
  if (first === undefined) return null;
  const mixed = models.length > 1;
  const label = (
    <span
      className={cn("flex min-w-0 flex-1 items-center gap-0.5", THREAD_DETAILS_PANEL_LABEL_CLASS)}
    >
      <span className="shrink-0">{GROUP_LABEL[group]}</span>
      <span
        className={cn("text-xs font-normal text-muted-foreground", mixed ? "shrink-0" : "truncate")}
      >
        ({mixed ? "Mixed" : present(first).label})
      </span>
      {mixed ? (
        <ChevronDownIcon
          aria-hidden
          className={cn(THREAD_DETAILS_PANEL_CHEVRON_CLASS, "size-3", open && "rotate-180")}
        />
      ) : null}
    </span>
  );
  const icon =
    group === "delegates" && mixed ? (
      <UsersIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
    ) : mixed ? (
      <span aria-hidden className="relative size-4 shrink-0">
        {models.slice(0, 2).map((model, index) => (
          <span
            key={`${model.providerInstanceId}:${model.model}`}
            className={cn("absolute", index === 0 ? "start-0 top-0" : "end-0 bottom-0")}
          >
            <ModelIcon model={model} presentation={present(model)} size="compact" />
          </span>
        ))}
      </span>
    ) : (
      <ModelIcon model={first} presentation={present(first)} />
    );

  return (
    <>
      {mixed ? (
        <ThreadDetailsControl
          variant="ghost"
          size="sm"
          part="row"
          aria-expanded={open}
          onClick={onToggle}
        >
          {icon}
          {label}
          <UsageFigures models={models} />
        </ThreadDetailsControl>
      ) : (
        <div className={cn(THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, "flex items-center")}>
          {icon}
          {label}
          <UsageFigures models={models} />
        </div>
      )}
      {mixed && open ? (
        <ul className="m-0 mb-1 list-none p-0">
          {models.map((model) => {
            const presentation = present(model);
            return (
              <li
                key={`${model.providerInstanceId}:${model.model}`}
                className="flex h-7 min-w-0 items-center gap-2.5 ps-9 pe-2.5 text-xs text-foreground/80"
              >
                <ModelIcon model={model} presentation={presentation} />
                <span className="min-w-0 flex-1 truncate">
                  {presentation.label}
                  {group === "delegates" && model.threads > 1 ? (
                    <span className="text-muted-foreground"> ×{model.threads}</span>
                  ) : null}
                </span>
                <UsageFigures models={[model]} />
              </li>
            );
          })}
        </ul>
      ) : null}
    </>
  );
}

/** Tokens and API-list cost the thread and its delegates used, over wall-clock time. */
export function ThreadUsagePanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const threadRef = scopeThreadRef(props.environmentId, props.threadId);
  const shell = useQuietThreadShell(threadRef);
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ?? EMPTY_PROVIDERS;
  const [open, setOpen] = useState<ReadonlySet<ThreadUsageGroup>>(() => new Set());
  // Delegates report back through the parent's runs, so its run state is enough to refetch on.
  const revision =
    shell === null
      ? undefined
      : [
          shell.latestRun?.runId,
          shell.latestRun?.status,
          shell.latestRun?.completedAt,
          shell.runtime?.status,
        ].join(":");
  const { data } = useEnvironmentQuery(
    revisionedQuery(
      serverEnvironment.threadUsage({
        environmentId: props.environmentId,
        input: { threadId: props.threadId },
      }),
      revision,
    ),
  );
  if (data === null || data.startedAt === null || data.models.length === 0) return null;

  const entries = deriveProviderInstanceEntries(providers);
  const present = (
    model: Pick<ThreadUsageModel, "providerInstanceId" | "driver" | "model">,
  ): ModelPresentation => {
    const entry = entries.find((candidate) => candidate.instanceId === model.providerInstanceId);
    const provider = providers.find(
      (candidate) => candidate.instanceId === model.providerInstanceId,
    );
    // A model missing from the catalog, as on a removed account, still drops its family prefix.
    const label = resolveSubagentMetadata({ model: model.model, provider }).modelLabel;
    return {
      label: resolveModelShortName({ name: label }, model.driver) ?? label,
      color: entry?.accentColor ?? providerColor(model.driver),
      entry,
      showBadge:
        entry !== undefined &&
        entry.accentColor !== undefined &&
        shouldShowInstanceBadge(entry, entries),
    };
  };
  const byTokens = (left: ThreadUsageModel, right: ThreadUsageModel) =>
    right.totalTokens - left.totalTokens;
  const groupModels = (group: ThreadUsageGroup) =>
    data.models.filter((model) => model.group === group).toSorted(byTokens);
  const series: ThreadUsageChartSeries[] = data.series.map((entry) => {
    const presentation = present(entry);
    return {
      key: `${entry.providerInstanceId}:${entry.model}`,
      label: presentation.label,
      color: presentation.color,
      icon: <ModelIcon model={entry} presentation={presentation} size="compact" />,
      buckets: entry.buckets,
    };
  });
  const toggle = (group: ThreadUsageGroup) =>
    setOpen((current) => {
      const next = new Set(current);
      if (!next.delete(group)) next.add(group);
      return next;
    });

  return (
    <ThreadDetailsSection
      headingId="thread-details-usage-heading"
      title="Usage"
      showHeading={false}
    >
      <div className="flex flex-col">
        <div className={cn(THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, "flex items-center")}>
          <GaugeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className={cn("flex-1", THREAD_DETAILS_PANEL_LABEL_CLASS)}>Usage</span>
          <UsageFigures models={data.models} />
        </div>
        <div className="px-2.5 pt-1 pb-2">
          <ThreadUsageChart
            series={series}
            startedAt={data.startedAt}
            bucketMs={data.bucketMs}
            compactedAt={data.compactedAt}
            endLabel={shell?.runtime?.activeRunId ? "Now" : null}
            formatTime={(iso) => formatShortTimestamp(iso, timestampFormat)}
            formatTooltipTime={(iso) => formatDayAwareTimestamp(iso, timestampFormat)}
          />
        </div>
        {(["main", "delegates"] as const).map((group) => (
          <UsageGroupRow
            key={group}
            group={group}
            models={groupModels(group)}
            present={present}
            open={open.has(group)}
            onToggle={() => toggle(group)}
          />
        ))}
      </div>
    </ThreadDetailsSection>
  );
}
