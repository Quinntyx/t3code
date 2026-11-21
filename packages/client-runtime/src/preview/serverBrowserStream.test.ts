import { encodePreviewStreamVideoFrame } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  createPreviewFramePainter,
  createPreviewStreamClient,
  previewStreamOverlayDetail,
  previewStreamPhase,
  previewStreamStatusLabel,
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

describe("preview stream phase", () => {
  const owned: PreviewStreamControl = {
    canOperate: true,
    controller: "you",
    generation: 1,
    dialog: null,
  };

  it("distinguishes initial connect, awaiting first frame, live, and mid-session reconnect", () => {
    expect(previewStreamPhase(null, false)).toBe("connecting");
    expect(previewStreamPhase(owned, false)).toBe("awaiting-frame");
    expect(previewStreamPhase(owned, true)).toBe("live");
    expect(previewStreamPhase(null, false, true)).toBe("reconnecting");
    expect(previewStreamPhase(owned, false, true)).toBe("reconnecting");
    expect(previewStreamPhase(null, true)).toBe("reconnecting");
  });

  it("preserves known controller ownership while waiting for a frame or reconnecting and names the host when connecting", () => {
    expect(previewStreamStatusLabel("connecting", null)).toBe("Connecting to remote stream…");
    expect(previewStreamStatusLabel("awaiting-frame", null)).toBe("Waiting for video frame…");
    expect(previewStreamStatusLabel("awaiting-frame", owned)).toBe(
      "Waiting for video frame · You have control",
    );
    expect(
      previewStreamStatusLabel("awaiting-frame", { ...owned, controller: "another-viewer" }),
    ).toBe("Waiting for video frame · Another viewer has control");
    expect(previewStreamStatusLabel("awaiting-frame", { ...owned, canOperate: false })).toBe(
      "Waiting for video frame · Read-only",
    );
    expect(previewStreamStatusLabel("live", owned)).toBe("You have control");
    expect(previewStreamStatusLabel("live", { ...owned, canOperate: false })).toBe("Read-only");
    expect(previewStreamStatusLabel("reconnecting", null)).toBe("Reconnecting stream…");
    expect(
      previewStreamStatusLabel("reconnecting", { ...owned, controller: "another-viewer" }),
    ).toBe("Reconnecting stream · Another viewer has control");

    expect(previewStreamOverlayDetail("connecting", "work-vps")).toBe(
      "Starting video stream from work-vps…",
    );
    expect(previewStreamOverlayDetail("connecting", "  ")).toBe("Starting video stream…");
    expect(previewStreamOverlayDetail("awaiting-frame", "work-vps")).toBe(
      "Waiting for first frame…",
    );
    expect(previewStreamOverlayDetail("reconnecting", "work-vps")).toBe(
      "Reconnecting to remote browser…",
    );
  });
});

describe("preview frame painter", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("drops in-flight and queued JPEG decodes on reset without clobbering the next connection", async () => {
    const decodes: Array<(bitmap: { width: number; height: number; close(): void }) => void> = [];
    vi.stubGlobal(
      "createImageBitmap",
      () =>
        new Promise((resolve) => {
          decodes.push(resolve);
        }),
    );
    const drawImage = vi.fn();
    const clearRect = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage, clearRect }),
    } as unknown as HTMLCanvasElement;
    const onPainted = vi.fn();
    const painter = createPreviewFramePainter(canvas, onPainted);
    const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
    const makeBitmap = () => ({ width: 320, height: 240, close: vi.fn() });

    // Start decoding frame 1 and queue frame 2, then reset as on socket disconnect.
    painter.paint(jpeg);
    painter.paint(jpeg);
    expect(decodes).toHaveLength(1);
    painter.reset();
    expect(clearRect).not.toHaveBeenCalled();

    // Start decoding a replacement frame before the stale decode resolves.
    painter.paint(jpeg);
    expect(decodes).toHaveLength(2);

    const staleBitmap = makeBitmap();
    decodes.shift()!(staleBitmap);
    await Promise.resolve();
    await Promise.resolve();
    expect(staleBitmap.close).toHaveBeenCalledOnce();
    expect(drawImage).not.toHaveBeenCalled();
    expect(onPainted).not.toHaveBeenCalled();
    // Stale finally must not dequeue frame 2 or clear decoding state for the replacement frame.
    expect(decodes).toHaveLength(1);

    const freshBitmap = makeBitmap();
    decodes.shift()!(freshBitmap);
    await Promise.resolve();
    await Promise.resolve();
    expect(freshBitmap.close).toHaveBeenCalledOnce();
    expect(drawImage).toHaveBeenCalledOnce();
    expect(onPainted).toHaveBeenCalledOnce();

    painter.stop();
  });

  it("ignores late VideoDecoder output and error callbacks from a pre-reset generation", () => {
    const decoders: Array<{
      readonly init: {
        readonly output: (frame: {
          readonly timestamp: number;
          readonly displayWidth: number;
          readonly displayHeight: number;
          readonly close: () => void;
        }) => void;
        readonly error: () => void;
      };
      state: "unconfigured" | "configured" | "closed";
      readonly close: ReturnType<typeof vi.fn>;
      readonly configure: ReturnType<typeof vi.fn>;
      readonly decode: ReturnType<typeof vi.fn>;
    }> = [];
    class FakeVideoDecoder {
      readonly init: {
        readonly output: (frame: {
          readonly timestamp: number;
          readonly displayWidth: number;
          readonly displayHeight: number;
          readonly close: () => void;
        }) => void;
        readonly error: () => void;
      };
      state: "unconfigured" | "configured" | "closed" = "unconfigured";
      readonly close = vi.fn(() => {
        this.state = "closed";
      });
      readonly configure = vi.fn(() => {
        this.state = "configured";
      });
      readonly decode = vi.fn();
      constructor(init: FakeVideoDecoder["init"]) {
        this.init = init;
        decoders.push(this);
      }
    }
    class FakeEncodedVideoChunk {
      readonly init: Record<string, unknown>;
      constructor(init: Record<string, unknown>) {
        this.init = init;
      }
    }
    vi.stubGlobal("VideoDecoder", FakeVideoDecoder);
    vi.stubGlobal("EncodedVideoChunk", FakeEncodedVideoChunk);

    const drawImage = vi.fn();
    const canvas = {
      width: 0,
      height: 0,
      getContext: () => ({ drawImage }),
    } as unknown as HTMLCanvasElement;
    const onPainted = vi.fn();
    const onKeyFrameNeeded = vi.fn();
    const painter = createPreviewFramePainter(canvas, onPainted, onKeyFrameNeeded);
    const keyFrame = encodePreviewStreamVideoFrame({
      type: "key",
      codec: "vp8",
      width: 320,
      height: 240,
      data: new Uint8Array([1, 2, 3]),
    }).buffer as ArrayBuffer;

    painter.paint(keyFrame);
    expect(decoders).toHaveLength(1);
    const staleDecoder = decoders[0]!;
    painter.reset();
    expect(staleDecoder.close).toHaveBeenCalledOnce();

    // Start decoding a fresh key frame on the new connection, then fire stale output & error.
    painter.paint(keyFrame);
    expect(decoders).toHaveLength(2);
    const freshDecoder = decoders[1]!;

    const staleFrame = { timestamp: 0, displayWidth: 320, displayHeight: 240, close: vi.fn() };
    staleDecoder.init.output(staleFrame);
    staleDecoder.init.error();
    expect(staleFrame.close).toHaveBeenCalledOnce();
    expect(drawImage).not.toHaveBeenCalled();
    expect(onPainted).not.toHaveBeenCalled();
    expect(onKeyFrameNeeded).not.toHaveBeenCalled();
    expect(freshDecoder.close).not.toHaveBeenCalled();

    const freshFrame = { timestamp: 1, displayWidth: 320, displayHeight: 240, close: vi.fn() };
    freshDecoder.init.output(freshFrame);
    expect(freshFrame.close).toHaveBeenCalledOnce();
    expect(drawImage).toHaveBeenCalledOnce();
    expect(onPainted).toHaveBeenCalledOnce();

    painter.stop();
  });
});
