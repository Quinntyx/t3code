import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { DeusInputId, type DeusScope, type DeusSession } from "@t3tools/contracts";
import { randomUUID } from "expo-crypto";
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import { AppState } from "react-native";
import type { DeusVoiceConnection } from "@t3tools/client-runtime/state/deus";
import { deusEnvironment } from "../../state/deus";
import { useAtomCommand } from "../../state/use-atom-command";
import { NativeVoiceAudio } from "./NativeVoiceAudio";
import { nativeVoiceDevice } from "./nativeVoiceDevice";
import { useDeusPanelStore } from "./panelStore";

export function useDeusVoice(target: DeusScope, session: DeusSession | null, available: boolean) {
  const attach = useAtomCommand(deusEnvironment.voice, { reportFailure: false });
  const canAttach = useAtomValue(deusEnvironment.attach.permissionAtom(target.environmentId));
  const canRead = useAtomValue(deusEnvironment.getSnapshot.permissionAtom(target.environmentId));
  const canWrite = useAtomValue(deusEnvironment.sendInput.permissionAtom(target.environmentId));
  const canPush = useAtomValue(deusEnvironment.mediaPush.permissionAtom(target.environmentId));
  const canControl = useAtomValue(
    deusEnvironment.mediaControl.permissionAtom(target.environmentId),
  );
  const canRenew = useAtomValue(deusEnvironment.renew.permissionAtom(target.environmentId));
  const permitted = canAttach && canRead && canWrite && canPush && canControl && canRenew;
  const [owner] = useState(() => new NativeVoiceAudio(nativeVoiceDevice));
  const state = useSyncExternalStore(owner.subscribe, owner.snapshot);
  const sessionId = session?.sessionId;
  const conversation = session?.conversation;
  const release = () => useDeusPanelStore.getState().localAttachment.release(target);
  // oxlint-disable-next-line t3code/react-effect-budget -- Background and true unmount release native media; navigation inside the workspace does not.
  useEffect(() => {
    const subscription = AppState.addEventListener("change", (next) => {
      if (next === "background")
        void useDeusPanelStore
          .getState()
          .localAttachment.release(target)
          .catch(() => {});
    });
    return () => {
      subscription.remove();
      void useDeusPanelStore
        .getState()
        .localAttachment.release(target)
        .catch(() => {});
    };
  }, [target]);
  // oxlint-disable-next-line t3code/react-effect-budget -- Destination capability, permission, transport or conversation loss invalidates native media.
  useEffect(() => {
    if (!available || !permitted || !sessionId || conversation === undefined)
      void useDeusPanelStore
        .getState()
        .localAttachment.release(target)
        .catch(() => {});
    return () => {
      void useDeusPanelStore
        .getState()
        .localAttachment.release(target)
        .catch(() => {});
    };
  }, [target, available, permitted, sessionId, conversation]);
  const connect = useCallback(
    (takeover: boolean) => {
      if (!available || !permitted || !session || AppState.currentState !== "active") return;
      const local = useDeusPanelStore.getState().localAttachment;
      if (!local.has(target)) local.register(target, () => owner.disconnect());
      void owner.connect(async (handlers) => {
        let connection: DeusVoiceConnection | null = null;
        const result = await attach({
          environmentId: target.environmentId,
          input: {
            ...target,
            sessionId: session.sessionId,
            conversation: session.conversation,
            inputId: DeusInputId.make(randomUUID()),
            takeover,
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
        if (!connection)
          throw new Error("Voice attachment did not initialize its media transport.");
        return connection;
      });
    },
    [available, permitted, session, target, owner, attach],
  );
  // oxlint-disable-next-line t3code/react-effect-budget -- Destination settings share the mounted native media owner without starting capture.
  useEffect(() => {
    const store = useDeusPanelStore.getState();
    store.registerVoice(target, {
      ready: available && permitted && !!session && nativeVoiceDevice.available,
      active: state.cleanupRequired || !["disconnected", "error"].includes(state.phase),
      muted: state.muted,
      connect: () => connect(false),
      disconnect: () => {
        void store.localAttachment.release(target).catch(() => {});
      },
      toggleMute: () => {
        if (state.muted) void owner.resume();
        else void owner.mute();
      },
    });
    return () => store.unregisterVoice(target);
  }, [
    target,
    available,
    permitted,
    session,
    state.phase,
    state.cleanupRequired,
    state.muted,
    connect,
    owner,
  ]);
  return {
    state,
    permitted,
    ready: available && permitted && !!session && nativeVoiceDevice.available,
    nativeAvailable: nativeVoiceDevice.available,
    connect: () => connect(false),
    takeover: () => connect(true),
    disconnect: () => {
      void release().catch(() => {});
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
