import { expect, it, vi } from "vite-plus/test";
import type {
  VoiceAudioConnection,
  VoiceAudioHandlers,
} from "@t3tools/client-runtime/voice/client";
import {
  acquireAudioSession,
  activateAudioSession,
  releaseAudioSession,
} from "../../lib/audioSession";
import {
  NativeVoiceAudio,
  type NativeVoiceDevice,
  type NativeVoiceEvent,
} from "./NativeVoiceAudio";

vi.mock("expo-audio", () => ({
  AudioModule: {},
  setAudioModeAsync: async () => {},
  setIsAudioActiveAsync: async () => {},
}));

function setup(now = () => 0) {
  let listener: (event: NativeVoiceEvent) => Promise<void> = async () => {};
  const device: NativeVoiceDevice = {
    available: true,
    requestPermission: vi.fn(async () => true),
    subscribe: (next) => {
      listener = next;
      return () => {
        listener = async () => {};
      };
    },
    start: vi.fn(async (_id: number) => {}),
    stop: vi.fn((_id: number) => {}),
    mute: vi.fn((_id: number, _muted: boolean) => {}),
    flush: vi.fn((_id: number, _epoch: number) => {}),
    play: vi.fn((_id: number, _bytes: Uint8Array, _epoch: number) => {}),
    acknowledge: vi.fn((_id: number) => {}),
  };
  const connection: VoiceAudioConnection = {
    offer: vi.fn(async () => true),
    control: vi.fn(async () => true),
    dispose: vi.fn(async () => {}),
  };
  let handlers!: VoiceAudioHandlers;
  const attach = vi.fn(async (next: VoiceAudioHandlers) => {
    handlers = next;
    next.epoch(2);
    return connection;
  });
  const owner = new NativeVoiceAudio(device, now);
  const emit = (event: Omit<NativeVoiceEvent, "id">) =>
    listener({ id: owner.snapshot().id, ...event });
  return {
    owner,
    device,
    connection,
    attach,
    emit,
    handlers: () => handlers,
    listener: () => listener,
  };
}

it("never starts native capture when permission is denied or the binary has no module", async () => {
  const s = setup();
  vi.mocked(s.device.requestPermission).mockResolvedValue(false);
  await s.owner.connect(s.attach);
  expect(s.device.start).not.toHaveBeenCalled();
  expect(s.attach).not.toHaveBeenCalled();
  expect(s.owner.snapshot().error).toContain("permission");
  const unavailable = new NativeVoiceAudio({ ...s.device, available: false });
  await unavailable.connect(s.attach);
  expect(s.device.requestPermission).toHaveBeenCalledOnce();
});

it("cleans failed native start and failed attachment without cancelling any worker", async () => {
  const s = setup();
  vi.mocked(s.device.start).mockRejectedValueOnce(new Error("native start failed"));
  await s.owner.connect(s.attach);
  expect(s.device.stop).toHaveBeenCalledOnce();
  expect(s.owner.snapshot().phase).toBe("error");
  s.attach.mockRejectedValueOnce(new Error("lease denied"));
  await s.owner.connect(s.attach);
  expect(s.device.stop).toHaveBeenCalledTimes(2);
  expect(s.owner.snapshot().error).toContain("lease denied");
});

it.each(["route-change", "interruption", "background", "error"] as const)(
  "disconnects on %s and never auto-reconnects",
  async (type) => {
    const s = setup();
    await s.owner.connect(s.attach);
    await s.emit({ type });
    await s.owner.disconnect();
    expect(s.device.stop).toHaveBeenCalledOnce();
    expect(s.connection.dispose).toHaveBeenCalledOnce();
    expect(s.attach).toHaveBeenCalledOnce();
    expect(s.device.start).toHaveBeenCalledOnce();
  },
);

it("keeps output live while muted, flushes epochs immediately, and closes only local media", async () => {
  const s = setup();
  await s.owner.connect(s.attach);
  await s.owner.mute();
  const bytes = new Uint8Array(640);
  s.handlers().audio(bytes, 2);
  expect(s.device.play).toHaveBeenCalledWith(s.owner.snapshot().id, bytes, 2);
  await s.emit({ type: "pcm", bytes });
  expect(s.connection.offer).not.toHaveBeenCalled();
  await s.owner.resume();
  await s.emit({ type: "pcm", bytes });
  expect(s.connection.offer).toHaveBeenCalledOnce();
  const control = Promise.withResolvers<boolean>();
  vi.mocked(s.connection.control).mockReturnValueOnce(control.promise);
  const interrupting = s.owner.interrupt();
  expect(s.device.flush).toHaveBeenLastCalledWith(s.owner.snapshot().id, 3);
  s.handlers().audio(bytes, 2);
  expect(s.device.play).toHaveBeenCalledOnce();
  await s.emit({ type: "pcm", bytes });
  control.resolve(true);
  await interrupting;
  expect(s.connection.offer).toHaveBeenCalledOnce();
  await s.owner.disconnect();
  expect(s.connection.control).toHaveBeenCalledWith("mute");
  expect(s.connection.control).toHaveBeenCalledWith("resume");
  expect(s.connection.control).toHaveBeenCalledWith("interrupt-response");
  expect(s.connection.dispose).toHaveBeenCalledOnce();
});

it("rejects stale native callbacks and releases a late attachment after closing", async () => {
  const s = setup();
  const attached = Promise.withResolvers<VoiceAudioConnection>();
  const entered = Promise.withResolvers<void>();
  const connecting = s.owner.connect(async () => {
    entered.resolve();
    return attached.promise;
  });
  await entered.promise;
  const closing = s.owner.disconnect();
  attached.resolve(s.connection);
  await Promise.all([connecting, closing]);
  expect(s.connection.dispose).toHaveBeenCalledOnce();
  expect(s.owner.snapshot().phase).toBe("disconnected");
  await s.owner.connect(s.attach);
  await s.emit({ type: "pcm", bytes: new Uint8Array(32002) });
  await s.owner.disconnect();
  expect(s.connection.offer).not.toHaveBeenCalled();
});

it("cancels duplex for dictation and prevents video/playback from stealing the duplex session", async () => {
  const s = setup();
  await s.owner.connect(s.attach);
  const playback = acquireAudioSession("playback");
  expect(await activateAudioSession(playback, true)).toBe(false);
  await releaseAudioSession(playback);
  const dictation = acquireAudioSession("recording");
  expect(await activateAudioSession(dictation)).toBe(true);
  await s.owner.disconnect();
  expect(s.device.stop).toHaveBeenCalledOnce();
  expect(s.connection.dispose).toHaveBeenCalledOnce();
  await releaseAudioSession(dictation);
  const cancelled = vi.fn();
  const recording = acquireAudioSession("recording", cancelled);
  await s.owner.connect(s.attach);
  expect(cancelled).not.toHaveBeenCalled();
  expect(s.owner.snapshot().error).toContain("Dictation is using");
  expect(s.device.start).toHaveBeenCalledOnce();
  await releaseAudioSession(recording);
  await s.owner.disconnect();
});

it("keeps cleanup retryable and never overlaps a pending microphone permission request", async () => {
  const s = setup();
  const permission = Promise.withResolvers<boolean>();
  vi.mocked(s.device.requestPermission).mockReturnValueOnce(permission.promise);
  const connecting = s.owner.connect(s.attach);
  await s.owner.disconnect();
  await s.owner.connect(s.attach);
  expect(s.device.requestPermission).toHaveBeenCalledOnce();
  permission.resolve(true);
  await connecting;
  expect(s.device.start).not.toHaveBeenCalled();
  await s.owner.connect(s.attach);
  vi.mocked(s.connection.dispose).mockRejectedValueOnce(new Error("detach failed"));
  await expect(s.owner.disconnect()).rejects.toThrow("detach failed");
  expect(s.owner.snapshot().cleanupRequired).toBe(true);
  await s.owner.disconnect();
  expect(s.owner.snapshot().cleanupRequired).toBe(false);
});

it("disposes an attachment even if it closes synchronously during initialization", async () => {
  const s = setup();
  await s.owner.connect(async (handlers) => {
    handlers.closed();
    return s.connection;
  });
  expect(s.connection.dispose).toHaveBeenCalledOnce();
  expect(s.device.stop).toHaveBeenCalledOnce();
  await s.owner.disconnect();
});

it("waits for a late native start to stop before dictation can activate", async () => {
  const s = setup();
  const entered = Promise.withResolvers<void>();
  const started = Promise.withResolvers<void>();
  vi.mocked(s.device.start).mockImplementationOnce(async () => {
    entered.resolve();
    await started.promise;
  });
  const connecting = s.owner.connect(s.attach);
  await entered.promise;
  const dictation = acquireAudioSession("recording");
  const activating = activateAudioSession(dictation);
  expect(s.device.stop).not.toHaveBeenCalled();
  started.resolve();
  await connecting;
  expect(await activating).toBe(true);
  expect(s.device.stop).toHaveBeenCalledOnce();
  expect(s.attach).not.toHaveBeenCalled();
  await releaseAudioSession(dictation);
});

it("keeps native stop retryable and ignores callbacks from a closed generation", async () => {
  const s = setup();
  await s.owner.connect(s.attach);
  const oldId = s.owner.snapshot().id;
  const stale = s.listener();
  vi.mocked(s.device.stop).mockImplementationOnce(() => {
    throw new Error("native stop failed");
  });
  await expect(s.owner.disconnect()).rejects.toThrow("native stop failed");
  expect(s.owner.snapshot().cleanupRequired).toBe(true);
  await s.owner.disconnect();
  await s.owner.connect(s.attach);
  await stale({ id: oldId, type: "pcm", bytes: new Uint8Array(640) });
  await stale({ id: oldId, type: "route-change" });
  expect(s.connection.offer).not.toHaveBeenCalled();
  expect(s.owner.snapshot().phase).toBe("listening");
  await s.owner.disconnect();
});

it("splits a long reply for the native speaker and glows while it should be playing", async () => {
  let now = 0;
  const s = setup(() => now);
  await s.owner.connect(s.attach);
  const loud = new Uint8Array(new Int16Array(24_000).fill(8192).buffer);
  s.handlers().audio(loud, 2);
  expect(vi.mocked(s.device.play).mock.calls.map(([, bytes]) => bytes.length)).toEqual([
    32_000, 16_000,
  ]);
  expect(s.owner.snapshot().phase).toBe("speaking");
  expect(s.owner.level()).toBeGreaterThan(0.5);
  now = 1_001;
  expect(s.owner.level()).toBe(0);
  await s.owner.interrupt();
  expect(s.owner.snapshot().phase).toBe("listening");
  await s.owner.disconnect();
});
