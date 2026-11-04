import type { ServerProvider } from "@t3tools/contracts";
import type { ProviderLimitsSummary, ProviderLimitWindow } from "@t3tools/shared/usageLimits";
import { Fragment } from "react";

import { cn } from "../../lib/utils";
import { barColor, usePaceMark } from "../usage/UsageLimits";

const LOW_REMAINING_PERCENT = 25;

function shortWindowLabel(window: ProviderLimitWindow): string {
  if (window.kind === "weekly") return "Wk";
  if (window.kind === "monthly") return "Mo";
  const minutes = window.windowDurationMins;
  if (window.kind === "session" && minutes && minutes % 60 === 0 && minutes <= 24 * 60) {
    return `${minutes / 60}h`;
  }
  return window.label;
}

function LimitBar({
  window,
  color,
  onSelect,
}: {
  readonly window: ProviderLimitWindow;
  readonly color: string;
  readonly onSelect: () => void;
}) {
  const [barRef, paceMark] = usePaceMark(window.timeLeftPercent);
  const remaining = window.remainingPercent;
  return (
    <>
      <span className="truncate">{shortWindowLabel(window)}</span>
      <span
        ref={barRef}
        className="pointer-events-auto relative block h-5 min-w-0 cursor-pointer"
        onClick={onSelect}
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
      </span>
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
  onSelect,
}: {
  readonly summary: ProviderLimitsSummary;
  readonly driver: ServerProvider["driver"];
  readonly onSelect: () => void;
}) {
  const color = barColor(driver);
  const bars = (windows: readonly ProviderLimitWindow[]) =>
    windows.map((window) => (
      <LimitBar key={window.key} window={window} color={color} onSelect={onSelect} />
    ));
  return (
    <div className="grid grid-cols-[1.5rem_minmax(0,1fr)_2.25rem] items-center gap-x-2 text-2xs text-muted-foreground">
      {bars(summary.windows)}
      {summary.sources.map((source) => (
        <Fragment key={source.id}>
          <span className="col-span-full mt-0.5 truncate">{source.label}</span>
          {bars(source.windows)}
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
