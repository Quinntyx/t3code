import type {
  Behavior,
  Modality,
  FunctionDeclaration,
  LiveCallbacks,
  LiveConnectConfig,
  LiveServerMessage,
  Session,
} from "@google/genai";
import { mFallback, msg } from "gt-i18n";
import type { MFunctionType } from "gt-i18n/types";
import { notificationScheduling, type VoiceNotificationFeed } from "./notifications.ts";

export interface VoiceKeyStore {
  readonly read: () => Promise<string | null>;
}
export type VoiceConnection = Pick<
  Session,
  "sendClientContent" | "sendToolResponse" | "sendRealtimeInput" | "close"
>;
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

const connectLive: VoiceConnector = async (key, callbacks, config, model) => {
  const { GoogleGenAI } = await import("@google/genai");
  return new GoogleGenAI({ apiKey: key, httpOptions: { apiVersion: "v1alpha" } }).live.connect({
    model,
    config,
    callbacks,
  });
};

export function createVoiceSession(options: {
  readonly key: VoiceKeyStore;
  readonly model?: () => string;
  readonly feed: VoiceNotificationFeed;
  readonly tools: VoiceTools;
  readonly connector?: VoiceConnector;
  readonly onAudio?: (base64: string) => void;
  readonly onInterrupt?: () => void;
  readonly onDisconnect?: () => void;
  readonly resolve?: MFunctionType;
}) {
  const resolve = options.resolve ?? mFallback;
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
  /** Each role's streaming message; null starts a new one for that role. */
  let streaming: Record<"user" | "voice", string | null> = { user: null, voice: null };
  /** Drops the model's spoken and written reply to the internal setup turn, if it is that turn. */
  let suppressSetupReply = false;
  /** Typed messages held back while the setup reply is hidden. */
  let heldInput: string[] = [];
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
  /**
   * Live transcription streams a turn as many small fragments. They concatenate verbatim (Gemini
   * supplies their own leading spaces) into one message, so a reply reads as a paragraph. Input and
   * output transcription are independent streams: one reply's fragments stay together even while
   * the user's speech for the next turn lands between them.
   */
  const stream = (role: "user" | "voice", text: string) => {
    if (!text) return;
    const current = streaming[role];
    if (current !== null) {
      update({
        messages: state.messages.map((message) =>
          message.id === current ? { ...message, text: message.text + text } : message,
        ),
      });
      return;
    }
    // A turn's first fragment can still carry the separating space from the previous fragment.
    const opening = text.trimStart();
    if (!opening) return;
    const message = { id: String(++nextMessageId), role, text: opening };
    streaming = { ...streaming, [role]: message.id };
    update({ messages: [...state.messages, message].slice(-200) });
  };
  /** Ends a role's streaming message so its next fragment starts a new one. */
  const endStream = (role?: "user" | "voice") => {
    streaming = role === undefined ? { user: null, voice: null } : { ...streaming, [role]: null };
  };
  const requestMonitor = () => {
    // The model answers this internal request out loud; hide that turn's reply.
    suppressSetupReply = true;
    connection?.sendClientContent({
      turns: [
        {
          role: "user",
          parts: [
            {
              // oxlint-disable-next-line t3code/no-untranslated-copy -- prompt sent to the voice model
              text: "Call monitor_threads now to receive client-visible thread notifications. Keep that non-blocking call open.",
            },
          ],
        },
      ],
      turnComplete: true,
    });
  };
  /** Sends what the user typed while the setup turn was still arriving. */
  const sendHeldInput = () => {
    if (!heldInput.length || !connection) return;
    const held = heldInput;
    heldInput = [];
    for (const text of held)
      connection.sendClientContent({
        turns: [{ role: "user", parts: [{ text }] }],
        turnComplete: true,
      });
  };
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
        error: resolve(msg("Could not forward thread notifications. Reconnect to retry.")),
      });
    }
  };
  const receive = (message: LiveServerMessage, generation: number) => {
    if (generation !== epoch) return;
    const content = message.serverContent;
    if (content?.interrupted) {
      endStream();
      suppressSetupReply = false;
      sendHeldInput();
      options.onInterrupt?.();
    }
    if (content?.inputTranscription) {
      stream("user", content.inputTranscription.text ?? "");
      if (content.inputTranscription.finished) endStream("user");
    }
    if (content?.outputTranscription) {
      // A new reply starting after user speech closes that utterance: Gemini can omit `finished`.
      if (streaming.user !== null && streaming.voice === null) endStream("user");
      if (suppressSetupReply)
        // Still finish the turn, just never show or speak it.
        endStream("voice");
      else stream("voice", content.outputTranscription.text ?? "");
      if (content.outputTranscription.finished) endStream("voice");
    }
    for (const part of content?.modelTurn?.parts ?? []) {
      const audio = part.inlineData?.data;
      if (audio && part.inlineData?.mimeType?.startsWith("audio/") && !suppressSetupReply)
        options.onAudio?.(audio);
      if (part.text && !content?.outputTranscription && !suppressSetupReply)
        append("voice", part.text);
    }
    if (content?.turnComplete || content?.generationComplete) {
      // The model's end of turn says nothing about the independent input transcription.
      endStream("voice");
      suppressSetupReply = false;
      sendHeldInput();
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
                      // oxlint-disable-next-line t3code/no-untranslated-copy -- tool error sent to the voice model
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
    endStream();
    suppressSetupReply = false;
    heldInput = [];
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
      const live = await (options.connector ?? connectLive)(
        key,
        {
          onmessage: (message) => receive(message, generation),
          onerror: () => {
            if (generation !== epoch) return;
            disconnect();
            options.onDisconnect?.();
            update({
              status: "error",
              error: resolve(msg("Gemini connection failed. Check your device key and reconnect.")),
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
            "You are Voice, an assistant inside this T3 client. Use tools only for environments and threads this client can see. Never invent capabilities or claim a notification was heard by another client. When the user asks how their threads are doing, what needs them, or for a status update, call list_threads (it covers every environment) and answer from its status, needsUser and lastError fields; never guess a thread's state. Call read_thread before answering about a thread's work or a pending request. Call monitor_threads once at session start and keep the non-blocking generator open; re-establish it if cancelled. Read pending requests before answering them. Ask the user before destructive work or permission decisions. Text and voice are one conversation.",
          tools: [
            {
              functionDeclarations: [
                {
                  name: "monitor_threads",
                  // oxlint-disable-next-line t3code/no-untranslated-copy -- tool description sent to the voice model
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
              error: resolve(msg("Could not connect to Gemini. Check the device key and retry.")),
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
            error: resolve(
              msg(
                "Could not read the device key. Check browser storage or unlock the desktop keyring.",
              ),
            ),
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
      // Typed text is its own message; it never joins a streamed transcript.
      endStream();
      const typed = text.trim();
      append("user", typed);
      // The setup turn's reply must stay hidden to its own end, so typing shows at once but waits
      // to reach Gemini until then; otherwise the reply would answer this text and leak.
      if (suppressSetupReply) heldInput.push(typed);
      else
        connection.sendClientContent({
          turns: [{ role: "user", parts: [{ text: typed }] }],
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
          {
            role: "user",
            parts: [
              {
                // oxlint-disable-next-line t3code/no-untranslated-copy -- prompt sent to the voice model
                text: "Stop speaking and wait for my next instruction.",
              },
            ],
          },
        ],
        turnComplete: true,
      });
    },
  };
}
