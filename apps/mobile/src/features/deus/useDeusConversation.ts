import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { DeusCursor, DeusInputId, type DeusScope, type DeusSessionId } from "@t3tools/contracts";
import { randomUUID } from "expo-crypto";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { deusEnvironment } from "../../state/deus";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";

function failure(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The Deus request failed.";
}
export function useDeusConversation(target: DeusScope, available: boolean) {
  const canRead = useAtomValue(deusEnvironment.getSnapshot.permissionAtom(target.environmentId));
  const canOpen = useAtomValue(deusEnvironment.open.permissionAtom(target.environmentId));
  const canWrite = useAtomValue(deusEnvironment.sendInput.permissionAtom(target.environmentId));
  const open = useAtomCommand(deusEnvironment.open, { reportFailure: false });
  const send = useAtomCommand(deusEnvironment.sendInput, { reportFailure: false });
  const openConversation = useEffectEvent(open);
  const [sessionId, setSessionId] = useState<DeusSessionId | null>(null);
  const [openId, setOpenId] = useState(() => DeusInputId.make(randomUUID()));
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const pending = useRef<{ id: DeusInputId; text: string; conversation: number } | null>(null);
  const permitted = available && canRead;
  const query = useEnvironmentQuery(
    permitted && sessionId
      ? deusEnvironment.conversation({
          environmentId: target.environmentId,
          input: { ...target, sessionId, after: DeusCursor.make(0) },
        })
      : null,
  );
  const view = permitted && !query.error ? query.data : null;
  // oxlint-disable-next-line t3code/react-effect-budget -- Opening subscribes to durable project metadata, never native media.
  useEffect(() => {
    if (!permitted || !canOpen) return;
    let active = true;
    void openConversation({
      environmentId: target.environmentId,
      input: { ...target, inputId: openId },
    }).then((result) => {
      if (!active) return;
      if (result._tag === "Success") {
        setSessionId(result.value.session.sessionId);
        setError(null);
      } else setError(failure(result));
    });
    return () => {
      active = false;
    };
  }, [target, permitted, canOpen, openId]);
  const submit = async () => {
    if (!view || !permitted || !canWrite || sending || !text.trim()) return;
    const inputText = text.trim();
    if (
      pending.current?.text !== inputText ||
      pending.current.conversation !== view.session.conversation
    )
      pending.current = {
        id: DeusInputId.make(randomUUID()),
        text: inputText,
        conversation: view.session.conversation,
      };
    setSending(true);
    setError(null);
    const result = await send({
      environmentId: target.environmentId,
      input: {
        ...target,
        sessionId: view.session.sessionId,
        conversation: view.session.conversation,
        inputId: pending.current.id,
        text: inputText,
        authority: {
          runtimeMode: "approval-required",
          interactionMode: "default",
          allowWorktree: false,
        },
      },
    });
    setSending(false);
    if (result._tag === "Success") {
      setText("");
      pending.current = null;
    } else setError(failure(result));
  };
  return {
    session: view?.session ?? null,
    transcripts: view?.transcripts ?? [],
    text,
    setText,
    sending,
    canSend: !!view && canWrite && !sending && !!text.trim(),
    submit,
    error,
    status: !canRead
      ? "Permission required to read this project’s Deus conversation."
      : !available
        ? "Text unavailable at this destination."
        : !canOpen && !sessionId
          ? "Permission required to open this project’s conversation."
          : (query.error ??
            (view
              ? canWrite
                ? "Text connected."
                : "Permission required to send messages."
              : "Loading conversation…")),
    refresh: () => {
      setError(null);
      setOpenId(DeusInputId.make(randomUUID()));
      query.refresh();
    },
  };
}
