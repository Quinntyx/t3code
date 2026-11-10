import type { LiveCallbacks, LiveServerMessage } from "@google/genai";
import type { VoiceConnection, VoiceConnector } from "./session.ts";

const LIVE_ENDPOINT =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContent";

/**
 * Gemini Live over the platform WebSocket, sending the same messages as the SDK's Live client.
 * React Native can't run that client: it assigns `URL.protocol`, which RN's URL doesn't support.
 */
export const connectLiveSocket: VoiceConnector = (key, callbacks, config, model) =>
  new Promise<VoiceConnection>((resolve, reject) => {
    if (/\.\.|[?&]/.test(model)) throw new Error("Invalid Live model.");
    const socket = new WebSocket(`${LIVE_ENDPOINT}?key=${encodeURIComponent(key)}`);
    socket.binaryType = "arraybuffer";
    const send = (message: unknown) => socket.send(JSON.stringify(message));
    const connection: VoiceConnection = {
      sendClientContent: ({ turns, turnComplete }) =>
        send({ clientContent: { turns, turnComplete } }),
      sendToolResponse: ({ functionResponses }) => send({ toolResponse: { functionResponses } }),
      sendRealtimeInput: (input) => send({ realtimeInput: input }),
      close: () => socket.close(),
    };
    let ready = false;
    const fail = (reason: string) => {
      if (!ready) reject(new Error(reason));
    };
    socket.onopen = () => {
      callbacks.onopen?.();
      const { responseModalities, systemInstruction, ...setup } = config;
      send({
        setup: {
          model: model.startsWith("models/") ? model : `models/${model}`,
          generationConfig: { responseModalities },
          ...(typeof systemInstruction === "string"
            ? { systemInstruction: { parts: [{ text: systemInstruction }], role: "user" } }
            : {}),
          ...setup,
        },
      });
    };
    socket.onmessage = (event) => {
      const data: unknown = event.data;
      const message = JSON.parse(
        typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer),
      ) as LiveServerMessage;
      if (!ready && message.setupComplete) {
        ready = true;
        resolve(connection);
      }
      callbacks.onmessage(message);
    };
    socket.onerror = (event) => {
      callbacks.onerror?.(event as Parameters<NonNullable<LiveCallbacks["onerror"]>>[0]);
      fail("Gemini Live connection failed.");
    };
    socket.onclose = (event) => {
      callbacks.onclose?.(event);
      fail(event.reason || "Gemini Live closed during setup.");
    };
  });
