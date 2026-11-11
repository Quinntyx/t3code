import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { createVoiceSession } from "@t3tools/client-runtime/voice/session";
import {
  createNotificationFeed,
  notificationsFromShell,
  type VoiceNotification,
} from "@t3tools/client-runtime/voice/notifications";
import { awaitAtomValue } from "@t3tools/client-runtime/voice/awaitAtom";
import { createVoiceTools, type VoiceEnvironmentView } from "@t3tools/client-runtime/voice/tools";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { ORCHESTRATION_V2_WS_METHODS, ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as Option from "effect/Option";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentShell, liveShellEnvironmentIdsAtom } from "../state/shell";
import { environmentThreads } from "../state/threads";
import { serverEnvironment } from "../state/server";
import { randomUUID } from "../lib/utils";
import {
  rightPanelHostRef,
  useRightPanelStore,
  type RightPanelStoreState,
} from "../rightPanelStore";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { browserVoicePlatform } from "./browserAudio";
import { VoiceAudio, type VoiceHandlers } from "./VoiceAudio";
import { createVoiceStorage } from "./storage";

export const voiceStorage = createVoiceStorage(
  {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
  },
  window.desktopBridge,
);
const feed = createNotificationFeed(voiceStorage.seen, (notice) =>
  appAtomRegistry
    .get(viewsAtom)
    .some(
      (environment) =>
        environment.id === notice.environmentId &&
        environment.threads.some((thread) => thread.id === notice.threadId),
    ),
);
const viewsAtom = Atom.make((get): ReadonlyArray<VoiceEnvironmentView> => {
  const catalog = get(environmentCatalog.catalogValueAtom);
  return [...get(liveShellEnvironmentIdsAtom)].flatMap((environmentId) => {
    const snapshot = Option.getOrNull(get(environmentShell.stateValueAtom(environmentId)).snapshot);
    if (!snapshot) return [];
    return [
      {
        id: environmentId,
        label: catalog.entries.get(environmentId)?.target.label ?? environmentId,
        projects: snapshot.projects,
        threads: snapshot.threads,
        providers: get(serverEnvironment.providersValueAtom(environmentId)) ?? [],
      },
    ];
  });
});
const notificationsAtom = Atom.make((get) => {
  const notifications: VoiceNotification[] = [];
  for (const environment of get(viewsAtom)) {
    const snapshot = Option.getOrNull(
      get(environmentShell.stateValueAtom(environment.id as EnvironmentId)).snapshot,
    );
    if (snapshot) notifications.push(...notificationsFromShell(environment.id, snapshot));
  }
  return notifications;
});
const command = createEnvironmentRpcCommand(connectionAtomRuntime, {
  label: "voice:dispatch",
  tag: ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
});
const tools = createVoiceTools({
  registry: appAtomRegistry,
  dispatch: command,
  environments: () => appAtomRegistry.get(viewsAtom),
  async readThread(environmentId, threadId) {
    const data = await awaitAtomValue(
      appAtomRegistry,
      environmentThreads.stateAtom(environmentId, ThreadId.make(threadId)),
      (result) => (AsyncResult.isSuccess(result) ? Option.getOrNull(result.value.data) : null),
      AbortSignal.timeout(15_000),
    );
    return {
      thread: data.thread,
      recentOutput: data.turnItems.slice(-30),
      pendingRequests: data.runtimeRequests.filter((request) => request.status === "pending"),
    };
  },
  uuid: randomUUID,
});
let handlers: VoiceHandlers | null = null;
let audioEpoch = 0;
export const voiceAudio = new VoiceAudio(browserVoicePlatform);
const decodeAudio = (data: string) =>
  Uint8Array.from(atob(data), (character) => character.charCodeAt(0));
export const voiceSession = createVoiceSession({
  key: voiceStorage.key,
  model: voiceStorage.model.read,
  feed,
  tools,
  onAudio: (data) => handlers?.audio(decodeAudio(data), audioEpoch),
  onInterrupt: () => handlers?.epoch(++audioEpoch),
  onDisconnect: () => {
    const previous = handlers;
    handlers = null;
    previous?.closed();
  },
});
let unwatchNotifications: (() => void) | null = null;
const showsVoice = (state: Pick<RightPanelStoreState, "byThreadKey">) =>
  Object.values(state.byThreadKey).some((panel) =>
    panel.surfaces.some((surface) => surface.kind === "voice"),
  );
let unwatchPanels: (() => void) | null = null;
/** Starts the client session for a rendered Voice surface; it ends once no thread shows Voice. */
export async function openVoiceSession() {
  unwatchPanels ??= useRightPanelStore.subscribe((state) => {
    if (!showsVoice(state)) closeVoiceSession();
  });
  if (!voiceSession.getSnapshot().open) await voiceSession.open();
  if (!voiceSession.getSnapshot().open || voiceSession.getSnapshot().status === "disabled") {
    unwatchNotifications?.();
    unwatchNotifications = null;
    return;
  }
  unwatchNotifications ??= appAtomRegistry.subscribe(
    notificationsAtom,
    (notifications) => feed.update(notifications),
    { immediate: true },
  );
}
function closeVoiceSession() {
  unwatchPanels?.();
  unwatchPanels = null;
  unwatchNotifications?.();
  unwatchNotifications = null;
  voiceSession.close();
  void voiceAudio.disconnect();
}
/** Shows Voice in the thread navigated to, without touching a panel that already shows it. */
export function followVoiceInto(ref: ScopedThreadRef) {
  const store = useRightPanelStore.getState();
  const panel = store.byThreadKey[scopedThreadKey(rightPanelHostRef(ref))];
  if (!(panel?.isOpen && panel.activeSurfaceId === "voice")) store.open(ref, "voice");
}
/** Voice is a right-panel surface of whichever thread is on screen. */
export function toggleVoice(ref: ScopedThreadRef) {
  const store = useRightPanelStore.getState();
  // A side chat's panel actions land in its parent's panel, so read that panel too.
  const panel = store.byThreadKey[scopedThreadKey(rightPanelHostRef(ref))];
  if (panel?.isOpen && panel.activeSurfaceId === "voice") store.closeSurface(ref, "voice");
  else store.open(ref, "voice");
}
export async function connectVoiceMicrophone() {
  if (voiceSession.getSnapshot().status === "disabled") return;
  await voiceAudio.connect(async (nextHandlers) => {
    handlers = nextHandlers;
    audioEpoch = 0;
    await voiceSession.connect();
    if (voiceSession.getSnapshot().status !== "connected")
      throw new Error("Gemini did not connect.");
    nextHandlers.event({ type: "control", state: "listening" });
    return {
      offer: async (bytes) => {
        voiceSession.sendAudio(btoa(String.fromCharCode(...bytes)));
        return true;
      },
      control: async (action) => {
        if (action === "interrupt-response") voiceSession.interrupt();
        else if (action === "mute") voiceSession.endAudio();
        return true;
      },
      dispose: async () => {
        handlers = null;
        voiceSession.disconnect();
      },
    };
  });
}
export function disconnectVoice() {
  voiceSession.disconnect();
  void voiceAudio.disconnect();
}
export function muteVoice() {
  void (voiceAudio.snapshot().muted ? voiceAudio.resume() : voiceAudio.mute());
}
