import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { useGT } from "gt-react";
import { Minimize2Icon } from "lucide-react";

import { formatContextWindowTokens } from "~/lib/contextWindow";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { composerFloatingLayerProps } from "./composerEventScope";
import { ComposerControl, type ComposerControlSize } from "./ComposerControl";
import { formatContextWindowCost } from "./ContextWindowMeter.logic";
import { formatContextWindowCompactionMessage } from "./compaction.logic";

function formatPercentage(value: number | null): string | null {
  if (value === null || !Number.isFinite(value)) {
    return null;
  }
  if (value < 10) {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  return `${Math.round(value)}%`;
}

/** The composer's context window ring (`composerMeter: "ring"`); its card holds the numbers. */
export function ContextWindowMeter(props: {
  usage: ContextWindowSnapshot;
  size?: ComposerControlSize;
  onCompact?: (() => void) | undefined;
  compactDisabled?: boolean | undefined;
}) {
  const { usage, size = "row", onCompact, compactDisabled } = props;
  const gt = useGT();
  const usedPercentage = formatPercentage(usage.usedPercentage);
  const normalizedPercentage = Math.max(0, Math.min(100, usage.usedPercentage ?? 0));
  const radius = 9.75;
  const circumference = 2 * Math.PI * radius;
  const dashOffset = circumference * (1 - normalizedPercentage / 100);
  const totalProcessedTokens = usage.totalProcessedTokens ?? null;
  const showTotalProcessed = totalProcessedTokens !== null && totalProcessedTokens > 0;
  const isOverloaded = normalizedPercentage > 90;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={onCompact ? 150 : 0}
        render={
          <ComposerControl
            size={size}
            className="w-7 px-0 data-popup-open:bg-accent"
            data-chat-context-meter="true"
            aria-label={
              usage.maxTokens !== null && usedPercentage
                ? gt("Context window {percentage} used", { percentage: usedPercentage })
                : gt("Context window {tokens} tokens used", {
                    tokens: formatContextWindowTokens(usage.usedTokens),
                  })
            }
          >
            <span className="relative flex size-5 items-center justify-center">
              <svg
                viewBox="0 0 24 24"
                className="absolute inset-0 size-full -rotate-90 transform-gpu"
                aria-hidden="true"
              >
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  className="stroke-muted-foreground/24"
                  strokeWidth="3"
                />
                <circle
                  cx="12"
                  cy="12"
                  r={radius}
                  fill="none"
                  strokeWidth="3"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={dashOffset}
                  className={
                    isOverloaded
                      ? "stroke-error transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                      : "stroke-muted-foreground/72 transition-[stroke-dashoffset] duration-500 ease-out motion-reduce:transition-none"
                  }
                />
              </svg>
            </span>
          </ComposerControl>
        }
      />
      <PopoverPopup
        {...composerFloatingLayerProps}
        tooltipStyle
        side="top"
        align="end"
        padding="none"
        width="sm"
        className="text-left whitespace-normal"
      >
        <div className="flex flex-col gap-2 p-(--floating-content-inset)">
          <div className="flex items-center justify-between gap-3">
            <div className="font-medium text-muted-foreground text-xs">{gt("Context window")}</div>
            {usage.maxTokens !== null && usedPercentage ? (
              <div className="text-secondary-label text-2xs tabular-nums">
                <span>{usedPercentage}</span>
                <span className="mx-1">·</span>
                <span>
                  {formatContextWindowTokens(usage.usedTokens)}/
                  {formatContextWindowTokens(usage.maxTokens ?? null)}
                </span>
              </div>
            ) : (
              <div className="text-secondary-label text-2xs tabular-nums">
                {formatContextWindowTokens(usage.usedTokens)}
              </div>
            )}
          </div>
          {usage.maxTokens !== null ? (
            <div
              className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60"
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(normalizedPercentage)}
              aria-label={gt("Context window usage")}
            >
              <div
                className={
                  isOverloaded
                    ? "h-full rounded-full bg-error transition-[width] duration-500 ease-out motion-reduce:transition-none"
                    : "h-full rounded-full bg-muted-foreground/72 transition-[width] duration-500 ease-out motion-reduce:transition-none"
                }
                style={{ width: `${normalizedPercentage}%` }}
              />
            </div>
          ) : null}
          {showTotalProcessed ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">{gt("Total processed")}</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowTokens(totalProcessedTokens)}
              </span>
            </div>
          ) : null}
          {usage.cost != null ? (
            <div className="flex items-center justify-between gap-3 text-2xs leading-4">
              <span className="text-secondary-label">{gt("Cost")}</span>
              <span className="font-medium tabular-nums text-secondary-label">
                {formatContextWindowCost(usage.cost)}
              </span>
            </div>
          ) : null}
          {usage.compactsAutomatically ? (
            <div className="mt-1 text-pretty text-secondary-label text-2xs font-medium">
              {formatContextWindowCompactionMessage(usage.autoCompactThreshold)}
            </div>
          ) : null}
          {onCompact ? (
            <Button
              size="xs"
              variant="outline"
              className="mt-1 w-full justify-center"
              disabled={compactDisabled}
              onClick={onCompact}
            >
              <Minimize2Icon aria-hidden="true" />
              {gt("Compact context")}
            </Button>
          ) : null}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
