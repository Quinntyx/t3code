import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationOperateScope } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveModelShortName } from "@t3tools/client-runtime/provider-clients";
import { resolveSubagentMetadata } from "@t3tools/client-runtime/state/subagent-display";
import type {
  EnvironmentId,
  ProviderDriverKind,
  ServerProvider,
  ServerProviderUsageWindow,
  ThreadConsumptionCap,
  ThreadConsumptionCapCondition,
  ThreadConsumptionCapHit,
  ThreadId,
  ThreadUsageGroup,
  ThreadUsageModel,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { formatThreadUsageCost, formatTokens, formatUsd } from "@t3tools/shared/usageFormat";
import { ChevronDownIcon, GaugeIcon, UsersIcon } from "lucide-react";
import { type MouseEvent, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { useThreadUsage } from "../../hooks/useThreadUsage";
import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import {
  deriveProviderInstanceEntries,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { formatDayAwareTimestamp, formatShortTimestamp } from "../../timestampFormat";
import { ThreadUsageChart, type ThreadUsageChartSeries } from "../usage/ThreadUsageChart";
import { PROVIDER_PRESENTATION } from "../usage/usageProviders";
import { toastManager } from "../ui/toast";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";
import {
  ThreadConsumptionCapDialog,
  type ThreadConsumptionCapRow,
} from "./ThreadConsumptionCapDialog";
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

const WINDOW_KIND_LABEL = {
  session: "5h",
  weekly: "Weekly",
  monthly: "Monthly",
  other: "Window",
} as const;

function isFiveHourOrWeekly(window: ServerProviderUsageWindow): boolean {
  return (
    window.kind === "session" ||
    window.kind === "weekly" ||
    window.windowDurationMins === 300 ||
    window.windowDurationMins === 10_080
  );
}

function consumptionCapConditionLabel(condition: ThreadConsumptionCapCondition): string {
  const models = condition.models?.length;
  if (condition.kind === "spend") {
    const amount = formatUsd(condition.limitUsd);
    return models === undefined
      ? `${amount} total`
      : `${amount} · ${models} model${models === 1 ? "" : "s"}`;
  }
  const window = `${WINDOW_KIND_LABEL[condition.windowKind]} ${condition.atPercent}%`;
  return models === undefined ? window : `${window} · ${models} model${models === 1 ? "" : "s"}`;
}

function consumptionCapSummary(
  cap: ThreadConsumptionCap | null,
  hit: ThreadConsumptionCapHit | null,
): string {
  if (hit !== null) return hit.reason;
  if (cap === null) return "Right-click to set a cap";
  const [first] = cap.conditions;
  if (first === undefined) return "No limits";
  const more = cap.conditions.length > 1 ? ` +${cap.conditions.length - 1}` : "";
  return `${consumptionCapConditionLabel(first)}${more}`;
}

function providerColor(driver: ProviderDriverKind): string {
  return (
    Object.values(PROVIDER_PRESENTATION).find((entry) => entry.driverKind === driver)?.color ??
    "var(--muted-foreground)"
  );
}

function UsageFigures({ models }: { readonly models: ReadonlyArray<ThreadUsageModel> }) {
  const cost = formatThreadUsageCost(models);
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
  const { data, shell } = useThreadUsage(threadRef);
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const providers =
    useAtomValue(serverEnvironment.providersValueAtom(props.environmentId)) ?? EMPTY_PROVIDERS;
  const [open, setOpen] = useState<ReadonlySet<ThreadUsageGroup>>(() => new Set());
  const [capOpen, setCapOpen] = useState(false);
  const canOperate = useEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    reportFailure: false,
  });
  if (data === null) return null;
  const hasUsage = data.startedAt !== null && data.models.length > 0;

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
  const cap = shell?.consumptionCap ?? null;
  const capHit = shell?.consumptionCapHit ?? null;
  const usageWindows = (providerInstanceId: string): ReadonlyArray<ServerProviderUsageWindow> =>
    (
      providers.find((provider) => provider.instanceId === providerInstanceId)?.usageLimits
        ?.windows ?? []
    ).filter(isFiveHourOrWeekly);
  const capRows: ThreadConsumptionCapRow[] = (() => {
    const rows = new Map<
      string,
      {
        readonly model: Pick<ThreadUsageModel, "providerInstanceId" | "driver" | "model">;
        costUsd: number | null;
      }
    >();
    for (const model of data.models) {
      const key = `${model.providerInstanceId}\u0000${model.model}`;
      const existing = rows.get(key);
      if (existing === undefined) {
        rows.set(key, { model, costUsd: model.costUsd });
      } else if (existing.costUsd !== null || model.costUsd !== null) {
        existing.costUsd = (existing.costUsd ?? 0) + (model.costUsd ?? 0);
      }
    }
    for (const condition of cap?.conditions ?? []) {
      for (const model of condition.models ?? []) {
        const key = `${model.providerInstanceId}\u0000${model.model}`;
        if (!rows.has(key)) rows.set(key, { model, costUsd: null });
      }
    }
    if (rows.size === 0 && shell !== null) {
      const provider = providers.find(
        (candidate) => candidate.instanceId === shell.modelSelection.instanceId,
      );
      if (provider !== undefined) {
        rows.set(`${provider.instanceId}\u0000${shell.modelSelection.model}`, {
          model: {
            providerInstanceId: provider.instanceId,
            driver: provider.driver,
            model: shell.modelSelection.model,
          },
          costUsd: null,
        });
      }
    }
    return [...rows.entries()].map(([key, { model, costUsd }]) => {
      const presentation = present(model);
      return {
        key,
        providerInstanceId: model.providerInstanceId,
        driver: model.driver,
        model: model.model,
        label: presentation.label,
        costUsd,
        windows: usageWindows(model.providerInstanceId),
      };
    });
  })();
  const handleContextMenu = (event: MouseEvent<HTMLElement>) => {
    if (!canOperate) return;
    const api = readLocalApi();
    if (!api) return;
    event.preventDefault();
    event.stopPropagation();
    const items = [
      {
        id: "edit" as const,
        label: cap === null ? "Set consumption cap…" : "Edit consumption cap…",
      },
      ...(cap === null
        ? []
        : [{ id: "remove" as const, label: "Remove consumption cap", destructive: true }]),
    ];
    void api.contextMenu.show(items, { x: event.clientX, y: event.clientY }).then((action) => {
      if (action === "edit") setCapOpen(true);
      if (action !== "remove") return;
      void updateMetadata({
        environmentId: props.environmentId,
        input: { threadId: props.threadId, consumptionCap: null },
      }).then((result) => {
        if (result._tag === "Success") return;
        const cause = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not remove consumption cap",
          description: cause instanceof Error ? cause.message : "An error occurred.",
        });
      });
    });
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
      onContextMenu={handleContextMenu}
    >
      <div className="flex flex-col">
        <div className={cn(THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, "flex items-center")}>
          <GaugeIcon aria-hidden className={THREAD_DETAILS_PANEL_ICON_CLASS} />
          <span className={cn("flex-1", THREAD_DETAILS_PANEL_LABEL_CLASS)}>Usage</span>
          {hasUsage ? (
            <UsageFigures models={data.models} />
          ) : (
            <span className="text-xs text-muted-foreground">No usage yet</span>
          )}
        </div>
        {hasUsage && data.startedAt !== null ? (
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
        ) : null}
        <div
          className={cn(THREAD_DETAILS_PANEL_LOCKED_ROW_CLASS, "flex min-w-0 items-center")}
          onContextMenu={handleContextMenu}
        >
          <GaugeIcon
            aria-hidden
            className={cn(THREAD_DETAILS_PANEL_ICON_CLASS, capHit !== null && "text-warning")}
          />
          <span className={cn("flex-1", THREAD_DETAILS_PANEL_LABEL_CLASS)}>Cap</span>
          <span
            className={cn(
              "min-w-0 max-w-[62%] truncate text-xs tabular-nums",
              capHit !== null ? "text-warning" : "text-muted-foreground",
            )}
          >
            {consumptionCapSummary(cap, capHit)}
          </span>
        </div>
        {hasUsage
          ? (["main", "delegates"] as const).map((group) => (
              <UsageGroupRow
                key={group}
                group={group}
                models={groupModels(group)}
                present={present}
                open={open.has(group)}
                onToggle={() => toggle(group)}
              />
            ))
          : null}
      </div>
      <ThreadConsumptionCapDialog
        open={capOpen}
        onOpenChange={setCapOpen}
        environmentId={props.environmentId}
        threadId={props.threadId}
        cap={cap}
        rows={capRows}
      />
    </ThreadDetailsSection>
  );
}
