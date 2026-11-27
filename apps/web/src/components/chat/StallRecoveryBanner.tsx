import { msg, useGT } from "gt-react";
import type { ThreadId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { CloudOffIcon } from "lucide-react";
import { useState } from "react";
import { m, type MessageResolver } from "../../i18n/messages";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { InlineButton } from "../ui/button";
import { toastManager } from "../ui/toast";
import type { ComposerBannerStackItem } from "./ComposerBannerStack";

type StallProps = {
  threadId: ThreadId;
  /** When the next retry goes out; null until the server has scheduled it. */
  nextAttemptAt: string | null;
  /** A pending approval or question holds the retry back, so Retry now could do nothing. */
  requestPending: boolean;
  /** Settled or archived threads are paused until reopened. */
  paused?: boolean;
  now?: number;
  timestampFormat: TimestampFormat;
  onAction: (action: "stop" | "retry") => Promise<void>;
};

/**
 * The notice a stalled thread shows in place of its error. The provider's API was overloaded, so
 * T3 Code retries on its own and nothing needs fixing.
 */
export function stallRecoveryBannerItem(
  props: StallProps,
  resolve: MessageResolver = m,
): ComposerBannerStackItem {
  const nowMs = props.now ?? Date.now();
  const nextAttemptMs = props.nextAttemptAt === null ? Number.NaN : Date.parse(props.nextAttemptAt);
  const nextAttempt =
    props.paused === true ||
    props.nextAttemptAt === null ||
    !Number.isFinite(nextAttemptMs) ||
    nextAttemptMs <= nowMs
      ? null
      : formatUpcomingTimestamp(
          props.nextAttemptAt,
          props.timestampFormat,
          nowMs,
          undefined,
          resolve,
        );
  return {
    id: `stall-recovery:${props.threadId}`,
    variant: "warning",
    group: "environment",
    icon: <CloudOffIcon />,
    title: resolve(msg("Provider overloaded")),
    description: nextAttempt
      ? resolve(
          msg("T3 Code retries this thread on its own, next at {time}.", {
            time: nextAttempt,
          }),
        )
      : resolve(msg("T3 Code retries this thread on its own.")),
    actions: <StallActions {...props} />,
  };
}

function StallActions({ requestPending, paused, onAction }: StallProps) {
  const gt = useGT();
  const [pending, setPending] = useState<"stop" | "retry" | null>(null);

  async function run(action: "stop" | "retry") {
    setPending(action);
    try {
      await onAction(action);
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: action === "stop" ? gt("Could not stop retrying") : gt("Could not retry now"),
        description: cause instanceof Error ? cause.message : gt("An error occurred."),
      });
    }
    setPending(null);
  }

  // Inline errors would widen the actions column and crush the title.
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
      <InlineButton
        touchTarget="padded"
        disabled={pending !== null || requestPending || paused === true}
        onClick={() => void run("retry")}
      >
        {pending === "retry" ? gt("Retrying...") : gt("Retry now")}
      </InlineButton>
      <InlineButton
        touchTarget="padded"
        disabled={pending !== null}
        onClick={() => void run("stop")}
      >
        {pending === "stop" ? gt("Stopping...") : gt("Stop retrying")}
      </InlineButton>
    </span>
  );
}
