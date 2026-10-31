import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { DeusInputId, type DeusScope, type DeusSession } from "@t3tools/contracts";
import { useEffect, useState, useSyncExternalStore } from "react";
import { deusEnvironment } from "../state/deus";
import { useAtomCommand } from "../state/use-atom-command";
import { useDeusPanelStore } from "../deusPanelStore";
import { randomUUID } from "../lib/utils";
import { VoiceAudio, type VoiceConnection } from "./VoiceAudio";
import { browserVoicePlatform } from "./browserAudio";

export function useDeusVoice(target: DeusScope, session: DeusSession | null, available: boolean) {
  const attach = useAtomCommand(deusEnvironment.voice, { reportFailure: false });
  const canAttach = useAtomValue(deusEnvironment.attach.permissionAtom(target.environmentId));
  const canWrite = useAtomValue(deusEnvironment.sendInput.permissionAtom(target.environmentId));
  const canRead = useAtomValue(deusEnvironment.getSnapshot.permissionAtom(target.environmentId));
  const canPush = useAtomValue(deusEnvironment.mediaPush.permissionAtom(target.environmentId));
  const canControl = useAtomValue(
    deusEnvironment.mediaControl.permissionAtom(target.environmentId),
  );
  const canRenew = useAtomValue(deusEnvironment.renew.permissionAtom(target.environmentId));
  const permitted = canAttach && canWrite && canRead && canPush && canControl && canRenew;
  const [owner] = useState(() => new VoiceAudio(browserVoicePlatform));
  const state = useSyncExternalStore(owner.subscribe, owner.snapshot);
  const sessionId = session?.sessionId;
  const conversation = session?.conversation;

  // oxlint-disable-next-line t3code/react-effect-budget -- The stable project owner releases browser media on true unmount or an explicit panel close/switch.
  useEffect(
    () => () => {
      void useDeusPanelStore
        .getState()
        .releaseLocal(target)
        .catch(() => {});
    },
    [target],
  );

  // oxlint-disable-next-line t3code/react-effect-budget -- Capability, permission, connection or conversation loss invalidates the current media generation, never workers.
  useEffect(() => {
    if (!available || !permitted || !sessionId || conversation === undefined)
      void useDeusPanelStore
        .getState()
        .releaseLocal(target)
        .catch(() => {});
    return () => {
      void useDeusPanelStore
        .getState()
        .releaseLocal(target)
        .catch(() => {});
    };
  }, [target, available, permitted, sessionId, conversation]);

  const connect = () => {
    if (!available || !permitted || !session) return;
    const local = useDeusPanelStore.getState().localAttachment;
    if (!local.has(target)) local.register(target, () => owner.disconnect());
    void owner.connect(async (handlers) => {
      let connection: VoiceConnection | null = null;
      const result = await attach({
        environmentId: target.environmentId,
        input: {
          ...target,
          sessionId: session.sessionId,
          conversation: session.conversation,
          inputId: DeusInputId.make(randomUUID()),
          takeover: false,
          authority: {
            runtimeMode: "approval-required",
            interactionMode: "default",
            allowWorktree: false,
          },
          handlers,
          connected: (owned) => {
            connection = owned;
          },
        },
      });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      if (!connection) throw new Error("Voice attachment did not initialize its media transport.");
      return connection;
    });
  };
  return {
    state,
    permitted,
    ready: available && permitted && !!session,
    connect,
    disconnect: () => {
      void useDeusPanelStore
        .getState()
        .releaseLocal(target)
        .catch(() => {});
    },
    mute: () => {
      void owner.mute();
    },
    resume: () => {
      void owner.resume();
    },
    interrupt: () => {
      void owner.interrupt();
    },
  };
}
