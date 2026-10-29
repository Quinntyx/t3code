import type { ServerProvider } from "@t3tools/contracts";
import {
  type LimitPace,
  type ProviderLimitsSummary,
  type ProviderLimitWindow,
  formatDuration,
} from "@t3tools/shared/usageLimits";
import { Fragment, type ReactNode } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { barColor, resetCreditsSummary, usePaceMark } from "../usage/UsageLimits";

const LOW_REMAINING_PERCENT = 25;

const PACE_LABEL: Record<LimitPace, string> = {
  ahead: "Ahead of pace",
  on: "On pace",
  under: "Under pace",
};

function shortWindowLabel(window: ProviderLimitWindow): string {
  if (window.kind === "weekly") return "Wk";
  if (window.kind === "monthly") return "Mo";
  const minutes = window.windowDurationMins;
  if (window.kind === "session" && minutes && minutes % 60 === 0 && minutes <= 24 * 60) {
    return `${minutes / 60}h`;
  }
  return window.label;
}

function Row({ label, children }: { readonly label: string; readonly children: ReactNode }) {
  return (
    <div className="grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-3">
      <span className="text-muted-foreground">{label}</span>
      <span className="min-w-0 text-foreground tabular-nums">{children}</span>
    </div>
  );
}

function LimitDetails({
  title,
  window,
  now,
}: {
  readonly title: string;
  readonly window: ProviderLimitWindow;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const pooled = window.accounts > 1;
  const resetsIn = window.resetsAt ? formatDuration(Date.parse(window.resetsAt) - now) : null;
  return (
    <div className="flex w-60 flex-col gap-2 py-1 text-xs">
      <span className="font-medium text-foreground">{title}</span>
      <div className="flex flex-col gap-1 border-t border-border/60 pt-2">
        <Row label="Left">
          {window.remainingPercent}%{pooled ? " of pool" : ""}
        </Row>
        {pooled ? (
          <Row label="Accounts">
            {window.readyAccounts} of {window.accounts} ready
          </Row>
        ) : null}
        {window.resetsAt ? (
          <Row label={pooled ? "Next back" : "Resets"}>
            {pooled
              ? `in ${resetsIn}`
              : `${formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)} · in ${resetsIn}`}
            {pooled && window.restoresPercent ? ` · +${window.restoresPercent}% of pool` : ""}
          </Row>
        ) : null}
        {window.timeLeftPercent !== null ? (
          <Row label="Even pace">{window.timeLeftPercent}% left by now</Row>
        ) : null}
        {window.pace ? <Row label="Pace">{PACE_LABEL[window.pace]}</Row> : null}
      </div>
      {window.resetCredits ? (
        <div className="border-t border-border/60 pt-2 text-muted-foreground tabular-nums">
          {resetCreditsSummary(window.resetCredits, now)}
        </div>
      ) : null}
    </div>
  );
}

function LimitBar({
  title,
  window,
  color,
  now,
  onSelect,
}: {
  readonly title: string;
  readonly window: ProviderLimitWindow;
  readonly color: string;
  readonly now: number;
  readonly onSelect: () => void;
}) {
  const [barRef, paceMark] = usePaceMark(window.timeLeftPercent);
  const remaining = window.remainingPercent;
  return (
    <>
      <span className="truncate">{shortWindowLabel(window)}</span>
      <Tooltip trackCursorAxis="x">
        <TooltipTrigger
          render={
            <span
              ref={barRef}
              className="pointer-events-auto relative block h-5 min-w-0 cursor-pointer"
              onClick={onSelect}
            />
          }
        >
          {/* The clip cuts a gap around the pace tick, as in the limits viewer. */}
          <span aria-hidden className="absolute inset-0" style={paceMark?.gap}>
            <span className="absolute inset-x-0 inset-y-1 rounded-full bg-foreground/8" />
            {remaining > 0 ? (
              <span
                className="absolute inset-y-1 left-0 rounded-full"
                style={{ width: `${remaining}%`, backgroundColor: color }}
              />
            ) : null}
          </span>
          {paceMark ? (
            <span
              aria-hidden
              className="absolute inset-y-0.5 w-0.5 -translate-x-1/2 rounded-full bg-foreground"
              style={paceMark.tick}
            />
          ) : null}
        </TooltipTrigger>
        <TooltipPopup side="bottom" sideOffset={10} variant="glass" className="max-w-none">
          <LimitDetails title={title} window={window} now={now} />
        </TooltipPopup>
      </Tooltip>
      <span
        className={cn(
          "text-right font-semibold text-foreground/80 tabular-nums",
          remaining > 0 && remaining < LOW_REMAINING_PERCENT && "text-warning-foreground",
        )}
      >
        {remaining}%
      </span>
    </>
  );
}

export function ProviderLimitBars({
  summary,
  driver,
  providerName,
  now,
  onSelect,
}: {
  readonly summary: ProviderLimitsSummary;
  readonly driver: ServerProvider["driver"];
  readonly providerName: string;
  readonly now: number;
  readonly onSelect: () => void;
}) {
  const color = barColor(driver);
  const bars = (windows: readonly ProviderLimitWindow[], owner: string) =>
    windows.map((window) => (
      <LimitBar
        key={window.key}
        title={`${owner} · ${window.label}`}
        window={window}
        color={color}
        now={now}
        onSelect={onSelect}
      />
    ));
  return (
    <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_2.25rem] items-center gap-x-2 text-2xs text-muted-foreground">
      {bars(summary.windows, providerName)}
      {summary.sources.map((source) => (
        <Fragment key={source.id}>
          <span className="col-span-full mt-0.5 truncate">{source.label}</span>
          {bars(source.windows, source.label)}
        </Fragment>
      ))}
    </div>
  );
}

/** The bars are pointer-only, so the card's accessible name carries the same numbers. */
export function describeProviderLimits(summary: ProviderLimitsSummary): string {
  const describe = (windows: readonly ProviderLimitWindow[]) =>
    windows.map((window) => `${window.label} ${window.remainingPercent}% left`).join(", ");
  return [
    summary.exhausted ? "Limit reached" : null,
    summary.windows.length > 0 ? describe(summary.windows) : null,
    ...summary.sources.map((source) => `${source.label}: ${describe(source.windows)}`),
  ]
    .filter((part) => part !== null)
    .join("; ");
}
