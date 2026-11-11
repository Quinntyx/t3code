import { MICROPHONE_PERMISSION_ERROR } from "@t3tools/client-runtime/voice-input";
import { getClientSettings } from "../hooks/useSettings";
import pcmWorkletUrl from "../speech/pcmWorklet.ts?worker&url";
import { encodePcm16 } from "./pcm";
import type { VoicePlatform } from "./VoiceAudio";
import { AudioMeter } from "./spectrum";

export const browserVoicePlatform: VoicePlatform = {
  check: () => {
    if (!globalThis.isSecureContext)
      throw new Error("Microphone access requires a secure context (HTTPS or localhost).");
    if (
      !navigator.mediaDevices?.getUserMedia ||
      typeof AudioContext === "undefined" ||
      typeof AudioWorkletNode === "undefined"
    )
      throw new Error("This browser does not support full-duplex AudioWorklet audio.");
  },
  createContext: () => new AudioContext({ latencyHint: "interactive" }),
  createMeter: (context) => new AudioMeter(context),
  getUserMedia: async () => {
    // The microphone chosen in Voice settings serves dictation and Voice alike.
    const microphoneId = getClientSettings().voiceMicrophone;
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(microphoneId ? { deviceId: { exact: microphoneId } } : {}),
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: false,
      });
    } catch (error) {
      if (error instanceof DOMException && error.name === "NotAllowedError")
        throw new Error(MICROPHONE_PERMISSION_ERROR, { cause: error });
      throw error;
    }
  },
  createCapture: async (context, stream, onInput, onError, analyser) => {
    await context.audioWorklet.addModule(pcmWorkletUrl);
    if (
      context.state === "closed" ||
      !stream.getTracks().some((track) => track.readyState === "live")
    )
      return { stop: () => {} };
    const source = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, "t3-pcm-capture", {
      channelCount: 1,
      processorOptions: { live: true },
    });
    let stopped = false;
    capture.port.onmessage = ({ data }: MessageEvent<Float32Array | number | string>) => {
      if (stopped || !(data instanceof Float32Array)) return;
      void onInput(encodePcm16(data)).catch(() => {
        if (!stopped) onError(new Error("Microphone input failed."));
      });
    };
    capture.onprocessorerror = () => onError(new Error("Microphone worklet stopped unexpectedly."));
    source.connect(analyser);
    analyser.connect(capture);
    // A silent output keeps capture processing while assistant audio plays on the same context.
    capture.connect(context.destination);
    capture.port.postMessage("start", []);
    return {
      stop: () => {
        stopped = true;
        capture.onprocessorerror = null;
        capture.port.onmessage = null;
        capture.port.postMessage("stop", []);
        capture.port.close();
        source.disconnect();
        analyser.disconnect(capture);
        capture.disconnect();
      },
    };
  },
  watchPermission: async (revoked) => {
    if (!navigator.permissions) return () => {};
    try {
      const permission = await navigator.permissions.query({
        name: "microphone" as PermissionName,
      });
      const changed = () => {
        if (permission.state === "denied") revoked();
      };
      permission.addEventListener("change", changed);
      changed();
      return () => permission.removeEventListener("change", changed);
    } catch {
      return () => {};
    }
  },
};
