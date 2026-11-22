import { parseScopedThreadKey } from "@t3tools/client-runtime/environment";
import { threadOwnPullRequest } from "@t3tools/client-runtime/threadStacks";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { msg, useGT, useMessages } from "gt-react";

import { cn } from "~/lib/utils";
import { useThreadShell } from "../../state/entities";
import type { SidebarThreadSummary } from "../../types";
import { useUiStateStore } from "../../uiStateStore";
import {
  hasUnseenCompletion,
  resolveThreadLastVisitedAt,
  useSidebarThreadStatus,
  type SidebarThreadStatus,
} from "../Sidebar.logic";
import { PullRequestGlyph } from "../pullRequest/pullRequestIcons";
import { resolvePullRequestState } from "../pullRequest/pullRequestPresentation";

const STATUS_LABEL: Record<
  Exclude<SidebarThreadStatus, "ready">,
  { readonly label: string; readonly className: string }
> = {
  preparing: { label: msg("Setting up"), className: "text-info-foreground" },
  working: { label: msg("Working"), className: "text-info-foreground" },
  stalled: { label: msg("Stalled"), className: "text-info-foreground" },
  pring: { label: msg("PRing"), className: "text-teal-600 dark:text-teal-300/90" },
  waiting: { label: msg("Waiting"), className: "text-muted-foreground" },
  approval: { label: msg("Approval"), className: "text-warning-foreground" },
  input: { label: msg("Input"), className: "text-indigo-600 dark:text-indigo-300" },
  request: { label: msg("Request"), className: "text-guest-foreground" },
  limited: { label: msg("Limited"), className: "text-warning-foreground" },
  failed: { label: msg("Failed"), className: "text-error-foreground" },
};

/** A stack's threads as a small tree, for the hover card of any member. */
export function ThreadStackMiniTree(props: { layout: string; currentThreadKey: string }) {
  const gt = useGT();
  const entries = props.layout.split("\n").flatMap((line) => {
    const separator = line.indexOf(" ");
    const key = line.slice(separator + 1);
    const threadRef = parseScopedThreadKey(key);
    return threadRef === null ? [] : [{ key, threadRef, depth: Number(line.slice(0, separator)) }];
  });
  return (
    <div className="flex flex-col gap-1">
      <div className="pl-0.5 font-medium text-foreground/75">
        {gt("Stack · {count, plural, one {{count} thread} other {{count} threads}}", {
          count: entries.length,
        })}
      </div>
      <ul className="flex flex-col">
        {entries.map((entry) => (
          <StackMiniTreeItem
            key={entry.key}
            threadRef={entry.threadRef}
            depth={entry.depth}
            current={entry.key === props.currentThreadKey}
          />
        ))}
      </ul>
    </div>
  );
}

function StackMiniTreeItem(props: { threadRef: ScopedThreadRef; depth: number; current: boolean }) {
  const thread = useThreadShell(props.threadRef);
  return thread === null ? null : (
    <StackMiniTreeLine thread={thread} depth={props.depth} current={props.current} />
  );
}

function StackMiniTreeLine(props: {
  thread: SidebarThreadSummary;
  depth: number;
  current: boolean;
}) {
  const gt = useGT();
  const resolve = useMessages();
  const { thread } = props;
  const status = useSidebarThreadStatus(thread);
  const localLastVisitedAt = useUiStateStore(
    (store) => store.threadLastVisitedAtById[`${thread.environmentId}:${thread.id}`],
  );
  const unread = hasUnseenCompletion({
    ...thread,
    lastVisitedAt: resolveThreadLastVisitedAt(thread.lastVisitedAt, localLastVisitedAt),
  });
  const shown =
    status !== "ready"
      ? { label: resolve(STATUS_LABEL[status].label), className: STATUS_LABEL[status].className }
      : unread
        ? { label: gt("Done"), className: "text-success-foreground" }
        : null;
  const ownPr = threadOwnPullRequest(thread);
  const prState = ownPr?.snapshot
    ? resolvePullRequestState({ state: ownPr.snapshot.state, isDraft: ownPr.snapshot.isDraft })
    : null;
  return (
    <li
      aria-current={props.current || undefined}
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-sm px-1",
        props.current && "bg-accent text-foreground",
      )}
    >
      {Array.from({ length: props.depth }, (_, level) => (
        <span
          key={level}
          aria-hidden
          className="ml-1 w-1.5 shrink-0 self-stretch border-l border-border/70"
        />
      ))}
      <span className="inline-flex shrink-0 items-center gap-0.5 py-1 tabular-nums">
        {ownPr !== null && prState !== null ? (
          <span className={cn("inline-flex items-center gap-0.5", prState.toneClassName)}>
            <prState.Icon aria-hidden className="size-3" />#{ownPr.number}
          </span>
        ) : (
          <PullRequestGlyph.pullRequest aria-hidden className="size-3 text-muted-foreground/30" />
        )}
      </span>
      <span
        className={cn(
          "min-w-0 flex-1 truncate",
          props.current ? "font-medium" : "text-foreground/75",
        )}
      >
        {thread.title}
      </span>
      {shown ? <span className={cn("shrink-0", shown.className)}>{shown.label}</span> : null}
    </li>
  );
}
