import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { type DeusScope, type DeusSnapshot, DeusInputId, DeusCursor } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import { deusEnvironment } from "../../state/deus";
import { useEnvironmentQuery } from "../../state/query";
import { useAtomCommand } from "../../state/use-atom-command";
import { useDeusPanelStore } from "../../deusPanelStore";
import { randomUUID } from "../../lib/utils";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";

function failureMessage(result: Parameters<typeof squashAtomCommandFailure>[0]) {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "The Deus request failed.";
}

export function useDeusConversation({
  target,
  available,
}: {
  target: DeusScope;
  available: boolean;
}) {
  const canRead = useAtomValue(deusEnvironment.getSnapshot.permissionAtom(target.environmentId));
  const canOpen = useAtomValue(deusEnvironment.open.permissionAtom(target.environmentId));
  const canWrite = useAtomValue(deusEnvironment.sendInput.permissionAtom(target.environmentId));
  const open = useAtomCommand(deusEnvironment.open, { reportFailure: false });
  const send = useAtomCommand(deusEnvironment.sendInput, { reportFailure: false });
  const openConversation = useEffectEvent(open);
  const [snapshot, setSnapshot] = useState<DeusSnapshot | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [openId, setOpenId] = useState(() => DeusInputId.make(randomUUID()));
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);
  const pending = useRef<{ id: DeusInputId; text: string; conversation: number } | null>(null);
  const permitted = available && canRead;
  const query = useEnvironmentQuery(
    permitted && snapshot
      ? deusEnvironment.conversation({
          environmentId: target.environmentId,
          input: { ...target, sessionId: snapshot.session.sessionId, after: DeusCursor.make(0) },
        })
      : null,
  );
  const view = permitted && !query.error ? query.data : null;

  // oxlint-disable-next-line t3code/react-effect-budget -- Opening subscribes to the selected project's durable service, never media.
  useEffect(() => {
    if (!permitted || !canOpen) return;
    let active = true;
    void openConversation({
      environmentId: target.environmentId,
      input: { ...target, inputId: openId },
    }).then((result) => {
      if (!active) return;
      if (result._tag === "Success") {
        setSnapshot(result.value);
        setOpenError(null);
      } else setOpenError(failureMessage(result));
    });
    return () => {
      active = false;
    };
  }, [target, permitted, canOpen, openId]);

  // oxlint-disable-next-line t3code/react-effect-budget -- Revocation/offline and unmount release only local media registered by the next migration step.
  useEffect(() => {
    const release = () => {
      void useDeusPanelStore
        .getState()
        .releaseLocal(target)
        .catch(() => {});
    };
    if (!permitted || !canWrite) release();
    return release;
  }, [target, permitted, canWrite]);

  const submit = async () => {
    if (!view || !canWrite || !permitted || sending || !text.trim()) return;
    const inputText = text.trim();
    if (
      pending.current?.text !== inputText ||
      pending.current.conversation !== view.session.conversation
    ) {
      pending.current = {
        id: DeusInputId.make(randomUUID()),
        text: inputText,
        conversation: view.session.conversation,
      };
    }
    setSending(true);
    setSendError(null);
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
    } else setSendError(failureMessage(result));
  };

  return (
    <>
      <div className="border-b border-border px-4 py-2 text-xs text-muted-foreground" role="status">
        {!canRead
          ? "Permission required to read this project's Deus conversation."
          : !available
            ? "Conversation unavailable at this destination."
            : !canOpen && !snapshot
              ? "Permission required to open this project's Deus conversation."
              : (openError ??
                query.error ??
                (view
                  ? "Text conversation connected. Voice is not attached."
                  : "Loading conversation…"))}
      </div>
      {permitted && (openError || query.error) ? (
        <div className="px-4 py-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => {
              setOpenError(null);
              setOpenId(DeusInputId.make(randomUUID()));
              query.refresh();
            }}
          >
            Refresh conversation
          </Button>
        </div>
      ) : null}
      <ol
        aria-label="Deus transcript"
        className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4 text-sm"
      >
        {view?.transcripts.map((row) => (
          <li key={row.id} data-transcript-id={row.id}>
            <p className="mb-1 text-xs font-medium text-muted-foreground">
              {row.role === "human" ? "You" : "Deus"} · Conversation {row.conversation}
            </p>
            <p className="whitespace-pre-wrap break-words">{row.text}</p>
          </li>
        ))}
        {view && view.transcripts.length === 0 ? (
          <li className="text-muted-foreground">
            No messages yet. This conversation belongs to the project, not a worker thread.
          </li>
        ) : null}
      </ol>
      <form
        className="space-y-2 border-t border-border p-4"
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <label htmlFor="deus-message" className="text-sm font-medium">
          Message Deus
        </label>
        <Textarea
          id="deus-message"
          value={text}
          onChange={(event) => setText(event.target.value)}
          disabled={!view || !canWrite || sending}
          placeholder="Coordinate work in this project…"
          maxLength={16000}
        />
        <p className="text-xs text-muted-foreground">
          Workers require approval. New worktrees are not allowed. Closing this panel does not
          cancel workers.
        </p>
        {!canWrite ? (
          <p role="status" className="text-xs text-muted-foreground">
            Permission required to send messages.
          </p>
        ) : null}
        {sendError ? (
          <p role="alert" className="text-sm text-destructive">
            {sendError}
          </p>
        ) : null}
        <Button type="submit" size="sm" disabled={!view || !canWrite || sending || !text.trim()}>
          {sending ? "Sending…" : "Send message"}
        </Button>
      </form>
    </>
  );
}
