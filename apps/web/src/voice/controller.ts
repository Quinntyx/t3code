import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { createVoiceClient } from "@t3tools/client-runtime/voice/client";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { connectionAtomRuntime } from "../connection/runtime";
import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentShell } from "../state/shell";
import { environmentThreads } from "../state/threads";
import { serverEnvironment } from "../state/server";
import { randomUUID } from "../lib/utils";
import { useRightPanelStore, type RightPanelStoreState } from "../rightPanelStore";
import { browserVoicePlatform } from "./browserAudio";
import { VoiceAudio } from "./VoiceAudio";
import { createVoiceStorage } from "./storage";

export const voiceStorage = createVoiceStorage(
  {
    getItem: (key) => window.localStorage.getItem(key),
    setItem: (key, value) => window.localStorage.setItem(key, value),
    removeItem: (key) => window.localStorage.removeItem(key),
  },
  window.desktopBridge,
);
export const voiceAudio = new VoiceAudio(browserVoicePlatform);
const voice = createVoiceClient({
  registry: appAtomRegistry,
  runtime: connectionAtomRuntime,
  catalog: environmentCatalog,
  shell: environmentShell,
  server: serverEnvironment,
  threads: environmentThreads,
  storage: voiceStorage,
  audio: voiceAudio,
  uuid: randomUUID,
});
export const voiceSession = voice.session;
export const connectVoiceMicrophone = voice.connectMicrophone;
export const disconnectVoice = voice.disconnect;
export const reloadVoice = voice.reload;

const showsVoice = (state: Pick<RightPanelStoreState, "byThreadKey">) =>
  Object.values(state.byThreadKey).some((panel) =>
    panel.surfaces.some((surface) => surface.kind === "voice"),
  );
let unwatchPanels: (() => void) | null = null;
/** Starts the client session for a rendered Voice surface; it ends once no thread shows Voice. */
export async function openVoiceSession() {
  unwatchPanels ??= useRightPanelStore.subscribe((state) => {
    if (showsVoice(state)) return;
    unwatchPanels?.();
    unwatchPanels = null;
    voice.close();
  });
  await voice.open();
}
/** Shows Voice in the thread navigated to, without touching a panel that already shows it. */
export function followVoiceInto(ref: ScopedThreadRef) {
  const store = useRightPanelStore.getState();
  const panel = store.byThreadKey[scopedThreadKey(ref)];
  if (!(panel?.isOpen && panel.activeSurfaceId === "voice")) store.open(ref, "voice");
}
/** Voice is a right-panel surface of whichever thread is on screen. */
export function toggleVoice(ref: ScopedThreadRef) {
  const store = useRightPanelStore.getState();
  const panel = store.byThreadKey[scopedThreadKey(ref)];
  if (panel?.isOpen && panel.activeSurfaceId === "voice") store.closeSurface(ref, "voice");
  else store.open(ref, "voice");
}
export function muteVoice() {
  void (voiceAudio.snapshot().muted ? voiceAudio.resume() : voiceAudio.mute());
}
