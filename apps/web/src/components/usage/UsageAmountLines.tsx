import type { ServerProviderUsageAmountLine } from "@t3tools/contracts";
import { describeUsageAmount, formatResetsIn } from "@t3tools/shared/usageLimits";

import { cn } from "../../lib/utils";

/** Money a provider reports without an allowance, so it has no bar to draw. */
export function UsageAmountLines({
  amounts,
  now,
  className,
}: {
  readonly amounts: ReadonlyArray<ServerProviderUsageAmountLine>;
  readonly now: number;
  readonly className?: string;
}) {
  if (amounts.length === 0) return null;
  return (
    <div className={cn("flex min-w-0 flex-col gap-0.5 text-xs", className)}>
      {amounts.map((line) => {
        const { value, qualifier } = describeUsageAmount(line.amount);
        const resetsIn = formatResetsIn(line, now);
        return (
          <span key={line.id} className="flex min-w-0 flex-wrap items-baseline gap-x-1.5">
            <span className="truncate text-muted-foreground">{line.label}</span>
            <span className="font-medium text-foreground tabular-nums">{value}</span>
            <span className="text-muted-foreground">
              {qualifier}
              {resetsIn ? ` · ${resetsIn}` : ""}
            </span>
          </span>
        );
      })}
    </div>
  );
}
