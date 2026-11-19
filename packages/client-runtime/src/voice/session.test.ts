import { describe, expect, it } from "@effect/vitest";
import { LiveServerMessage } from "@google/genai";
import { createVoiceSession, type VoiceConnection, type VoiceConnector } from "./session.ts";
import {
  createNotificationFeed,
  notificationScheduling,
  notificationsFromShell,
} from "./notifications.ts";
import { applyShellStreamEvent, mergeShellSnapshotProjects } from "../state/shellReducer.ts";
import { v2ShellSnapshot, v2ThreadShell } from "../state/orchestrationV2TestFixtures.ts";
import { ThreadId, TurnItemId, type OrchestrationV2ShellSnapshot } from "@t3tools/contracts";

function setup(
  key: string | null = "fake-key",
  visible = true,
  failInitialSend = false,
  toolResult: unknown = { ok: true },
  onAudio?: (data: string) => void,
) {
  const responses: unknown[] = [];
  const content: unknown[] = [];
  const audio: string[] = [];
  let receive: (message: LiveServerMessage) => void = () => {};
  let remoteClose = () => {};
  let disconnected = 0;
  let connections = 0;
  let closed = 0;
  const seen = new Set<string>();
  const feed = createNotificationFeed(
    { has: (id) => seen.has(id), mark: (ids) => ids.forEach((id) => seen.add(id)) },
    (notice) => visible && notice.environmentId === "env-a" && notice.threadId === "thread-a",
  );
  const connector: VoiceConnector = async (_key, callbacks) => {
    connections++;
    receive = callbacks.onmessage;
    remoteClose = () => callbacks.onclose?.(new Event("close") as CloseEvent);
    return {
      sendClientContent: (input) => {
        if (failInitialSend) throw new Error("fake closed socket");
        content.push(input);
      },
      sendToolResponse: (input) => {
        responses.push(input);
      },
      sendRealtimeInput: () => {},
      close: () => {
        closed++;
      },
    } satisfies VoiceConnection;
  };
  const session = createVoiceSession({
    key: { read: async () => key },
    connector,
    feed,
    onDisconnect: () => {
      disconnected++;
    },
    onAudio: (data) => {
      audio.push(data);
      onAudio?.(data);
    },
    tools: { declarations: [], execute: async () => toolResult },
  });
  return {
    session,
    feed,
    responses,
    content,
    seen,
    audio,
    receive: (message: Partial<LiveServerMessage>) =>
      receive(Object.assign(new LiveServerMessage(), message)),
    remoteClose: () => remoteClose(),
    disconnected: () => disconnected,
    connections: () => connections,
    closed: () => closed,
  };
}

const notice = (id: string, urgency: "interrupt" | "when_idle" | "silent" = "when_idle") => ({
  id,
  environmentId: "env-a",
  threadId: "thread-a",
  title: "Build",
  message: "Needs input",
  urgency,
});

describe("client Voice", () => {
  it("merges streamed transcription fragments into one readable message per turn", async () => {
    const state = setup();
    await state.session.open();
    state.receive({ serverContent: { turnComplete: true } });
    // Measured Live output fragments carry their own leading spaces and arrive a few words at a
    // time; one message per fragment renders as a column of two-word paragraphs.
    for (const text of ["Event sourcing", " lets", " you replay", " events."])
      state.receive({ serverContent: { outputTranscription: { text } } });
    expect(state.session.getSnapshot().messages).toMatchObject([
      { role: "voice", text: "Event sourcing lets you replay events." },
    ]);
    state.receive({ serverContent: { outputTranscription: { text: " Then inspect them." } } });
    expect(state.session.getSnapshot().messages).toHaveLength(1);
    expect(state.session.getSnapshot().messages[0]?.text).toBe(
      "Event sourcing lets you replay events. Then inspect them.",
    );
    state.receive({ serverContent: { turnComplete: true } });
    state.receive({ serverContent: { outputTranscription: { text: "A new turn." } } });
    expect(state.session.getSnapshot().messages).toMatchObject([
      { role: "voice", text: "Event sourcing lets you replay events. Then inspect them." },
      { role: "voice", text: "A new turn." },
    ]);
    state.session.close();
  });

  it("keeps user speech, voice turns and typed text as separate messages", async () => {
    const state = setup();
    await state.session.open();
    state.receive({ serverContent: { turnComplete: true } });
    await state.session.sendText("how are my threads doing");
    state.receive({ serverContent: { inputTranscription: { text: " and then" } } });
    state.receive({ serverContent: { inputTranscription: { text: " the diff", finished: true } } });
    state.receive({ serverContent: { outputTranscription: { text: "Two" } } });
    state.receive({ serverContent: { outputTranscription: { text: " running." } } });
    state.receive({ serverContent: { inputTranscription: { text: "Thanks", finished: true } } });
    state.receive({ serverContent: { outputTranscription: { text: "Anytime." } } });
    // Input and output transcription interleave, so each role keeps its own message: the reply's
    // next fragment still belongs to the reply, not to the speech that landed between them.
    expect(state.session.getSnapshot().messages.map(({ role, text }) => [role, text])).toEqual([
      ["user", "how are my threads doing"],
      ["user", "and then the diff"],
      ["voice", "Two running.Anytime."],
      ["user", "Thanks"],
    ]);
    state.receive({ serverContent: { interrupted: true } });
    state.receive({ serverContent: { outputTranscription: { text: "Cut off." } } });
    expect(state.session.getSnapshot().messages.at(-1)).toMatchObject({
      role: "voice",
      text: "Cut off.",
    });
    state.session.close();
  });

  it("starts a new message when a transcription stream reports it finished", async () => {
    const state = setup();
    await state.session.open();
    state.receive({ serverContent: { turnComplete: true } });
    state.receive({ serverContent: { outputTranscription: { text: "First reply." } } });
    state.receive({ serverContent: { outputTranscription: { text: "", finished: true } } });
    state.receive({ serverContent: { outputTranscription: { text: "Second reply." } } });
    state.receive({ serverContent: { inputTranscription: { text: "Next question." } } });
    state.receive({ serverContent: { inputTranscription: { text: "", finished: true } } });
    state.receive({ serverContent: { inputTranscription: { text: "One more." } } });
    expect(state.session.getSnapshot().messages.map(({ role, text }) => [role, text])).toEqual([
      ["voice", "First reply."],
      ["voice", "Second reply."],
      ["user", "Next question."],
      ["user", "One more."],
    ]);
    state.session.close();
  });

  it("hides the reply to the internal monitor setup without swallowing the next real turn", async () => {
    const state = setup();
    await state.session.open();
    // The setup turn's model reply is dropped from the transcript and never spoken.
    state.receive({
      serverContent: { outputTranscription: { text: " Right, monitoring." } },
    });
    state.receive({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { data: "AAA", mimeType: "audio/pcm;rate=24000" } }],
        },
      },
    });
    expect(state.session.getSnapshot().messages).toEqual([]);
    expect(state.audio).toEqual([]);
    state.receive({ serverContent: { turnComplete: true } });
    // The next turn is a real answer.
    state.receive({ serverContent: { inputTranscription: { text: "What needs me?" } } });
    state.receive({ serverContent: { outputTranscription: { text: "Two threads." } } });
    state.receive({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { data: "BBB", mimeType: "audio/pcm;rate=24000" } }],
        },
      },
    });
    expect(state.session.getSnapshot().messages.map(({ role, text }) => [role, text])).toEqual([
      ["user", "What needs me?"],
      ["voice", "Two threads."],
    ]);
    expect(state.audio).toEqual(["BBB"]);
    state.session.close();
  });

  it("ends a user utterance only on its own boundary, not the model's", async () => {
    const state = setup();
    await state.session.open();
    state.receive({ serverContent: { turnComplete: true } });
    // The previous reply finishes generating while the user is mid-sentence.
    state.receive({ serverContent: { inputTranscription: { text: "How are" } } });
    state.receive({ serverContent: { generationComplete: true } });
    state.receive({ serverContent: { inputTranscription: { text: " my threads?" } } });
    expect(state.session.getSnapshot().messages.map(({ role, text }) => [role, text])).toEqual([
      ["user", "How are my threads?"],
    ]);
    // A reply starting after that speech closes the utterance even without `finished`.
    state.receive({ serverContent: { outputTranscription: { text: "Two running." } } });
    state.receive({ serverContent: { turnComplete: true } });
    state.receive({ serverContent: { inputTranscription: { text: "Thanks" } } });
    state.receive({ serverContent: { outputTranscription: { text: "Anytime." } } });
    expect(state.session.getSnapshot().messages.map(({ role, text }) => [role, text])).toEqual([
      ["user", "How are my threads?"],
      ["voice", "Two running."],
      ["user", "Thanks"],
      ["voice", "Anytime."],
    ]);
    state.session.close();
  });

  it("shows an answer the user asked for while the setup reply is still arriving", async () => {
    const state = setup();
    await state.session.open();
    // Setup turn still pending; the user types before hearing an answer.
    state.receive({ serverContent: { outputTranscription: { text: "Monitori" } } });
    expect(state.session.getSnapshot().messages).toEqual([]);
    await state.session.sendText("what is running?");
    // Their message shows at once, but the setup reply's remainder stays hidden and the text waits.
    expect(state.session.getSnapshot().messages.map(({ role, text }) => [role, text])).toEqual([
      ["user", "what is running?"],
    ]);
    state.receive({ serverContent: { outputTranscription: { text: " is fine." } } });
    state.receive({ serverContent: { turnComplete: true } });
    expect(state.session.getSnapshot().messages.map(({ role, text }) => [role, text])).toEqual([
      ["user", "what is running?"],
    ]);
    // The setup turn's boundary releases the text, and its answer is shown.
    expect(state.content).toHaveLength(2);
    state.receive({ serverContent: { outputTranscription: { text: "Two threads." } } });
    expect(state.session.getSnapshot().messages.map(({ role, text }) => [role, text])).toEqual([
      ["user", "what is running?"],
      ["voice", "Two threads."],
    ]);
    state.session.close();
  });

  it("keeps a setup reply hidden until its own turn ends, even if the user speaks", async () => {
    const state = setup();
    await state.session.open();
    state.receive({ serverContent: { outputTranscription: { text: "Monitoring now." } } });
    state.receive({ serverContent: { inputTranscription: { text: "What needs me?" } } });
    state.receive({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { data: "AAA", mimeType: "audio/pcm;rate=24000" } }],
        },
      },
    });
    expect(state.session.getSnapshot().messages.map(({ role, text }) => [role, text])).toEqual([
      ["user", "What needs me?"],
    ]);
    expect(state.audio).toEqual([]);
    state.receive({ serverContent: { turnComplete: true } });
    state.receive({ serverContent: { outputTranscription: { text: "Two threads." } } });
    state.receive({
      serverContent: {
        modelTurn: {
          parts: [{ inlineData: { data: "BBB", mimeType: "audio/pcm;rate=24000" } }],
        },
      },
    });
    expect(state.session.getSnapshot().messages.map(({ role, text }) => [role, text])).toEqual([
      ["user", "What needs me?"],
      ["voice", "Two threads."],
    ]);
    expect(state.audio).toEqual(["BBB"]);
    state.session.close();
  });

  it("records bounded tool progress and the created thread target without retaining tool results", async () => {
    const state = setup("fake-key", true, false, {
      threadId: "created",
      result: { privateOutput: "not a transcript" },
    });
    await state.session.open();
    const completed = new Promise<void>((resolve) => {
      const unsubscribe = state.session.subscribe(() => {
        if (state.session.getSnapshot().activity[0]?.status === "completed") {
          unsubscribe();
          resolve();
        }
      });
    });
    state.receive({
      toolCall: {
        functionCalls: [
          { id: "create", name: "create_thread", args: { environmentId: "env-a", title: "Build" } },
        ],
      },
    });
    expect(state.session.getSnapshot().activity[0]).toMatchObject({
      name: "create_thread",
      status: "running",
    });
    await completed;
    expect(state.session.getSnapshot().activity).toEqual([
      {
        id: "create",
        name: "create_thread",
        status: "completed",
        target: { environmentId: "env-a", threadId: "created" },
      },
    ]);
    state.session.close();
  });

  it("delivers bounded shell catch-up and live notifications without loading thread details", async () => {
    const state = setup();
    const thread = { ...v2ThreadShell, id: ThreadId.make("thread-a"), title: "Build" };
    const notices = Array.from({ length: 60 }, (_, index) => ({
      threadId: thread.id,
      notification: {
        id: TurnItemId.make(`shell-${index}`),
        message: `Needs input ${index}`,
        urgency: "when_idle" as const,
        occurredAt: "2026-11-01T00:00:00.000Z",
      },
    }));
    let snapshot: OrchestrationV2ShellSnapshot = mergeShellSnapshotProjects(null, {
      ...v2ShellSnapshot,
      threads: [thread],
      recentVoiceNotifications: notices,
    });
    expect(snapshot.recentVoiceNotifications).toHaveLength(50);
    state.feed.update(notificationsFromShell("env-a", snapshot));
    await state.session.open();
    state.receive({
      toolCall: { functionCalls: [{ id: "shell-monitor", name: "monitor_threads" }] },
    });
    expect(state.responses).toHaveLength(1);
    expect(state.responses[0]).toMatchObject({
      functionResponses: [
        {
          response: {
            notifications: expect.arrayContaining([
              expect.objectContaining({ message: "Needs input 59" }),
            ]),
          },
          willContinue: true,
        },
      ],
    });
    expect(state.seen.size).toBe(50);
    for (let index = 60; index < 115; index++) {
      snapshot = applyShellStreamEvent(snapshot, {
        kind: "voice.notification",
        sequence: index + 1,
        threadId: thread.id,
        notification: { ...notices[0]!.notification, id: TurnItemId.make(`shell-${index}`) },
      });
    }
    expect(snapshot.recentVoiceNotifications).toHaveLength(50);
    expect(snapshot.threads).toEqual([thread]);
    const hiddenThread = { ...snapshot, threads: [] };
    state.feed.update([
      ...notificationsFromShell("env-b", snapshot),
      ...notificationsFromShell("env-a", hiddenThread),
    ]);
    expect(state.responses).toHaveLength(1);
    state.feed.update(notificationsFromShell("env-a", snapshot));
    expect(state.responses).toHaveLength(2);
    expect(state.seen.size).toBe(100);
    state.session.close();
  });

  it("uses the current device model at each explicit connection", async () => {
    let model = "custom-live-model";
    const connectedModels: string[] = [];
    const state = setup();
    const session = createVoiceSession({
      key: { read: async () => "fake-key" },
      model: () => model,
      feed: state.feed,
      tools: { declarations: [], execute: async () => ({}) },
      connector: async (_key, _callbacks, _config, selectedModel) => {
        connectedModels.push(selectedModel);
        return {
          sendClientContent: () => {},
          sendToolResponse: () => {},
          sendRealtimeInput: () => {},
          close: () => {},
        };
      },
    });
    await session.open();
    session.disconnect();
    model = "next-live-model";
    await session.connect();
    expect(connectedModels).toEqual(["custom-live-model", "next-live-model"]);
    session.close();
  });
  it("opening never connects or acquires a microphone; no key disables text and voice", async () => {
    const { session, connections } = setup(null);
    await session.open();
    expect(connections()).toBe(0);
    expect(session.getSnapshot().status).toBe("disabled");
    await expect(session.sendText("hello")).rejects.toThrow("key");
    await expect(session.connect()).rejects.toThrow("key");
    expect(connections()).toBe(0);
  });

  it("does not reopen after closing while secure key access is pending", async () => {
    let release!: (key: string) => void;
    const key = new Promise<string>((resolve) => {
      release = resolve;
    });
    const state = setup();
    const session = createVoiceSession({
      key: { read: () => key },
      feed: state.feed,
      tools: { declarations: [], execute: async () => ({}) },
    });
    const opening = session.open();
    session.close();
    release("fake-key");
    await opening;
    expect(session.getSnapshot().open).toBe(false);
  });

  it("releases the audio owner when Gemini closes and requires an explicit reconnect", async () => {
    const state = setup();
    await state.session.open();
    await state.session.connect();
    state.remoteClose();
    expect(state.disconnected()).toBe(1);
    expect(state.session.getSnapshot().status).toBe("idle");
    expect(state.connections()).toBe(1);
  });

  it("closes a newly connected socket if its initial monitor request fails", async () => {
    const state = setup("fake-key", true, true);
    await state.session.open();
    expect(state.closed()).toBe(1);
    expect(state.disconnected()).toBe(1);
    expect(state.session.getSnapshot().status).toBe("error");
  });

  it("maps urgency and keeps generator responses chained; re-establishes a cancelled monitor", async () => {
    const state = setup();
    await state.session.open();
    await state.session.connect();
    state.receive({ toolCall: { functionCalls: [{ id: "monitor-1", name: "monitor_threads" }] } });
    for (const urgency of ["interrupt", "when_idle", "silent"] as const)
      state.feed.update([notice(urgency, urgency)]);
    expect(state.responses).toEqual(
      ["INTERRUPT", "WHEN_IDLE", "SILENT"].map((scheduling) => ({
        functionResponses: [
          {
            id: "monitor-1",
            name: "monitor_threads",
            response: { notifications: [expect.objectContaining({ message: "Needs input" })] },
            willContinue: true,
            scheduling,
          },
        ],
      })),
    );
    state.receive({ toolCallCancellation: { ids: ["monitor-1"] } });
    state.feed.update([notice("later")]);
    expect(state.responses).toHaveLength(3);
    state.receive({ toolCall: { functionCalls: [{ id: "monitor-2", name: "monitor_threads" }] } });
    expect(state.responses.at(-1)).toMatchObject({
      functionResponses: [{ id: "monitor-2", willContinue: true, scheduling: "WHEN_IDLE" }],
    });
    expect(state.content.length).toBeGreaterThan(1);
    expect(notificationScheduling("interrupt")).toBe("INTERRUPT");
  });

  it("only open clients with visibility forward, and summarizes unseen notifications once", async () => {
    const a = setup();
    const b = setup();
    const hidden = setup("fake-key", false);
    a.feed.update([notice("unseen-1"), notice("unseen-2")]);
    b.feed.update([notice("unseen-1")]);
    hidden.feed.update([notice("unseen-1")]);
    await a.session.open();
    await hidden.session.open();
    expect(a.connections()).toBe(1);
    expect(b.connections()).toBe(0);
    for (const state of [a, hidden])
      state.receive({ toolCall: { functionCalls: [{ id: "monitor", name: "monitor_threads" }] } });
    expect(a.responses).toHaveLength(1);
    expect(a.responses[0]).toMatchObject({
      functionResponses: [
        {
          response: { notifications: [notice("unseen-1"), notice("unseen-2")] },
          willContinue: true,
        },
      ],
    });
    expect(b.responses).toHaveLength(0);
    expect(hidden.responses).toHaveLength(0);
    a.session.disconnect();
    await a.session.connect();
    a.receive({ toolCall: { functionCalls: [{ id: "monitor-new", name: "monitor_threads" }] } });
    expect(a.responses).toHaveLength(1);
    expect(a.seen.size).toBe(2);
    a.session.close();
    a.feed.update([notice("closed")]);
    expect(a.responses).toHaveLength(1);
  });
});
