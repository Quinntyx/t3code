import { RefreshCwIcon } from "lucide-react";
import type { ReactNode } from "react";

import { useExitTransition } from "../../hooks/useExitTransition";
import { threadSyncLabel, type ThreadSyncPhase } from "../../threadSync";
import { cn } from "~/lib/utils";
import { useMessages } from "gt-react";

/** A line of thread state for the end of the timeline. */
export interface ThreadNowItem {
  readonly id: string;
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
}

/** Matches ThreadStatusLine, so every line at the end of the timeline reads as one family. */
const lineClassName = cn(
  "mx-auto flex w-full min-w-0 max-w-(--chat-content-max-width) items-center gap-1.5 px-1 pb-2 text-xs text-muted-foreground [&_svg]:size-3.5 [&_svg]:shrink-0",
  // Inline actions keep their text size but get a finger-sized hit area on touch.
  "pointer-coarse:[&_[data-slot=inline-button]]:relative pointer-coarse:[&_[data-slot=inline-button]]:after:absolute pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-x-1.5 pointer-coarse:[&_[data-slot=inline-button]]:after:-inset-y-3.5",
  "transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none",
);

type ExitProps = ReturnType<typeof useExitTransition>["exitProps"];

/** One line of thread state at the end of the timeline: icon, title, detail, then actions. */
function ThreadNowLine({
  item,
  exitProps,
  announce = false,
}: {
  readonly item: ThreadNowItem;
  readonly exitProps: ExitProps;
  /** Announces the line when it appears; only for something that needs the user. */
  readonly announce?: boolean;
}) {
  return (
    <div
      role={announce ? "alert" : undefined}
      data-side="top"
      {...exitProps}
      className={cn(lineClassName, "items-baseline")}
      data-thread-now-line="true"
    >
      <span aria-hidden className="flex size-3.5 shrink-0 self-center items-center justify-center">
        {item.icon}
      </span>
      <span className="min-w-0 truncate">
        {item.title}
        {item.description ? (
          <>
            {" "}
            <span className="ms-0.5 text-muted-foreground/60 light:text-muted-foreground/80">
              {item.description}
            </span>
          </>
        ) : null}
      </span>
      {item.actions ? (
        <span className="ms-1.5 flex shrink-0 items-baseline gap-2.5">{item.actions}</span>
      ) : null}
    </div>
  );
}

function ThreadSyncLine({
  phase,
  exitProps,
}: {
  readonly phase: ThreadSyncPhase;
  readonly exitProps: ExitProps;
}) {
  const m = useMessages();
  return (
    <div
      className={lineClassName}
      role="status"
      data-composer-sync-status={phase}
      data-side="top"
      {...exitProps}
    >
      <RefreshCwIcon aria-hidden />
      <span className="truncate">{threadSyncLabel(phase, m)}</span>
    </div>
  );
}

/**
 * What the thread is doing now, at the end of the timeline: what needs you, background work,
 * the sync status while messages load, then the goal.
 */
export function ThreadNow({
  attention,
  work,
  syncPhase,
  goal,
}: {
  /** Something that needs you elsewhere, such as a subagent's question. */
  readonly attention: ThreadNowItem | null;
  readonly work: ThreadNowItem | null;
  readonly syncPhase: ThreadSyncPhase | null;
  readonly goal: ThreadNowItem | null;
}): ReactNode {
  const shownAttention = useExitTransition(attention);
  const shownWork = useExitTransition(work);
  const shownSync = useExitTransition(syncPhase);
  const shownGoal = useExitTransition(goal);
  return (
    <>
      {shownAttention.shown ? (
        <ThreadNowLine
          item={shownAttention.shown}
          exitProps={shownAttention.exitProps}
          announce={!shownAttention.exiting}
        />
      ) : null}
      {shownWork.shown ? (
        <ThreadNowLine item={shownWork.shown} exitProps={shownWork.exitProps} />
      ) : null}
      {shownSync.shown ? (
        <ThreadSyncLine phase={shownSync.shown} exitProps={shownSync.exitProps} />
      ) : null}
      {shownGoal.shown ? (
        <ThreadNowLine item={shownGoal.shown} exitProps={shownGoal.exitProps} />
      ) : null}
    </>
  );
}
