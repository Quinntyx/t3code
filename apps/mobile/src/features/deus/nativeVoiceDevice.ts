import { requireOptionalNativeModule } from "expo";
import { requestRecordingPermissionsAsync } from "expo-audio";
import * as Base64 from "effect/encoding/Base64";
import * as Result from "effect/Result";
import type { NativeVoiceDevice, NativeVoiceEvent } from "./NativeVoiceAudio";

interface VoiceModule {
  start(id: number): Promise<void>;
  stop(id: number): void;
  mute(id: number, muted: boolean): void;
  acknowledge(id: number): void;
  flush(id: number, epoch: number): void;
  play(id: number, pcm: string, epoch: number): void;
  addListener(
    name: "voiceEvent",
    listener: (event: Omit<NativeVoiceEvent, "bytes"> & { pcm?: string }) => void,
  ): { remove(): void };
}
const native = requireOptionalNativeModule<VoiceModule>("T3VoiceAudio");

export const nativeVoiceDevice: NativeVoiceDevice = {
  available: native !== null,
  requestPermission: async () => (await requestRecordingPermissionsAsync()).granted,
  subscribe: (listener) => {
    const subscription = native?.addListener("voiceEvent", (event) => {
      let bytes: Uint8Array | undefined;
      if (event.type === "pcm") {
        const decoded = event.pcm?.length === 856 ? Base64.decode(event.pcm) : null;
        if (!decoded || Result.isFailure(decoded) || decoded.success.length !== 640) {
          void listener({
            id: event.id,
            type: "error",
            message: "Invalid native microphone frame.",
          }).catch(() => {});
          return;
        }
        bytes = decoded.success;
      }
      void listener({ ...event, ...(bytes ? { bytes } : {}) }).catch(() => {});
    });
    return () => subscription?.remove();
  },
  start: async (id) => {
    if (!native) throw new Error("Native duplex audio is unavailable in this binary.");
    await native.start(id);
  },
  stop: (id) => native?.stop(id),
  mute: (id, muted) => native?.mute(id, muted),
  acknowledge: (id) => native?.acknowledge(id),
  flush: (id, epoch) => native?.flush(id, epoch),
  play: (id, bytes, epoch) => native?.play(id, Base64.encode(bytes), epoch),
};
