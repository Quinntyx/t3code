import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";
import type { Behavior, LiveConnectConfig, Modality } from "@google/genai";
import { connectLiveSocket } from "./liveSocket.ts";
import type { VoiceConnection, VoiceConnector } from "./session.ts";

class FakeSocket {
  static last: FakeSocket | null = null;
  readonly sent: unknown[] = [];
  binaryType = "blob";
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;
  onclose: ((event: { reason: string }) => void) | null = null;
  readonly url: string;
  constructor(url: string) {
    this.url = url;
    FakeSocket.last = this;
  }
  send(message: string) {
    this.sent.push(JSON.parse(message));
  }
  close() {}
}

const config: LiveConnectConfig = {
  responseModalities: ["AUDIO" as Modality],
  inputAudioTranscription: {},
  outputAudioTranscription: {},
  systemInstruction: "You are Voice.",
  tools: [
    {
      functionDeclarations: [
        { name: "monitor_threads", description: "Watch.", behavior: "NON_BLOCKING" as Behavior },
        {
          name: "read_thread",
          description: "Read a thread.",
          parametersJsonSchema: {
            type: "object",
            properties: { environmentId: { type: "string" }, threadId: { type: "string" } },
            required: ["environmentId", "threadId"],
            additionalProperties: false,
          },
        },
      ],
    },
  ],
};

/** Drives one connector through setup and every message Voice sends, recording the wire. */
async function record(connect: VoiceConnector) {
  const received: unknown[] = [];
  const connecting = connect(
    "test-key",
    { onmessage: (message) => received.push(message) },
    structuredClone(config),
    "gemini-live-test",
  );
  await vi.waitFor(() => expect(FakeSocket.last).not.toBeNull());
  const socket = FakeSocket.last!;
  socket.onopen?.();
  await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
  socket.onmessage?.({ data: JSON.stringify({ setupComplete: {} }) });
  const session: VoiceConnection = await connecting;
  socket.onmessage?.({
    data: new TextEncoder().encode(JSON.stringify({ serverContent: { turnComplete: true } }))
      .buffer,
  });
  session.sendClientContent({
    turns: [{ role: "user", parts: [{ text: "hi" }] }],
    turnComplete: true,
  });
  session.sendRealtimeInput({ audio: { data: "AAAA", mimeType: "audio/pcm;rate=16000" } });
  session.sendRealtimeInput({ audioStreamEnd: true });
  session.sendToolResponse({
    functionResponses: [
      {
        id: "call-1",
        name: "monitor_threads",
        response: { notifications: [] },
        willContinue: true,
        scheduling: "INTERRUPT" as never,
      },
    ],
  });
  await vi.waitFor(() => expect(received).toHaveLength(2));
  return {
    // The SDK joins its base URL with a doubled slash; the documented endpoint has one.
    url: socket.url.replace("googleapis.com//", "googleapis.com/"),
    sent: socket.sent,
    // The SDK delivers LiveServerMessage instances; Voice reads only their fields.
    received: JSON.parse(JSON.stringify(received)),
  };
}

describe("Gemini Live socket", () => {
  beforeEach(() => {
    FakeSocket.last = null;
    vi.stubGlobal("WebSocket", FakeSocket);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("speaks the same wire protocol as the SDK's Live client", async () => {
    const { GoogleGenAI } = await import("@google/genai/web");
    const sdk = await record((key, callbacks, liveConfig, model) =>
      new GoogleGenAI({ apiKey: key, httpOptions: { apiVersion: "v1alpha" } }).live.connect({
        model,
        config: liveConfig,
        callbacks,
      }),
    );
    FakeSocket.last = null;
    const socket = await record(connectLiveSocket);
    expect(socket).toEqual(sdk);
  });

  it("rejects when Gemini closes before setup completes", async () => {
    const connecting = connectLiveSocket("test-key", { onmessage: () => {} }, config, "model");
    FakeSocket.last!.onclose?.({ reason: "API key not valid." });
    await expect(connecting).rejects.toThrow("API key not valid.");
  });
});
