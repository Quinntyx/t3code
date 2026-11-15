import {
  CommandId,
  MessageId,
  type OrchestrationV2Notification,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadWatch,
  type ThreadId,
} from "@t3tools/contracts";

/** Long enough for a quick child to finish in-call; anything longer becomes a watch. */
export const AGENT_THREAD_WAIT_MS = 60_000;

type WatchTarget = Pick<OrchestrationV2ThreadWatch, "environmentId" | "threadId">;

export const sameThreadWatchTarget = (left: WatchTarget, right: WatchTarget) =>
  left.threadId === right.threadId && left.environmentId === right.environmentId;

/** Starts watching; a later start on the same thread replaces the earlier watch. */
export const threadWatchStartCommand = (
  watcherThreadId: ThreadId,
  watch: OrchestrationV2ThreadWatch,
): Extract<OrchestrationV2ServerCommand, { readonly type: "thread.thread-watch.sync" }> => ({
  type: "thread.thread-watch.sync",
  commandId: CommandId.make(
    `thread-watch:start:${watcherThreadId}:${watch.environmentId ?? "here"}:${watch.threadId}:${watch.startedAt}`,
  ),
  threadId: watcherThreadId,
  watch,
  watching: true,
});

export type ThreadWatchOutcome =
  | { readonly kind: "ended"; readonly status: OrchestrationV2Run["status"] }
  | { readonly kind: "needs_input" }
  | { readonly kind: "gone" };

const OUTCOMES: Record<
  OrchestrationV2Run["status"],
  { readonly outcome: OrchestrationV2Notification["outcome"]; readonly verb: string }
> = {
  completed: { outcome: "completed", verb: "finished" },
  waiting: { outcome: "completed", verb: "finished" },
  failed: { outcome: "failed", verb: "failed" },
  cancelled: { outcome: "cancelled", verb: "was stopped" },
  interrupted: { outcome: "cancelled", verb: "was interrupted" },
  rolled_back: { outcome: "cancelled", verb: "was rolled back" },
  queued: { outcome: "unknown", verb: "ended" },
  preparing: { outcome: "unknown", verb: "ended" },
  starting: { outcome: "unknown", verb: "ended" },
  running: { outcome: "unknown", verb: "ended" },
};

/** The message that wakes `watcherThreadId` once, with ids a retry repeats instead of resending. */
export function threadWatchWake(
  watcherThreadId: ThreadId,
  watch: OrchestrationV2ThreadWatch,
  outcome: ThreadWatchOutcome,
): {
  readonly messageId: MessageId;
  readonly text: string;
  readonly notification: OrchestrationV2Notification;
} {
  const name = watch.title === undefined ? "The thread" : `Thread "${watch.title}"`;
  const target = `threadId ${watch.threadId}${
    watch.environmentId === undefined ? "" : `, environmentId ${watch.environmentId}`
  }`;
  const label = watch.title ?? "Watched thread";
  const reported =
    outcome.kind === "ended"
      ? {
          text: `${name} you waited on (${target}) ${OUTCOMES[outcome.status].verb}. Read it with t3_thread_read before you continue.`,
          outcome: OUTCOMES[outcome.status].outcome,
          summary: `${label} ${OUTCOMES[outcome.status].verb}`,
        }
      : outcome.kind === "needs_input"
        ? {
            text: `${name} you waited on (${target}) stopped to ask for input. Read it with t3_thread_read. Answer it with t3_pending_request if the answer follows from your task, otherwise ask the user. Call t3_thread_wait again to keep waiting.`,
            outcome: "updated" as const,
            summary: `${label} needs input`,
          }
        : {
            text: `${name} you waited on (${target}) was deleted or can no longer be reached.`,
            outcome: "cancelled" as const,
            summary: `${label} is gone`,
          };
  return {
    messageId: MessageId.make(
      `message:thread-watch:${watcherThreadId}:${watch.environmentId ?? "here"}:${watch.threadId}:${watch.startedAt}`,
    ),
    text: reported.text,
    notification: {
      source: { kind: "monitor" },
      outcome: reported.outcome,
      summary: reported.summary,
    },
  };
}
