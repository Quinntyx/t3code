import { describe, expect, it, vi } from "vite-plus/test";
import {
  VoiceAudio,
  type VoicePlatform,
  type VoiceConnection,
  type VoiceHandlers,
} from "./VoiceAudio";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function setup() {
  const track = {
    stop: vi.fn(),
    addEventListener: vi.fn((_type: string, _listener: () => void) => {}),
    removeEventListener: vi.fn(),
  };
  const stream = { getTracks: () => [track] } as unknown as MediaStream;
  const sources: Array<{
    start: ReturnType<typeof vi.fn>;
    stop: ReturnType<typeof vi.fn>;
    disconnect: ReturnType<typeof vi.fn>;
    onended: (() => void) | null;
    buffer: unknown;
    connect: ReturnType<typeof vi.fn>;
  }> = [];
  const context = {
    state: "running",
    currentTime: 1,
    destination: {},
    resume: vi.fn(() => Promise.resolve()),
    close: vi.fn(() => Promise.resolve()),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    createBuffer: vi.fn((_channels: number, size: number) => ({
      copyToChannel: vi.fn(),
      length: size,
    })),
    createBufferSource: vi.fn(() => {
      const source = {
        start: vi.fn(),
        stop: vi.fn(),
        disconnect: vi.fn(),
        onended: null as (() => void) | null,
        buffer: null,
        connect: vi.fn(),
      };
      sources.push(source);
      return source;
    }),
  };
  let input!: (bytes: Uint8Array) => Promise<boolean>;
  let handlers!: VoiceHandlers;
  const capture = { stop: vi.fn() };
  const connection: VoiceConnection = {
    offer: vi.fn(async () => true),
    control: vi.fn(async () => true),
    dispose: vi.fn(async () => {}),
  };
  const meters = Array.from({ length: 2 }, () => ({
    node: { connect: vi.fn(), disconnect: vi.fn() } as unknown as AudioNode,
    read: vi.fn(() => ({ energy: 0.5, bands: [0.2, 0.3, 0.4, 0.2, 0.1], bins: [0.3], flux: 0.1 })),
    dispose: vi.fn(),
  }));
  const platform: VoicePlatform = {
    createMeter: vi.fn().mockReturnValueOnce(meters[0]).mockReturnValue(meters[1]),
    check: vi.fn(),
    createContext: () => context as unknown as AudioContext,
    getUserMedia: vi.fn(async () => stream),
    createCapture: vi.fn(async (_context, _stream, onInput) => {
      input = onInput;
      return capture;
    }),
  };
  const attach = vi.fn(async (next: VoiceHandlers) => {
    handlers = next;
    return connection;
  });
  const owner = new VoiceAudio(platform);
  return {
    owner,
    meters,
    platform,
    context,
    sources,
    stream,
    track,
    capture,
    connection,
    attach,
    input: () => input,
    handlers: () => handlers,
  };
}

describe("project voice audio owner with controlled WebAudio/device boundary", () => {
  it("meters real input and playback, settles on silence and releases both analysers", async () => {
    const f = setup();
    expect(f.owner.snapshot().flowing).toBe(false);
    await f.owner.connect(f.attach);
    f.handlers().event({ type: "control", state: "listening" });
    const speech = new Uint8Array(new Int16Array(320).fill(8192).buffer);
    await f.input()(speech);
    expect(f.owner.snapshot().flowing).toBe(true);
    expect(f.owner.getSpectrum().energy).toBe(0.5);
    await f.input()(new Uint8Array(640));
    expect(f.owner.snapshot().flowing).toBe(false);
    f.handlers().audio(speech, 0);
    expect(f.owner.snapshot().flowing).toBe(true);
    expect(f.sources[0]!.connect).toHaveBeenCalledWith(f.meters[1]!.node);
    f.sources[0]!.onended!();
    expect(f.owner.snapshot().flowing).toBe(false);
    await f.input()(speech);
    await f.owner.mute();
    expect(f.owner.snapshot().flowing).toBe(false);
    await f.owner.disconnect();
    expect(f.meters.every((meter) => meter.dispose.mock.calls.length === 1)).toBe(true);
    expect(f.owner.getSpectrum().energy).toBe(0);
  });

  it("reports actual speech and returns to listening at a canonical turn end", async () => {
    const f = setup();
    await f.owner.connect(f.attach);
    f.handlers().event({ type: "control", state: "listening" });
    f.handlers().audio(new Uint8Array(480), 0);
    expect(f.owner.snapshot().phase).toBe("speaking");
    f.handlers().event({ type: "turn-end" });
    f.sources[0]!.onended!();
    expect(f.owner.snapshot().phase).toBe("listening");
    await f.owner.disconnect();
  });

  it("ignores a failed control from an obsolete attachment after explicit reconnect", async () => {
    const f = setup();
    const control = deferred<boolean>();
    await f.owner.connect(f.attach);
    vi.mocked(f.connection.control).mockImplementationOnce(() => control.promise);
    const interrupting = f.owner.interrupt();
    await f.owner.disconnect();
    await f.owner.connect(f.attach);
    f.handlers().event({ type: "control", state: "listening" });
    control.reject(new Error("old attachment ended"));
    await interrupting;
    expect(f.owner.snapshot().phase).toBe("listening");
    expect(f.connection.dispose).toHaveBeenCalledOnce();
    await f.owner.disconnect();
  });

  it("keeps capture alive while an interruption control is awaiting acknowledgement", async () => {
    const f = setup();
    await f.owner.connect(f.attach);
    const acknowledged = deferred<boolean>();
    vi.mocked(f.connection.control).mockImplementationOnce(() => acknowledged.promise);
    vi.mocked(f.connection.offer).mockResolvedValue(false);
    const interrupting = f.owner.interrupt();
    const accepted = await f.input()(new Uint8Array(640));
    acknowledged.resolve(true);
    await interrupting;
    expect(accepted).toBe(true);
    expect(f.connection.offer).not.toHaveBeenCalled();
    expect(f.track.stop).not.toHaveBeenCalled();
    await f.owner.disconnect();
  });

  it("acknowledges resumed capture while the server has not yet unmuted input", async () => {
    const f = setup();
    await f.owner.connect(f.attach);
    await f.owner.mute();
    const requested = deferred<void>();
    const acknowledged = deferred<boolean>();
    vi.mocked(f.connection.control).mockImplementationOnce(() => {
      requested.resolve();
      return acknowledged.promise;
    });
    const resuming = f.owner.resume();
    await requested.promise;
    const accepted = await f.input()(new Uint8Array(640));
    acknowledged.resolve(true);
    await resuming;
    expect(accepted).toBe(true);
    expect(f.connection.offer).not.toHaveBeenCalled();
    expect(f.owner.snapshot().phase).toBe("listening");
    await f.owner.disconnect();
  });

  it("queues a reply that Gemini streams faster than it plays", async () => {
    const f = setup();
    await f.owner.connect(f.attach);
    // Ten seconds of 24 kHz speech arriving at once, as Live sends a whole reply.
    for (let chunk = 0; chunk < 25; chunk++) f.handlers().audio(new Uint8Array(19_200), 0);
    expect(f.owner.snapshot().error).toBeNull();
    expect(f.sources).toHaveLength(25);
    expect(f.sources.at(-1)!.start.mock.calls[0]![0]).toBeCloseTo(1 + 9.6);
    await f.owner.disconnect();
  });

  it("ignores already-dispatched playback callbacks after a reconnect", async () => {
    const f = setup();
    await f.owner.connect(f.attach);
    f.handlers().audio(new Uint8Array(480), 0);
    const ended = f.sources[0]!.onended!;
    await f.owner.disconnect();
    await f.owner.connect(f.attach);
    expect(f.owner.snapshot().phase).toBe("connecting");
    ended();
    expect(f.owner.snapshot().phase).toBe("connecting");
    await f.owner.disconnect();
  });

  it("retains failed disposal of a late attachment for the same close retry", async () => {
    const f = setup();
    const attached = deferred<VoiceConnection>();
    const reached = deferred<void>();
    const connecting = f.owner.connect(() => {
      reached.resolve();
      return attached.promise;
    });
    await reached.promise;
    vi.mocked(f.connection.dispose).mockRejectedValueOnce(new Error("late dispose failed"));
    const closing = f.owner.disconnect();
    attached.resolve(f.connection);
    await expect(closing).rejects.toThrow("late dispose failed");
    await connecting;
    expect(f.owner.snapshot()).toMatchObject({ phase: "error", cleanupRequired: true });
    await f.owner.disconnect();
    expect(f.connection.dispose).toHaveBeenCalledTimes(2);
  });

  it("releases capture on input backpressure and on permission or device loss", async () => {
    const f = setup();
    await f.owner.connect(f.attach);
    vi.mocked(f.connection.offer).mockResolvedValueOnce(false);
    const failed = deferred<void>();
    f.owner.subscribe(() => {
      if (f.owner.snapshot().phase === "error") failed.resolve();
    });
    expect(await f.input()(new Uint8Array(640))).toBe(false);
    await failed.promise;
    expect(f.capture.stop).toHaveBeenCalledOnce();
    expect(f.owner.snapshot().error).toContain("bounded queue");
    await f.owner.connect(f.attach);
    const ended = f.track.addEventListener.mock.calls.at(-1)!;
    (ended[1] as () => void)();
    await f.owner.disconnect();
    expect(f.track.stop).toHaveBeenCalledTimes(2);
  });
  it("keeps capture active during playback, flushes epochs immediately, and distinguishes mute/interrupt/disconnect", async () => {
    const f = setup();
    await f.owner.connect(f.attach);
    f.handlers().event({ type: "control", state: "listening" });
    expect(f.owner.snapshot().phase).toBe("listening");
    await f.input()(new Uint8Array(640));
    f.handlers().audio(new Uint8Array(480), 0);
    expect(f.sources).toHaveLength(1);
    expect(f.track.stop).not.toHaveBeenCalled();
    await f.owner.interrupt();
    expect(f.sources[0]!.stop).toHaveBeenCalledOnce();
    expect(f.connection.control).toHaveBeenCalledWith("interrupt-response");
    f.handlers().audio(new Uint8Array(480), 0);
    expect(f.sources).toHaveLength(1);
    await f.owner.mute();
    expect(f.capture.stop).toHaveBeenCalledOnce();
    expect(f.track.stop).toHaveBeenCalledOnce();
    f.handlers().audio(new Uint8Array(480), 1);
    expect(f.sources).toHaveLength(2);
    await f.owner.resume();
    expect(f.platform.getUserMedia).toHaveBeenCalledTimes(2);
    await f.owner.disconnect();
    expect(f.context.close).toHaveBeenCalledOnce();
    expect(f.connection.dispose).toHaveBeenCalledOnce();
    expect(f.owner.snapshot().phase).toBe("disconnected");
  });

  it("stops late permission and capture results after close without resurrecting an attachment", async () => {
    const f = setup();
    const media = deferred<MediaStream>();
    f.platform.getUserMedia = () => media.promise;
    const connecting = f.owner.connect(f.attach);
    await f.owner.disconnect();
    media.resolve(f.stream);
    await connecting;
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.owner.snapshot().phase).toBe("disconnected");
  });

  it("disposes an attachment that completes after a disconnect", async () => {
    const f = setup();
    const attached = deferred<VoiceConnection>();
    const reached = deferred<void>();
    const connecting = f.owner.connect(() => {
      reached.resolve();
      return attached.promise;
    });
    await reached.promise;
    const closing = f.owner.disconnect();
    attached.resolve(f.connection);
    await Promise.all([connecting, closing]);
    expect(f.connection.dispose).toHaveBeenCalledOnce();
    expect(f.track.stop).toHaveBeenCalledOnce();
  });

  it("cleans failed autoplay/capture and reports insecure origin before prompting", async () => {
    const insecure = setup();
    insecure.platform.check = () => {
      throw new Error("A secure context is required.");
    };
    await insecure.owner.connect(insecure.attach);
    expect(insecure.platform.getUserMedia).not.toHaveBeenCalled();
    expect(insecure.owner.snapshot().error).toContain("secure context");
    const f = setup();
    f.context.resume.mockRejectedValueOnce(new Error("Autoplay blocked"));
    await f.owner.connect(f.attach);
    expect(f.track.stop).toHaveBeenCalledOnce();
    expect(f.context.close).toHaveBeenCalledOnce();
    expect(f.attach).not.toHaveBeenCalled();
    expect(f.owner.snapshot().error).toContain("Autoplay");
  });

  it("bounds scheduled playback and input failure closes resources; old callbacks cannot play", async () => {
    const f = setup();
    await f.owner.connect(f.attach);
    const old = f.handlers();
    const minute = new Uint8Array(24_000 * 2 * 60);
    old.audio(minute, 0);
    old.audio(minute, 0);
    const stopped = deferred<void>();
    f.owner.subscribe(() => {
      if (f.owner.snapshot().phase === "error") stopped.resolve();
    });
    old.audio(minute, 0);
    await stopped.promise;
    await f.owner.disconnect();
    expect(f.sources.length).toBeLessThanOrEqual(2);
    old.audio(new Uint8Array(480), 0);
    expect(f.sources.length).toBeLessThanOrEqual(2);
    expect(f.sources.every((source) => source.stop.mock.calls.length === 1)).toBe(true);
  });

  it("releases autoplay failure without waiting for a still-pending permission prompt", async () => {
    const f = setup();
    const media = deferred<MediaStream>();
    const closed = deferred<void>();
    f.platform.getUserMedia = () => media.promise;
    f.context.resume.mockRejectedValueOnce(new Error("Autoplay blocked"));
    f.context.close.mockImplementation(async () => {
      closed.resolve();
    });
    const starting = f.owner.connect(f.attach);
    await closed.promise;
    media.resolve(f.stream);
    await starting;
    expect(f.track.stop).toHaveBeenCalledOnce();
  });

  it("cannot request a second microphone while an obsolete external prompt is pending", async () => {
    const f = setup();
    const media = deferred<MediaStream>();
    const closed = deferred<void>();
    const request = vi.fn(() => media.promise);
    f.platform.getUserMedia = request;
    f.context.resume.mockRejectedValueOnce(new Error("Autoplay blocked"));
    f.context.close.mockImplementation(async () => {
      closed.resolve();
    });
    const starting = f.owner.connect(f.attach);
    await closed.promise;
    await starting;
    const reconnecting = f.owner.connect(f.attach);
    const requests = request.mock.calls.length;
    media.resolve(f.stream);
    await Promise.all([reconnecting, media.promise]);
    expect(requests).toBe(1);
    expect(f.track.stop).toHaveBeenCalledOnce();
  });

  it("retains failed context disposal for an honest close retry", async () => {
    const f = setup();
    await f.owner.connect(f.attach);
    f.context.close.mockRejectedValueOnce(new Error("close failed"));
    await expect(f.owner.disconnect()).rejects.toThrow("close failed");
    expect(f.owner.snapshot()).toMatchObject({ phase: "error", cleanupRequired: true });
    await f.owner.disconnect();
    expect(f.context.close).toHaveBeenCalledTimes(2);
  });
});
