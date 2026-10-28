import {
  splitCompactLabel,
  type AgentTrajectorySummary,
} from "@t3tools/client-runtime/work-log/trajectory-summary";

import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "../ui/popover";

export function AgentTrajectorySegments({ summary }: { summary: AgentTrajectorySummary }) {
  return summary.map((segment) => {
    const labelParts = splitCompactLabel(segment.label);
    return (
      <span key={segment.kind} className="inline-flex items-center gap-1">
        <span aria-hidden="true" className="text-muted-foreground/60">
          ·
        </span>
        <Popover>
          <PopoverTrigger
            openOnHover
            delay={150}
            closeDelay={150}
            render={
              <button
                type="button"
                aria-label={segment.label}
                data-scroll-anchor-ignore
                className="cursor-pointer rounded-md px-1 text-sm leading-relaxed text-muted-foreground tabular-nums transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/70"
              />
            }
          >
            {labelParts ? (
              <>
                <span className="hidden @[34rem]/turn-fold:inline">{labelParts.prefix}</span>
                {labelParts.value}
              </>
            ) : (
              segment.label
            )}
          </PopoverTrigger>
          <PopoverPopup side="top" align="start" width="sm" padding="compact" touchBackdrop>
            <PopoverTitle>{segment.title}</PopoverTitle>
            <ul className="mt-2 max-h-64 space-y-1 overflow-y-auto text-xs text-muted-foreground">
              {segment.details.map((detail) => (
                <li key={detail} className="break-words [overflow-wrap:anywhere]">
                  {detail}
                </li>
              ))}
            </ul>
          </PopoverPopup>
        </Popover>
      </span>
    );
  });
}
