import { formatTokens } from "@t3tools/shared/usageFormat";
import { type ReactNode, useState } from "react";

import { curvePath, niceScale, smoothCurve } from "./usageChartGeometry";

const VIEW_WIDTH = 300;
const VIEW_HEIGHT = 80;
const PLOT_TOP = 4;
const TICK_COUNT = 2;

export interface ThreadUsageChartSeries {
  readonly key: string;
  readonly label: string;
  readonly color: string;
  readonly icon: ReactNode;
  readonly buckets: readonly number[];
}

/** Index ranges where a series has tokens, widened by a bucket so each line rises from zero. */
function activeSpans(buckets: readonly number[]): ReadonlyArray<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = [];
  let index = 0;
  while (index < buckets.length) {
    if ((buckets[index] ?? 0) === 0) {
      index += 1;
      continue;
    }
    let end = index;
    while (end < buckets.length && (buckets[end] ?? 0) > 0) end += 1;
    spans.push([Math.max(0, index - 1), Math.min(buckets.length - 1, end)]);
    index = end;
  }
  return spans;
}

function formatBucket(bucketMs: number): string {
  const minutes = Math.round(bucketMs / 60_000);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 24 ? `${hours} hr` : `${Math.round(hours / 24)} d`;
}

export function ThreadUsageChart({
  series,
  startedAt,
  bucketMs,
  compactedAt,
  endLabel,
  formatTime,
  formatTooltipTime,
}: {
  readonly series: readonly ThreadUsageChartSeries[];
  readonly startedAt: string;
  readonly bucketMs: number;
  readonly compactedAt: readonly string[];
  readonly endLabel: string | null;
  readonly formatTime: (iso: string) => string;
  readonly formatTooltipTime: (iso: string) => string;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const count = Math.max(2, ...series.map((entry) => entry.buckets.length));
  const peak = Math.max(0, ...series.flatMap((entry) => entry.buckets));
  const scale = niceScale(peak, TICK_COUNT);
  const stepX = VIEW_WIDTH / (count - 1);
  const toY = (value: number) =>
    scale.max === 0 ? VIEW_HEIGHT : VIEW_HEIGHT - (value / scale.max) * (VIEW_HEIGHT - PLOT_TOP);
  const startMs = Date.parse(startedAt);
  const bucketIso = (index: number) => new Date(startMs + index * bucketMs).toISOString();
  // Points sit at bucket centres in time, so an instant maps half a bucket earlier.
  const xAt = (iso: string) =>
    Math.min(count - 1, Math.max(0, (Date.parse(iso) - startMs) / bucketMs - 0.5)) * stepX;

  const paths = series.flatMap((entry) =>
    activeSpans(entry.buckets).map(([from, to]) => {
      const line = curvePath(
        smoothCurve(
          entry.buckets
            .slice(from, to + 1)
            .map((value, offset) => ({ x: (from + offset) * stepX, y: toY(value) })),
        ),
      );
      return {
        key: `${entry.key}:${from}`,
        color: entry.color,
        line,
        area: `${line} L${(to * stepX).toFixed(2)},${VIEW_HEIGHT} L${(from * stepX).toFixed(2)},${VIEW_HEIGHT} Z`,
      };
    }),
  );

  const handleMove = (event: React.MouseEvent<HTMLDivElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (bounds.width === 0) return;
    const fraction = Math.min(1, Math.max(0, (event.clientX - bounds.left) / bounds.width));
    setHover(Math.round(fraction * (count - 1)));
  };

  const middle = Math.floor((count - 1) / 2);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex gap-1.5">
        <div className="relative h-20 w-8 shrink-0">
          {scale.max > 0
            ? scale.ticks.map((tick) => (
                <span
                  key={tick}
                  className="absolute right-0 -translate-y-1/2 text-3xs text-muted-foreground tabular-nums"
                  style={{ top: `${(toY(tick) / VIEW_HEIGHT) * 100}%` }}
                >
                  {tick === 0 ? "0" : formatTokens(tick)}
                </span>
              ))
            : null}
        </div>
        {/* Liquid glass bends the timeline behind the card; a backing keeps the lines legible. */}
        <div
          className="relative h-20 min-w-0 flex-1 rounded-sm bg-popover/60"
          onMouseMove={handleMove}
          onMouseLeave={() => setHover(null)}
        >
          <svg
            className="h-full w-full overflow-visible"
            viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`Tokens per ${formatBucket(bucketMs)} by model`}
          >
            {scale.ticks.map((tick) => (
              <line
                key={tick}
                x1={0}
                x2={VIEW_WIDTH}
                y1={toY(tick)}
                y2={toY(tick)}
                stroke="currentColor"
                strokeWidth={1}
                className="text-border"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {compactedAt.map((iso) => (
              <line
                key={iso}
                x1={xAt(iso)}
                x2={xAt(iso)}
                y1={PLOT_TOP}
                y2={VIEW_HEIGHT}
                stroke="currentColor"
                strokeWidth={1}
                strokeDasharray="3 3"
                className="text-muted-foreground/70"
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {paths.map(({ key, color, area }) => (
              <path key={key} d={area} fill={color} fillOpacity={0.12} />
            ))}
            {paths.map(({ key, color, line }) => (
              <path
                key={key}
                d={line}
                fill="none"
                stroke={color}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {hover === null ? null : (
              <line
                x1={hover * stepX}
                x2={hover * stepX}
                y1={PLOT_TOP}
                y2={VIEW_HEIGHT}
                stroke="currentColor"
                strokeWidth={1}
                className="text-muted-foreground"
                vectorEffect="non-scaling-stroke"
              />
            )}
          </svg>
          {hover === null ? null : (
            // The card clips its overflow, so the fixed-width tooltip stays within the plot.
            <div
              className="surface-glass pointer-events-none absolute top-0 z-10 w-36 rounded-glass border border-border/50 px-2.5 py-2 text-xs shadow-lg"
              style={{
                left: `clamp(0px, calc(${(hover / (count - 1)) * 100}% - 4.5rem), calc(100% - 9rem))`,
              }}
            >
              <div className="mb-1 text-muted-foreground">
                {formatTooltipTime(bucketIso(hover))} · {formatBucket(bucketMs)}
              </div>
              {series.map((entry) => (
                <div key={entry.key} className="flex items-center justify-between gap-3">
                  <span className="flex min-w-0 items-center gap-1.5 text-muted-foreground">
                    {entry.icon}
                    <span className="truncate">{entry.label}</span>
                  </span>
                  <span className="text-foreground tabular-nums">
                    {formatTokens(entry.buckets[hover] ?? 0)}
                  </span>
                </div>
              ))}
              {series.length > 1 ? (
                <div className="mt-1 flex items-center justify-between gap-3 border-t border-border pt-1">
                  <span className="text-muted-foreground">Total</span>
                  <span className="text-foreground tabular-nums">
                    {formatTokens(
                      series.reduce((sum, entry) => sum + (entry.buckets[hover] ?? 0), 0),
                    )}
                  </span>
                </div>
              ) : null}
            </div>
          )}
        </div>
      </div>
      <div className="flex justify-between ps-9.5 text-3xs text-muted-foreground uppercase">
        <span>{formatTime(bucketIso(0))}</span>
        <span>{formatTime(bucketIso(middle))}</span>
        <span>{endLabel ?? formatTime(bucketIso(count - 1))}</span>
      </div>
    </div>
  );
}
