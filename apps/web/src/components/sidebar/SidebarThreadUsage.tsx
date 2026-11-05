import { AuthDiagnosticsReadScope, type ScopedThreadRef } from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatThreadUsageCost } from "@t3tools/shared/usageFormat";
import { DollarSignIcon, TimerIcon } from "lucide-react";

import { useNowSecond } from "../../hooks/useNowSecond";
import { useThreadUsage } from "../../hooks/useThreadUsage";
import { useEnvironmentScope } from "../../state/session";

function RunningDuration(props: { durationMs: number; updatedAt: number }) {
  const nowMs = useNowSecond();
  return formatDuration(props.durationMs + Math.max(0, nowMs - props.updatedAt));
}

function ThreadUsageFigures({ threadRef }: { threadRef: ScopedThreadRef }) {
  const { data, dataUpdatedAt, shell } = useThreadUsage(threadRef);
  if (data === null) return null;
  const cost = formatThreadUsageCost(data.models);
  const status = shell?.latestRun?.status;
  const running = status === "starting" || status === "running" || status === "waiting";
  return (
    <>
      {data.durationMs !== undefined && data.durationMs > 0 ? (
        <div className="flex min-w-0 items-center gap-2">
          <TimerIcon aria-hidden className="size-3 shrink-0 stroke-muted-foreground" />
          <div className="text-foreground/75 tabular-nums">
            Worked for{" "}
            {running ? (
              <RunningDuration durationMs={data.durationMs} updatedAt={dataUpdatedAt} />
            ) : (
              formatDuration(data.durationMs)
            )}
          </div>
        </div>
      ) : null}
      {cost !== null ? (
        <div className="flex min-w-0 items-center gap-2">
          <DollarSignIcon aria-hidden className="size-3 shrink-0 stroke-muted-foreground" />
          <div className="text-foreground/75 tabular-nums">Usage {cost}</div>
        </div>
      ) : null}
    </>
  );
}

export function SidebarThreadUsage({ threadRef }: { threadRef: ScopedThreadRef }) {
  const canReadUsage = useEnvironmentScope(threadRef.environmentId, AuthDiagnosticsReadScope);
  return canReadUsage ? <ThreadUsageFigures threadRef={threadRef} /> : null;
}
