import type {
  EnvironmentId,
  OrchestrationV2PendingBackgroundTask,
  OrchestrationV2ProviderGoal,
  ThreadId,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import type { EnvironmentThreadShell, ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  deriveBackgroundWorkDetails,
  presentProviderGoal,
} from "@t3tools/client-runtime/state/thread-execution";
import { childThreadInputsTitle } from "@t3tools/client-runtime/state/threads";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import {
  CircleDashedIcon,
  GitBranchIcon,
  MessageCircleIcon,
  ShieldQuestionIcon,
  TargetIcon,
  TerminalIcon,
} from "lucide-react";
import { Fragment, useState, type ReactNode } from "react";
import { tickTextContent } from "~/lib/tickTextContent";
import { Button, InlineButton } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { BackgroundWorkDetails } from "./BackgroundWorkDetails";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";
import type { ThreadNowItem } from "./ThreadNow";

/** Subagents waiting on the user, unless the parent is itself waiting on them. */
export function childInputNowItem(input: {
  readonly childThreadInputs: ReadonlyArray<EnvironmentThreadShell>;
  readonly parentAwaitingUser: boolean;
  readonly onOpenThread: (threadId: ThreadId) => void;
}): ThreadNowItem | null {
  const { childThreadInputs, onOpenThread } = input;
  const first = childThreadInputs[0];
  if (!first || input.parentAwaitingUser) return null;
  return {
    id: `child-input:${first.id}`,
    // The only line at the end of the timeline that needs you gets the info color.
    icon: first.hasPendingApprovals ? (
      <ShieldQuestionIcon className="text-info-foreground" />
    ) : (
      <MessageCircleIcon className="text-info-foreground" />
    ),
    title: childThreadInputsTitle(childThreadInputs),
    description: childThreadInputs.map((child, index) => (
      <Fragment key={child.id}>
        {index > 0 ? " " : null}
        <span className="whitespace-nowrap">
          <InlineButton tone="muted" onClick={() => onOpenThread(child.id)}>
            {child.title}
          </InlineButton>
          {index < childThreadInputs.length - 1 ? "," : null}
        </span>
      </Fragment>
    )),
    actions: (
      <InlineButton onClick={() => onOpenThread(first.id)}>
        {first.hasPendingApprovals ? "Open approval" : "Open question"}
      </InlineButton>
    ),
  };
}

/** The thread's goal, for the end of the timeline. */
export function goalNowItem(input: {
  readonly threadId: ThreadId;
  readonly goal: OrchestrationV2ProviderGoal;
  readonly isWorking: boolean;
  readonly onSendCommand: (text: string, failureMessage: string) => Promise<void>;
}): ThreadNowItem {
  const { isWorking, onSendCommand } = input;
  const presentation = presentProviderGoal(input.goal, isWorking);
  return {
    id: `goal:${input.threadId}`,
    icon: <TargetIcon />,
    title:
      presentation.usage === null
        ? presentation.title
        : `${presentation.title} · ${presentation.usage}`,
    description: presentation.objective,
    // Clear stops goal work; Resume would stop unrelated work, so it waits.
    actions: (
      <>
        {presentation.canResume && !isWorking ? (
          <>
            <InlineButton
              onClick={() => void onSendCommand("/goal resume", "Failed to resume goal.")}
            >
              Resume
            </InlineButton>
            <span aria-hidden>·</span>
          </>
        ) : null}
        <InlineButton
          tone="muted"
          onClick={() => void onSendCommand("/goal clear", "Failed to clear goal.")}
        >
          Clear
        </InlineButton>
      </>
    ),
  };
}

function BackgroundWorkPopover({
  title,
  ...props
}: Parameters<typeof BackgroundWorkDetails>[0] & { readonly title: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger render={<InlineButton tone="muted" />}>{title}</PopoverTrigger>
      <PopoverPopup
        side="top"
        align="start"
        aria-label="Background work details"
        className="w-[min(36rem,calc(100vw-2rem))]"
        touchBackdrop
      >
        {open ? (
          <BackgroundWorkDetails
            {...props}
            onOpenThread={(threadId) => {
              setOpen(false);
              props.onOpenThread(threadId);
            }}
            onRunInTerminal={
              props.onRunInTerminal
                ? (command) => {
                    setOpen(false);
                    props.onRunInTerminal?.(command);
                  }
                : undefined
            }
          />
        ) : null}
      </PopoverPopup>
    </Popover>
  );
}

/** Background commands and subagents, for the end of the timeline. */
export function backgroundWorkNowItem(input: {
  readonly environmentId: EnvironmentId;
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly onRunInTerminal?: ((command: string) => void) | undefined;
  readonly threadId: ThreadId;
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly turnItems: ThreadStructure["turnItems"];
  readonly stopDisabled: boolean;
  readonly stopping: boolean;
  readonly onStop: () => Promise<void>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}): ThreadNowItem | null {
  const { onOpenThread } = input;
  const backgroundWork = deriveBackgroundWorkDetails(input);
  if (backgroundWork === null) return null;
  const { presentation, details: rows } = backgroundWork;
  const [only] = rows.length === 1 ? rows : [];
  const newest = rows
    .filter((row) => row.activity)
    .toSorted((left, right) => right.updatedAtMs - left.updatedAtMs)[0];
  const label = (row: (typeof rows)[number]) =>
    row.isRawCommand ? <span className="font-mono">{row.item.label}</span> : row.item.label;
  const showsRunningState =
    only !== undefined && only.item.named && only.activity === null && !presentation.waiting;
  const onlyThreadId = only?.childThreadId;
  const startedAtMs = only?.startedAtMs ?? null;
  return {
    id: `background-work:${input.threadId}`,
    icon: rows.every((row) => row.item.kind !== "subagent") ? (
      <TerminalIcon />
    ) : (
      <CircleDashedIcon />
    ),
    titleProvidesDetails: true,
    title: (
      <BackgroundWorkPopover
        environmentId={input.environmentId}
        details={rows}
        onOpenThread={onOpenThread}
        onRunInTerminal={input.onRunInTerminal}
        title={
          only?.item.named === true ? (
            <>
              {presentation.waiting ? "Waiting on " : null}
              <span className="text-foreground/80">{label(only)}</span>
            </>
          ) : (
            <span className="text-foreground/80">{presentation.title}</span>
          )
        }
      />
    ),
    description: only
      ? only.activity
      : newest
        ? `${newest.item.label}: ${newest.activity}`
        : rows.map((row, index) => (
            <Fragment key={row.item.taskId}>
              {index > 0 ? ", " : null}
              {label(row)}
            </Fragment>
          )),
    actions: (
      <>
        {/* Outside the truncating title, so a long name cannot cut the state off. */}
        {showsRunningState ? (
          <span className="text-muted-foreground/60 light:text-muted-foreground/80">
            running in background
          </span>
        ) : null}
        {startedAtMs === null ? null : (
          <>
            <span
              ref={tickTextContent(
                (nowMs) => formatDuration(Math.max(1_000, nowMs - startedAtMs)),
                true,
              )}
              className="tabular-nums"
            />
            <span aria-hidden>·</span>
          </>
        )}
        {onlyThreadId === undefined ? null : (
          <InlineButton tone="muted" onClick={() => onOpenThread(onlyThreadId)}>
            Open
          </InlineButton>
        )}
        <InlineButton
          tone="muted"
          disabled={input.stopDisabled}
          onClick={() => void input.onStop()}
        >
          {input.stopping ? "Stopping..." : "Stop"}
        </InlineButton>
      </>
    ),
  };
}

/** The local checkout moved off the branch this thread last ran on. */
export function branchMismatchBannerItem(input: {
  readonly mismatchKey: string;
  readonly mismatch: { readonly threadBranch: string; readonly currentBranch: string };
  readonly restoreDisabled: boolean;
  readonly restoring: boolean;
  readonly onRestore: () => void;
  readonly onDismiss: () => void;
}): ComposerBannerStackItem {
  const { mismatch } = input;
  return {
    id: `branch-mismatch:${input.mismatchKey}`,
    variant: "info",
    icon: <GitBranchIcon />,
    title: (
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="shrink-0 font-normal text-muted-foreground">Branch changed from</span>
        <Tooltip>
          <TooltipTrigger
            render={
              <code className="min-w-0 truncate font-medium text-foreground">
                {mismatch.threadBranch}
              </code>
            }
          />
          <TooltipPopup side="top">
            This thread last ran on {mismatch.threadBranch}. Sending will continue on{" "}
            {mismatch.currentBranch}.
          </TooltipPopup>
        </Tooltip>
      </span>
    ),
    actions: (
      <Button size="xs" variant="ghost" disabled={input.restoreDisabled} onClick={input.onRestore}>
        {input.restoring ? "Restoring..." : "Restore branch"}
      </Button>
    ),
    dismissLabel: "Dismiss branch change notice",
    onDismiss: input.onDismiss,
  };
}
