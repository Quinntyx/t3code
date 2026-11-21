import { createVoiceSession } from "@t3tools/client-runtime/voice/session";
import {
  createNotificationFeed,
  notificationsFromShell,
  type VoiceNotification,
} from "@t3tools/client-runtime/voice/notifications";
import { awaitAtomValue } from "@t3tools/client-runtime/voice/awaitAtom";
import { createVoiceTools, type VoiceEnvironmentView } from "@t3tools/client-runtime/voice/tools";
import { createEnvironmentRpcCommand } from "@t3tools/client-runtime/state/runtime";
import { unloadedOlderSettledCount } from "@t3tools/client-runtime/state/threads";
import { ORCHESTRATION_V2_WS_METHODS, ThreadId, type EnvironmentId } from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentShell, liveShellEnvironmentIdsAtom } from "../state/shell";
import { environmentThreads, olderSettledThreads } from "../state/threads";
import { serverEnvironment } from "../state/server";
import { randomUUID } from "../lib/utils";
import { useRightPanelStore } from "../rightPanelStore";
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
        olderSettledOmitted: unloadedOlderSettledCount({
          olderSettled: () => get(olderSettledThreads.olderSettledAtom(environmentId)),
          scopes: [{ environmentId, projectIds: null }],
          threads: snapshot.threads.map((thread) => ({ environmentId, source: thread })),
        }),
        threads: snapshot.threads.map((thread) => ({
          id: thread.id,
          title: thread.title,
          status: thread.status,
          projectId: thread.projectId,
          activeRunId: thread.activeRunId,
          archivedAt: thread.archivedAt === null ? null : DateTime.formatIso(thread.archivedAt),
          latestRunStartedAt:
            thread.latestRunStartedAt === undefined || thread.latestRunStartedAt === null
              ? null
              : DateTime.formatIso(thread.latestRunStartedAt),
          latestRunCompletedAt:
            thread.latestRunCompletedAt === undefined || thread.latestRunCompletedAt === null
              ? null
              : DateTime.formatIso(thread.latestRunCompletedAt),
          // What the shell already carries for every listed thread decides whether it needs the user.
          pendingRequest: thread.pendingRuntimeRequest,
          lastError: thread.lastError ?? null,
        })),
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
/** Starts the client session for the app-wide Voice surface; it ends when Voice closes. */
export async function openVoiceSession() {
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
  unwatchNotifications?.();
  unwatchNotifications = null;
  voiceSession.close();
  void voiceAudio.disconnect();
}
/** Opens or closes the one app-wide Voice surface; the session follows that state. */
export function setVoiceOpen(open: boolean) {
  useRightPanelStore.getState().setVoiceOpen(open);
}
export function toggleVoice() {
  setVoiceOpen(!useRightPanelStore.getState().voiceOpen);
}
/** Selecting the Voice tab brings it to the front of whichever panel is on screen. */
export function activateVoice() {
  const store = useRightPanelStore.getState();
  store.setVoiceOpen(true);
  store.setVoiceActive(true);
}
// Session lifetime follows the app-wide open state, whichever entry point changed it.
useRightPanelStore.subscribe((state, previous) => {
  if (state.voiceOpen === previous.voiceOpen) return;
  if (state.voiceOpen) void openVoiceSession().catch(() => {});
  else closeVoiceSession();
});
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
