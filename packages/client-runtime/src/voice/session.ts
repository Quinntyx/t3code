import type {
  Behavior,
  Blob as LiveBlob,
  Content,
  FunctionDeclaration,
  FunctionResponse,
  LiveCallbacks,
  LiveConnectConfig,
  LiveServerMessage,
  Modality,
} from "@google/genai";
import { connectLiveSocket } from "./liveSocket.ts";
import { notificationScheduling, type VoiceNotificationFeed } from "./notifications.ts";

export interface VoiceKeyStore {
  readonly read: () => Promise<string | null>;
}
/** The Live messages Voice sends; the SDK's `Session` satisfies it too. */
export interface VoiceConnection {
  readonly sendClientContent: (params: {
    readonly turns: Content[];
    readonly turnComplete: boolean;
  }) => void;
  readonly sendToolResponse: (params: { readonly functionResponses: FunctionResponse[] }) => void;
  readonly sendRealtimeInput: (
    params: { readonly audio: LiveBlob } | { readonly audioStreamEnd: true },
  ) => void;
  readonly close: () => void;
}
export type VoiceConnector = (
  key: string,
  callbacks: LiveCallbacks,
  config: LiveConnectConfig,
  model: string,
) => Promise<VoiceConnection>;
export interface VoiceTools {
  readonly declarations: ReadonlyArray<FunctionDeclaration>;
  readonly execute: (name: string, args: Record<string, unknown>) => Promise<unknown>;
}
export interface VoiceToolActivity {
  readonly id: string;
  readonly name: string;
  readonly status: "running" | "completed" | "failed" | "disconnected";
  readonly target: { readonly environmentId: string; readonly threadId: string } | null;
}
export interface VoiceSessionState {
  readonly open: boolean;
  readonly status: "disabled" | "idle" | "connecting" | "connected" | "error";
  readonly messages: ReadonlyArray<{
    readonly id: string;
    readonly role: "user" | "voice";
    readonly text: string;
  }>;
  readonly error: string | null;
  readonly activity: ReadonlyArray<VoiceToolActivity>;
}

export const DEFAULT_VOICE_LIVE_MODEL = "gemini-2.5-flash-native-audio-preview-09-2025";

export function createVoiceSession(options: {
  readonly key: VoiceKeyStore;
  readonly model?: () => string;
  readonly feed: VoiceNotificationFeed;
  readonly tools: VoiceTools;
  readonly connector?: VoiceConnector;
  readonly onAudio?: (base64: string) => void;
  readonly onInterrupt?: () => void;
  readonly onDisconnect?: () => void;
}) {
  let state: VoiceSessionState = {
    open: false,
    status: "disabled",
    messages: [],
    activity: [],
    error: null,
  };
  const listeners = new Set<() => void>();
  let nextMessageId = 0;
  let connection: VoiceConnection | null = null;
  let connecting: Promise<void> | null = null;
  let epoch = 0;
  let openRevision = 0;
  let monitorId: string | null = null;
  let unsubscribe: (() => void) | null = null;
  const update = (patch: Partial<VoiceSessionState>) => {
    state = { ...state, ...patch };
    for (const listener of listeners) listener();
  };
  const append = (role: "user" | "voice", text: string) => {
    if (text)
      update({
        messages: [...state.messages, { id: String(++nextMessageId), role, text }].slice(-200),
      });
  };
  const requestMonitor = () =>
    connection?.sendClientContent({
      turns: [
        {
          role: "user",
          parts: [
            {
              text: "Call monitor_threads now to receive client-visible thread notifications. Keep that non-blocking call open.",
            },
          ],
        },
      ],
      turnComplete: true,
    });
  const flush = () => {
    if (!state.open || !connection || !monitorId) return;
    const notifications = options.feed.unseen();
    if (!notifications.length) return;
    const urgency = notifications.some((notice) => notice.urgency === "interrupt")
      ? "interrupt"
      : notifications.some((notice) => notice.urgency === "when_idle")
        ? "when_idle"
        : "silent";
    try {
      connection.sendToolResponse({
        functionResponses: [
          {
            id: monitorId,
            name: "monitor_threads",
            response: { notifications },
            willContinue: true,
            scheduling: notificationScheduling(urgency),
          },
        ],
      });
      options.feed.mark(notifications);
    } catch {
      update({
        status: "error",
        error: "Could not forward thread notifications. Reconnect to retry.",
      });
    }
  };
  const receive = (message: LiveServerMessage, generation: number) => {
    if (generation !== epoch) return;
    if (message.serverContent?.interrupted) options.onInterrupt?.();
    const content = message.serverContent;
    if (content?.inputTranscription?.text) append("user", content.inputTranscription.text);
    if (content?.outputTranscription?.text) append("voice", content.outputTranscription.text);
    for (const part of content?.modelTurn?.parts ?? []) {
      if (part.inlineData?.data && part.inlineData.mimeType?.startsWith("audio/"))
        options.onAudio?.(part.inlineData.data);
      if (part.text && !content?.outputTranscription) append("voice", part.text);
    }
    if (monitorId && message.toolCallCancellation?.ids?.includes(monitorId)) {
      monitorId = null;
      requestMonitor();
    }
    for (const call of message.toolCall?.functionCalls ?? []) {
      if (!call.id || !call.name) continue;
      if (call.name === "monitor_threads") {
        monitorId = call.id;
        flush();
        continue;
      }
      const id = call.id;
      const name = call.name;
      const args = call.args ?? {};
      const target = (threadId: unknown) =>
        typeof args.environmentId === "string" && typeof threadId === "string"
          ? { environmentId: args.environmentId, threadId }
          : null;
      update({
        activity: [
          ...state.activity,
          { id, name, status: "running" as const, target: target(args.threadId) },
        ].slice(-100),
      });
      const finish = (status: "completed" | "failed", result?: unknown) => {
        if (generation !== epoch) return;
        const resultThread =
          result && typeof result === "object" && "threadId" in result ? result.threadId : null;
        update({
          activity: state.activity.map((item) =>
            item.id === id
              ? { ...item, status, target: target(resultThread) ?? item.target }
              : item,
          ),
        });
      };
      void options.tools.execute(name, args).then(
        (result) => {
          finish("completed", result);
          if (generation === epoch)
            connection?.sendToolResponse({
              functionResponses: [{ id, name, response: { result } }],
            });
        },
        () => {
          finish("failed");
          if (generation === epoch)
            connection?.sendToolResponse({
              functionResponses: [
                {
                  id,
                  name,
                  response: {
                    error:
                      "The client could not execute this tool. Check visibility, permissions and input.",
                  },
                },
              ],
            });
        },
      );
    }
  };
  const disconnect = () => {
    epoch++;
    connection?.close();
    connection = null;
    connecting = null;
    monitorId = null;
    options.onInterrupt?.();
    update({
      status: state.status === "disabled" ? "disabled" : "idle",
      activity: state.activity.map((item) =>
        item.status === "running" ? { ...item, status: "disconnected" } : item,
      ),
    });
  };
  const connect = async () => {
    if (connection) return;
    if (connecting) return connecting;
    const generation = ++epoch;
    connecting = (async () => {
      const key = await options.key.read();
      if (!key) {
        update({ status: "disabled" });
        throw new Error("Enter a device-local Gemini API key first.");
      }
      if (generation !== epoch) return;
      update({ status: "connecting", error: null });
      const live = await (options.connector ?? connectLiveSocket)(
        key,
        {
          onmessage: (message) => receive(message, generation),
          onerror: () => {
            if (generation !== epoch) return;
            disconnect();
            options.onDisconnect?.();
            update({
              status: "error",
              error: "Gemini connection failed. Check your device key and reconnect.",
            });
          },
          onclose: () => {
            if (generation !== epoch) return;
            disconnect();
            options.onDisconnect?.();
          },
        },
        {
          responseModalities: ["AUDIO" as Modality],
          inputAudioTranscription: {},
          outputAudioTranscription: {},
          systemInstruction:
            "You are Voice, an assistant inside this T3 client. Use tools only for environments and threads this client can see. Never invent capabilities or claim a notification was heard by another client. Call monitor_threads once at session start and keep the non-blocking generator open; re-establish it if cancelled. Read pending requests before answering them. Ask the user before destructive work or permission decisions. Text and voice are one conversation.",
          tools: [
            {
              functionDeclarations: [
                {
                  name: "monitor_threads",
                  description: "Receive visible thread notifications until disconnected.",
                  behavior: "NON_BLOCKING" as Behavior,
                },
                ...options.tools.declarations,
              ],
            },
          ],
        },
        options.model?.() ?? DEFAULT_VOICE_LIVE_MODEL,
      );
      if (generation !== epoch) {
        live.close();
        return;
      }
      connection = live;
      update({ status: "connected" });
      requestMonitor();
      flush();
    })()
      .catch((error: unknown) => {
        if (generation === epoch) {
          disconnect();
          options.onDisconnect?.();
          if (state.status !== "disabled")
            update({
              status: "error",
              error: "Could not connect to Gemini. Check the device key and retry.",
            });
        }
        throw error;
      })
      .finally(() => {
        if (generation === epoch) connecting = null;
      });
    return connecting;
  };
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    async open() {
      const revision = ++openRevision;
      update({ open: true, error: null });
      let key: string | null;
      try {
        key = await options.key.read();
      } catch {
        if (revision === openRevision)
          update({
            status: "disabled",
            error:
              "Could not read the device key. Check browser storage or unlock the desktop keyring.",
          });
        return;
      }
      if (revision !== openRevision) return;
      update({ status: key ? (connection ? "connected" : "idle") : "disabled" });
      unsubscribe ??= options.feed.subscribe(flush);
      if (key) await connect().catch(() => {});
      flush();
    },
    close() {
      openRevision++;
      unsubscribe?.();
      unsubscribe = null;
      disconnect();
      update({ open: false });
    },
    connect,
    disconnect,
    async sendText(text: string) {
      if (!text.trim()) return;
      await connect();
      if (!connection) return;
      append("user", text.trim());
      connection.sendClientContent({
        turns: [{ role: "user", parts: [{ text: text.trim() }] }],
        turnComplete: true,
      });
    },
    sendAudio(data: string) {
      connection?.sendRealtimeInput({ audio: { data, mimeType: "audio/pcm;rate=16000" } });
    },
    endAudio() {
      connection?.sendRealtimeInput({ audioStreamEnd: true });
    },
    interrupt() {
      options.onInterrupt?.();
      connection?.sendClientContent({
        turns: [
          { role: "user", parts: [{ text: "Stop speaking and wait for my next instruction." }] },
        ],
        turnComplete: true,
      });
    },
  };
}
