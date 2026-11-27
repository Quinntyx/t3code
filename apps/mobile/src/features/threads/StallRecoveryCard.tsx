import { errorDisplayMessage } from "@t3tools/client-runtime/errors";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { useNowMinuteMs } from "../../lib/clock";
import { threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";

/**
 * The notice a stalled thread shows in place of its error. The provider's API was overloaded,
 * so T3 Code retries on its own and nothing needs fixing.
 */
export function StallRecoveryCard({
  thread,
  environmentId,
}: {
  thread: EnvironmentThreadShell;
  environmentId: EnvironmentId;
}) {
  const gt = useGT();
  const m = useMessages();
  const nowMs = useNowMinuteMs();
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  const [pending, setPending] = useState<"stop" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runtime = thread.runtime;
  const requestPending = thread.hasPendingApprovals || thread.hasPendingUserInput;
  const paused = thread.archivedAt !== null || thread.settledOverride === "settled";
  if (runtime?.stalled !== true) return null;
  // Absent until the server has scheduled a future retry, or while paused.
  const nextAttemptMs =
    runtime.stallNextAttemptAt == null ? Number.NaN : Date.parse(runtime.stallNextAttemptAt);
  const nextAttempt =
    paused || !Number.isFinite(nextAttemptMs) || nextAttemptMs <= nowMs
      ? null
      : new Date(nextAttemptMs).toLocaleString(undefined, {
          hour: "numeric",
          minute: "2-digit",
        });
  async function run(action: "stop" | "retry") {
    setPending(action);
    setError(null);
    const result = await updateMetadata({
      environmentId,
      input: {
        threadId: thread.id,
        ...(action === "stop" ? { stallRecovery: null } : { stallRetryNow: true as const }),
      },
    });
    setPending(null);
    if (AsyncResult.isFailure(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(
        errorDisplayMessage(cause, m) ??
          (action === "stop" ? gt("Could not stop retrying.") : gt("Could not retry now.")),
      );
    }
  }
  return (
    <View className="mx-3 mb-2 gap-1 rounded-xl border border-info-foreground/25 bg-screen p-3">
      <View className="min-w-0 gap-1">
        <Text className="text-sm font-t3-medium text-foreground">{gt("Provider overloaded")}</Text>
        <Text className="text-sm text-foreground-muted">
          {nextAttempt === null
            ? gt("T3 Code retries this thread on its own.")
            : gt("T3 Code retries this thread on its own, next at {time}.", { time: nextAttempt })}
        </Text>
      </View>
      {/* The margins cancel the 44pt touch height so the links sit 8pt under the text. */}
      <View className="-mb-3 -mt-2 flex-row flex-wrap gap-x-4">
        <RecoveryAction
          label={gt("Retry now")}
          disabled={pending !== null || requestPending || paused}
          onPress={() => void run("retry")}
        />
        <RecoveryAction
          label={gt("Stop retrying")}
          disabled={pending !== null}
          onPress={() => void run("stop")}
        />
      </View>
      {error ? (
        <Text accessibilityRole="alert" className="text-sm text-destructive">
          {error}
        </Text>
      ) : null}
    </View>
  );
}

function RecoveryAction(props: {
  readonly label: string;
  readonly disabled: boolean;
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      disabled={props.disabled}
      hitSlop={{ left: 8, right: 8 }}
      onPress={props.onPress}
      className="min-h-11 justify-center active:opacity-70"
    >
      <Text
        className={
          props.disabled
            ? "text-sm font-t3-medium text-foreground-muted"
            : "text-sm font-t3-medium text-primary"
        }
      >
        {props.label}
      </Text>
    </Pressable>
  );
}
