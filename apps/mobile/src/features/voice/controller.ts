import { createVoiceClient } from "@t3tools/client-runtime/voice/client";
import { createVoicePreferences } from "@t3tools/client-runtime/voice/storage";
import * as SecureStore from "expo-secure-store";
import Storage from "expo-sqlite/kv-store";

import { connectionAtomRuntime } from "../../connection/runtime";
import { environmentCatalog } from "../../connection/catalog";
import { whenProtectedDataAvailable } from "../../lib/protectedData";
import { uuidv4 } from "../../lib/uuid";
import { appAtomRegistry } from "../../state/atom-registry";
import { serverEnvironment } from "../../state/server";
import { environmentShell } from "../../state/shell";
import { environmentThreads } from "../../state/threads";
import { NativeVoiceAudio } from "./NativeVoiceAudio";
import { nativeVoiceDevice } from "./nativeVoiceDevice";

const KEY = "t3code.voice.key";
/** This device's Gemini key, kept in the OS keychain/keystore. */
export const voiceKey = {
  async read() {
    await whenProtectedDataAvailable();
    return (await SecureStore.getItemAsync(KEY))?.trim() || null;
  },
  async write(value: string) {
    if (value.trim()) await SecureStore.setItemAsync(KEY, value.trim());
    else await SecureStore.deleteItemAsync(KEY);
  },
};
export const voicePreferences = createVoicePreferences({
  getItem: (key) => Storage.getItemSync(key),
  setItem: (key, value) => Storage.setItemSync(key, value),
  removeItem: (key) => {
    Storage.removeItemSync(key);
  },
});
export const voiceAudio = new NativeVoiceAudio(nativeVoiceDevice);
const voice = createVoiceClient({
  registry: appAtomRegistry,
  runtime: connectionAtomRuntime,
  catalog: environmentCatalog,
  shell: environmentShell,
  server: serverEnvironment,
  threads: environmentThreads,
  storage: { key: voiceKey, ...voicePreferences },
  audio: voiceAudio,
  uuid: uuidv4,
});
export const voiceSession = voice.session;
export const connectVoiceMicrophone = voice.connectMicrophone;
export const disconnectVoice = voice.disconnect;
export const reloadVoice = voice.reload;

let panels = 0;
/** Voice runs while one of its panels is mounted: the phone sheet or a wide layout's inspector. */
export function retainVoice() {
  panels++;
  void voice.open().catch(() => {});
  return () => {
    if (--panels === 0) voice.close();
  };
}
export function muteVoice() {
  void (voiceAudio.snapshot().muted ? voiceAudio.resume() : voiceAudio.mute());
}
