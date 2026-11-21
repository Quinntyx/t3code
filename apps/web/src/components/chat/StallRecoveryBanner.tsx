import type { ThreadId } from "@t3tools/contracts";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { CloudOffIcon } from "lucide-react";
import { useState } from "react";
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
  timestampFormat: TimestampFormat;
  onAction: (action: "stop" | "retry") => Promise<void>;
};

/**
 * The notice a stalled thread shows in place of its error. The provider's API was overloaded, so
 * T3 Code retries on its own and nothing needs fixing.
 */
export function stallRecoveryBannerItem(props: StallProps): ComposerBannerStackItem {
  const nextAttempt =
    props.nextAttemptAt === null
      ? null
      : formatUpcomingTimestamp(props.nextAttemptAt, props.timestampFormat);
  return {
    id: `stall-recovery:${props.threadId}`,
    variant: "warning",
    group: "environment",
    icon: <CloudOffIcon />,
    title: "Provider overloaded",
    description: nextAttempt
      ? `T3 Code retries this thread on its own, next at ${nextAttempt}.`
      : "T3 Code retries this thread on its own.",
    actions: <StallActions {...props} />,
  };
}

function StallActions({ requestPending, onAction }: StallProps) {
  const [pending, setPending] = useState<"stop" | "retry" | null>(null);

  async function run(action: "stop" | "retry") {
    setPending(action);
    try {
      await onAction(action);
    } catch (cause) {
      toastManager.add({
        type: "error",
        title: action === "stop" ? "Could not stop retrying" : "Could not retry now",
        description: cause instanceof Error ? cause.message : "An error occurred.",
      });
    }
    setPending(null);
  }

  // Inline errors would widen the actions column and crush the title.
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1">
      <InlineButton
        touchTarget="padded"
        disabled={pending !== null || requestPending}
        onClick={() => void run("retry")}
      >
        {pending === "retry" ? "Retrying..." : "Retry now"}
      </InlineButton>
      <InlineButton
        touchTarget="padded"
        disabled={pending !== null}
        onClick={() => void run("stop")}
      >
        {pending === "stop" ? "Stopping..." : "Stop retrying"}
      </InlineButton>
    </span>
  );
}
