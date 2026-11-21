import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/reactivity";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId } from "@t3tools/contracts";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
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
  const updateMetadata = useAtomCommand(threadEnvironment.updateMetadata);
  const [pending, setPending] = useState<"stop" | "retry" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const runtime = thread.runtime;
  const requestPending = thread.hasPendingApprovals || thread.hasPendingUserInput;
  if (runtime?.stalled !== true) return null;
  // Absent until the server has scheduled the retry.
  const nextAttempt =
    runtime.stallNextAttemptAt == null
      ? null
      : new Date(runtime.stallNextAttemptAt).toLocaleString(undefined, {
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
        cause instanceof Error
          ? cause.message
          : action === "stop"
            ? "Could not stop retrying."
            : "Could not retry now.",
      );
    }
  }
  return (
    <View className="mx-3 mb-2 gap-1 rounded-xl border border-info-foreground/25 bg-screen p-3">
      <View className="min-w-0 gap-1">
        <Text className="text-sm font-t3-medium text-foreground">Provider overloaded</Text>
        <Text className="text-sm text-foreground-muted">
          {nextAttempt === null
            ? "T3 Code retries this thread on its own."
            : `T3 Code retries this thread on its own, next at ${nextAttempt}.`}
        </Text>
      </View>
      {/* The margins cancel the 44pt touch height so the links sit 8pt under the text. */}
      <View className="-mb-3 -mt-2 flex-row flex-wrap gap-x-4">
        <RecoveryAction
          label="Retry now"
          disabled={pending !== null || requestPending}
          onPress={() => void run("retry")}
        />
        <RecoveryAction
          label="Stop retrying"
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
