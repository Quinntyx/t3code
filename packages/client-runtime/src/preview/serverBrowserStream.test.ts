import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { encodePreviewStreamAudioFrame } from "@t3tools/contracts";

import {
  createPreviewAudioPlayer,
  createPreviewStreamClient,
  type PreviewStreamControl,
} from "./serverBrowserStream.ts";

class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static current: FakeSocket;
  readyState = 1;
  binaryType = "";
  readonly sent: string[] = [];
  readonly url: string;
  constructor(url: string) {
    super();
    this.url = url;
    FakeSocket.current = this;
  }
  send(value: string) {
    this.sent.push(value);
  }
  close() {
    this.readyState = 3;
  }
  message(data: unknown) {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  control(value: PreviewStreamControl) {
    this.message(JSON.stringify({ type: "control", ...value }));
  }
}

const target = {
  access: {
    httpBase: "http://preview.test/api/preview-stream",
    wsBase: "ws://preview.test/api/preview-stream",
    query: {},
    credentials: true,
  },
  threadId: "thread",
  tabId: "tab",
  maxWidth: 800,
  maxHeight: 600,
};

describe("preview stream control", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());
  const connect = () => {
    const onFrame = vi.fn();
    const onControl = vi.fn();
    const client = createPreviewStreamClient(target, {
      onFrame,
      onControl,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    return { client, socket: FakeSocket.current, onFrame, onControl };
  };
  const agent: PreviewStreamControl = {
    canOperate: true,
    controller: "agent",
    generation: 1,
    dialog: null,
  };

  it("does not grant control from malformed dialog metadata", () => {
    const { client, socket, onControl } = connect();
    socket.message(
      JSON.stringify({
        type: "control",
        ...agent,
        controller: "you",
        dialog: { type: "prompt", message: 42, defaultValue: "" },
      }),
    );
    expect(onControl).not.toHaveBeenCalled();
    expect(client.send({ type: "reload" })).toBe(false);
    client.stop();
  });

  it("keeps read-only frames flowing while refusing takeover and every mutation", () => {
    const { client, socket, onFrame } = connect();
    socket.control({ ...agent, canOperate: false });
    const frame = new ArrayBuffer(3);
    socket.message(frame);
    expect(onFrame).toHaveBeenCalledWith(frame);
    expect(client.send({ type: "takeControl" })).toBe(false);
    expect(client.send({ type: "resize", width: 390, height: 844 })).toBe(false);
    expect(client.send({ type: "reload" })).toBe(false);
    expect(socket.sent).toEqual(['{"type":"ack"}']);
    client.stop();
  });

  it("revokes input immediately on release and exposes pending dialog state", () => {
    const { client, socket, onControl } = connect();
    const owned = {
      ...agent,
      controller: "you" as const,
      dialog: { type: "prompt", message: "Name?", defaultValue: "initial" },
    };
    socket.control(owned);
    expect(onControl).toHaveBeenLastCalledWith(owned);
    expect(client.send({ type: "dialog", accept: true, promptText: "answer" })).toBe(true);
    expect(client.send({ type: "releaseControl" })).toBe(true);
    socket.control({ ...agent, generation: 2 });
    expect(client.send({ type: "text", text: "late input" })).toBe(false);
    expect(client.send({ type: "dialog", accept: false })).toBe(false);
    client.stop();
  });

  it("withdraws an offered file picker when the stream drops or stops", () => {
    const onFileChooser = vi.fn();
    const events = {
      onFrame: vi.fn(),
      onFileChooser,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    };
    const client = createPreviewStreamClient(target, events);
    const socket = FakeSocket.current;
    socket.dispatchEvent(new Event("open"));
    socket.message(JSON.stringify({ type: "fileChooser", id: "c1", multiple: false, accept: "" }));
    socket.dispatchEvent(Object.assign(new Event("close"), { code: 1012 }));
    expect(onFileChooser).toHaveBeenLastCalledWith(null);
    client.stop();

    const restarted = createPreviewStreamClient(target, events);
    FakeSocket.current.message(
      JSON.stringify({ type: "fileChooser", id: "c2", multiple: false, accept: "" }),
    );
    restarted.stop();
    expect(onFileChooser).toHaveBeenLastCalledWith(null);
  });
});

describe("preview stream audio", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  const connect = () => {
    const onFrame = vi.fn();
    const onAudio = vi.fn();
    createPreviewStreamClient(target, {
      onFrame,
      onAudio,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    return { socket: FakeSocket.current, onFrame, onAudio };
  };

  it("routes a tagged audio message to its own callback and video stays a frame", () => {
    const { socket, onFrame, onAudio } = connect();
    const audio = encodePreviewStreamAudioFrame({
      generation: 0,
      sequence: 3,
      timestampMicros: 60_000,
      data: new Uint8Array([0x4f, 0x70]),
    });
    const video = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
    socket.message(audio.buffer.slice(audio.byteOffset, audio.byteOffset + audio.byteLength));
    socket.message(video);
    expect(onAudio).toHaveBeenCalledExactlyOnceWith({
      type: "audio",
      generation: 0,
      sequence: 3,
      timestampMicros: 60_000,
      data: new Uint8Array([0x4f, 0x70]),
    });
    expect(onFrame).toHaveBeenCalledExactlyOnceWith(video);
    // Only frames are acked; the server matches acks against its queued frames.
    expect(socket.sent).toEqual(['{"type":"ack"}']);
  });

  // This runtime has no WebCodecs, like an insecure context or an older WebView.
  it.each([
    ["a viewer that would play it", true, true, [false]],
    ["a viewer that opted out", false, true, []],
    ["a viewer with no audio consumer", true, false, []],
  ])("reports undecodable audio as unavailable only to %s", (_, audio, consumer, reported) => {
    const onAudioAvailable = vi.fn();
    createPreviewStreamClient(
      { ...target, audio },
      {
        onFrame: vi.fn(),
        ...(consumer ? { onAudio: vi.fn() } : {}),
        onAudioAvailable,
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    expect(onAudioAvailable.mock.calls.map(([available]) => available)).toEqual(reported);
    expect(FakeSocket.current.url).not.toContain("audio=");
  });
});

describe("preview audio player", () => {
  const frames: Array<{ readonly at: number; readonly duration: number; stopped: boolean }> = [];
  let state: AudioContextState = "running";
  let currentTime = 0;
  let closed = 0;
  let decodes = 0;
  let configures = 0;
  let outputs: Array<(frame: AudioData) => void> = [];

  class FakeAudioContext {
    static readonly instances: FakeAudioContext[] = [];
    readonly destination = {};
    readonly gains: Array<{ value: number; connections: number }> = [];
    private lifecycle: AudioContextState = state;
    get state() {
      return this.lifecycle;
    }
    set state(next: AudioContextState) {
      this.lifecycle = next;
    }
    get currentTime() {
      return currentTime;
    }
    onstatechange: (() => void) | null = null;
    constructor() {
      FakeAudioContext.instances.push(this);
    }
    resume() {
      this.state = "running";
      this.onstatechange?.();
      return Promise.resolve();
    }
    close() {
      closed += 1;
      this.state = "closed";
      return Promise.resolve();
    }
    createGain() {
      const gain = { value: 1, connections: 0 };
      this.gains.push(gain);
      return {
        gain,
        connect: () => {
          gain.connections += 1;
        },
      };
    }
    createBuffer(channels: number, length: number, rate: number) {
      return {
        duration: length / rate,
        numberOfChannels: channels,
        copyToChannel: () => undefined,
      };
    }
    createBufferSource() {
      const entry = { at: 0, duration: 0, stopped: false };
      const source = {
        buffer: null as { duration: number } | null,
        connect: () => undefined,
        onended: null as (() => void) | null,
        stop: () => {
          entry.stopped = true;
          source.onended?.();
        },
        start: (at: number) => {
          entry.at = at;
          entry.duration = source.buffer?.duration ?? 0;
          frames.push(entry);
        },
      };
      return source;
    }
  }

  class FakeAudioDecoder {
    state = "unconfigured";
    readonly init: { output: (frame: AudioData) => void };
    constructor(init: { output: (frame: AudioData) => void }) {
      this.init = init;
      outputs.push(init.output);
    }
    configure() {
      configures += 1;
      this.state = "configured";
    }
    decode() {
      decodes += 1;
    }
    close() {
      this.state = "closed";
    }
  }

  const audioData = (frames: number, timestamp: number, rate = 48000) => ({
    numberOfChannels: 1,
    numberOfFrames: frames,
    sampleRate: rate,
    timestamp,
    copyTo: () => undefined,
    close: () => undefined,
  });

  const packet = (sequence: number, timestampMicros: number, generation = 1) => ({
    generation,
    sequence,
    timestampMicros,
    data: new Uint8Array([1, 2]),
  });

  beforeEach(() => {
    frames.length = 0;
    outputs = [];
    FakeAudioContext.instances.length = 0;
    state = "running";
    currentTime = 0;
    closed = 0;
    decodes = 0;
    configures = 0;
    vi.stubGlobal("AudioContext", FakeAudioContext);
    vi.stubGlobal("AudioDecoder", FakeAudioDecoder);
    vi.stubGlobal("EncodedAudioChunk", function EncodedAudioChunk() {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it("configures the decoder once and keeps its state across packets", () => {
    const player = createPreviewAudioPlayer();
    player.push(packet(0, 0));
    player.push(packet(1, 20_000));
    player.push(packet(2, 40_000));
    // Reconfiguring per packet resets Opus and attenuates everything played after it.
    expect(configures).toBe(1);
    expect(decodes).toBe(3);
    player.stop();
  });

  it("schedules each packet from its source clock, leaving a pause a pause", () => {
    const player = createPreviewAudioPlayer();
    player.push(packet(0, 0));
    outputs.at(-1)!(audioData(960, 0) as unknown as AudioData);
    expect(frames.map(({ at, duration }) => ({ at, duration }))).toEqual([
      { at: 0.06, duration: 0.02 },
    ]);

    // A second of page silence arrives as a later timestamp. It is beyond the lead a packet
    // may be scheduled by, so the run starts fresh just ahead of the clock rather than a
    // second into the future.
    player.push(packet(2, 1_020_000));
    outputs.at(-1)!(audioData(960, 1_020_000) as unknown as AudioData);
    // Fresh run from now, behind the audio the first packet already queued.
    expect(frames).toHaveLength(2);
    expect(frames[1]!.at).toBeCloseTo(0.08, 5);
    player.stop();
  });

  it("drops a stale burst down to live instead of re-anchoring to its start", () => {
    const player = createPreviewAudioPlayer();
    player.push(packet(0, 0));
    outputs.at(-1)!(audioData(960, 0) as unknown as AudioData);

    // Fifty packets the page played while the link stalled, decoded in order after the stall.
    currentTime = 5;
    for (let index = 1; index <= 50; index += 1) {
      const timestamp = index * 20_000;
      player.push(packet(index, timestamp));
      outputs.at(-1)!(audioData(960, timestamp) as unknown as AudioData);
    }
    // Everything before the clock is dropped, so nothing is scheduled behind it or far ahead.
    expect(frames).toHaveLength(1);

    // The next live packet plays where it should, not dragged behind the backlog.
    player.push(packet(51, 5_000_000));
    outputs.at(-1)!(audioData(960, 5_000_000) as unknown as AudioData);
    expect(frames).toHaveLength(2);
    expect(frames[1]!.at).toBeCloseTo(5.06, 5);
    player.stop();
  });

  it("never overlaps two packets decoded out of order", () => {
    const player = createPreviewAudioPlayer();
    player.push(packet(0, 0));
    player.push(packet(1, 20_000));
    // The decoder answers out of order. Non-overlap is enforced when a packet is scheduled, so
    // the first answer takes the earliest free slot and the later one follows it.
    outputs.at(-1)!(audioData(960, 20_000) as unknown as AudioData);
    outputs.at(-1)!(audioData(960, 0) as unknown as AudioData);
    const [first, second] = frames;
    expect(first!.at).toBeCloseTo(0.08, 5);
    expect(second!.at).toBeGreaterThanOrEqual(first!.at + first!.duration);
    player.stop();
  });

  it("resets decoder, sequence, clock and scheduled audio together on a new generation", () => {
    const player = createPreviewAudioPlayer();
    player.push(packet(40, 800_000));
    outputs.at(-1)!(audioData(960, 800_000) as unknown as AudioData);
    expect(frames).toHaveLength(1);

    // A replacement capture starts its own clock and sequence; none of the old run applies.
    currentTime = 0.4;
    player.push(packet(1, 20_000, 2));
    expect(configures).toBe(2);
    // Audio already scheduled from the old capture stops rather than finishing over the new.
    expect(frames[0]!.stopped).toBe(true);
    outputs.at(-1)!(audioData(960, 20_000) as unknown as AudioData);
    expect(frames.at(-1)!.at).toBeCloseTo(0.46, 5);
    player.stop();
  });

  it("rejects a replaced capture's stale decoder output instead of letting it take a placement", () => {
    const player = createPreviewAudioPlayer();
    player.push(packet(0, 0));
    const staleOutput = outputs.at(-1)!;
    // The decoder has not answered when the capture is replaced, and the same source time then
    // arrives from the new one.
    currentTime = 0.1;
    player.push(packet(0, 0, 2));
    const freshOutput = outputs.at(-1)!;
    // The old decoder's answer would land on the new capture's placement at that same source
    // time if its reset had not detached it.
    staleOutput(audioData(960, 0) as unknown as AudioData);
    expect(frames).toHaveLength(0);
    freshOutput(audioData(960, 0) as unknown as AudioData);
    expect(frames).toHaveLength(1);
    expect(frames[0]!.at).toBeCloseTo(0.16, 5);
    player.stop();
  });

  it("schedules a navigated document's audio from its new clock", () => {
    const player = createPreviewAudioPlayer();
    player.push(packet(0, 0));
    outputs.at(-1)!(audioData(960, 0) as unknown as AudioData);
    expect(frames.map(({ at }) => at)).toEqual([0.06]);

    // The page navigated and its encoder restarted at source 0 while the link stalled, so the
    // new document's first packet arrives long after the clock passed the old run's source 0.
    currentTime = 5;
    player.push(packet(0, 0, 2));
    outputs.at(-1)!(audioData(960, 0) as unknown as AudioData);
    player.push(packet(1, 20_000, 2));
    outputs.at(-1)!(audioData(960, 20_000) as unknown as AudioData);
    // Only the reset a generation change performs lets these play; without it both are dropped.
    expect(frames.slice(1).map(({ at }) => at)).toHaveLength(2);
    expect(frames[1]!.at).toBeCloseTo(5.06, 5);
    expect(frames[2]!.at).toBeCloseTo(5.08, 5);
    player.stop();
  });

  it("drops duplicate and reordered packets", () => {
    const player = createPreviewAudioPlayer();
    player.push(packet(4, 0));
    player.push(packet(4, 0));
    player.push(packet(3, 0));
    expect(decodes).toBe(1);
    player.stop();
  });

  it("keeps decoding and the clock pin across mute, then rejects a stale backlog on unmute", () => {
    const player = createPreviewAudioPlayer();
    player.push(packet(0, 0));
    outputs.at(-1)!(audioData(960, 0) as unknown as AudioData);
    expect(frames.map(({ at }) => at)).toEqual([0.06]);

    const gain = FakeAudioContext.instances[0]!.gains[0]!;
    player.setMuted(true);
    // Mute is a gain value, not a teardown: the context, decoder and clock pin all survive.
    expect(gain.value).toBe(0);
    expect(closed).toBe(0);
    expect(FakeAudioContext.instances).toHaveLength(1);

    // A muted packet still decodes, still advances the run, and is scheduled silently.
    currentTime = 0.1;
    player.push(packet(1, 100_000));
    outputs.at(-1)!(audioData(960, 100_000) as unknown as AudioData);
    expect(decodes).toBe(2);
    expect(frames.at(-1)!.at).toBeCloseTo(0.16, 5);

    // The link then stalls while muted. The pin still says source 0 plays at 0.06, so when
    // those stale packets arrive unmuting cannot anchor them to the present.
    currentTime = 5;
    for (let index = 2; index <= 11; index += 1) player.push(packet(index, index * 20_000));
    player.setMuted(false);
    expect(gain.value).toBe(1);
    expect(FakeAudioContext.instances).toHaveLength(1);
    expect(frames).toHaveLength(2);

    player.push(packet(12, 5_000_000));
    outputs.at(-1)!(audioData(960, 5_000_000) as unknown as AudioData);
    expect(frames).toHaveLength(3);
    expect(frames.at(-1)!.at).toBeCloseTo(5.06, 5);
    player.stop();
  });

  it("reports a blocked context once and still decodes on the next gesture", () => {
    state = "suspended";
    const onBlocked = vi.fn();
    const player = createPreviewAudioPlayer({ onBlocked });
    player.push(packet(0, 0));
    expect(decodes).toBe(0);

    state = "running";
    player.resume();
    player.push(packet(1, 20_000));
    expect(decodes).toBe(1);
    player.stop();
  });
});

describe("preview stream downloads", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("offers a download at a URL carrying the stream's ticket", () => {
    const onDownload = vi.fn();
    createPreviewStreamClient(
      {
        ...target,
        access: { ...target.access, query: { wsTicket: "ticket" }, credentials: false },
      },
      {
        onFrame: vi.fn(),
        onDownload,
        onViewport: vi.fn(),
        onConnectedChange: vi.fn(),
        onUnauthorized: vi.fn(),
      },
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "download", id: "d1", fileName: "a b.csv", sizeBytes: 3 }),
    );
    expect(onDownload).toHaveBeenCalledExactlyOnceWith({
      fileName: "a b.csv",
      sizeBytes: 3,
      url: "http://preview.test/api/preview-stream/download?threadId=thread&tabId=tab&id=d1&wsTicket=ticket",
    });
  });
});

describe("preview stream agent pointer", () => {
  beforeEach(() => vi.stubGlobal("WebSocket", FakeSocket));
  afterEach(() => vi.unstubAllGlobals());

  it("reports where the agent moves and clicks, ignoring malformed points", () => {
    const onPointer = vi.fn();
    createPreviewStreamClient(target, {
      onFrame: vi.fn(),
      onPointer,
      onViewport: vi.fn(),
      onConnectedChange: vi.fn(),
      onUnauthorized: vi.fn(),
    });
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "drag", x: 1, y: 2, sequence: 1 }),
    );
    FakeSocket.current.message(
      JSON.stringify({ type: "pointer", phase: "click", x: 140, y: 50, sequence: 2 }),
    );
    expect(onPointer).toHaveBeenCalledExactlyOnceWith({
      phase: "click",
      x: 140,
      y: 50,
      sequence: 2,
    });
  });
});
