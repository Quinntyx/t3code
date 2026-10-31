import captureWorkletUrl from "./capture-worklet.ts?worker&url";
import type { VoicePlatform } from "./VoiceAudio";

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
  getUserMedia: () =>
    navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
      video: false,
    }),
  createCapture: async (context, stream, onInput, onError) => {
    await context.audioWorklet.addModule(captureWorkletUrl);
    if (
      context.state === "closed" ||
      !stream.getTracks().some((track) => track.readyState === "live")
    )
      return { stop: () => {} };
    const source = context.createMediaStreamSource(stream);
    const capture = new AudioWorkletNode(context, "deus-capture", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: "explicit",
    });
    let stopped = false;
    capture.port.onmessage = (event: MessageEvent<unknown>) => {
      if (stopped) return;
      if (!(event.data instanceof Uint8Array) || event.data.byteLength !== 640) {
        onError(new Error("Microphone worklet exceeded its bounded frame queue."));
        return;
      }
      void onInput(event.data).then(
        (accepted) => {
          if (!stopped && accepted) capture.port.postMessage("ack", []);
        },
        () => {
          if (!stopped) onError(new Error("Microphone input failed."));
        },
      );
    };
    capture.onprocessorerror = () => onError(new Error("Microphone worklet stopped unexpectedly."));
    source.connect(capture);
    // A silent output keeps capture processing while assistant audio plays on the same context.
    capture.connect(context.destination);
    return {
      stop: () => {
        stopped = true;
        capture.onprocessorerror = null;
        capture.port.onmessage = null;
        capture.port.postMessage("stop", []);
        capture.port.close();
        source.disconnect();
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
