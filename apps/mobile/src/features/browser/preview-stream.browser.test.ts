import { expect, it, vi } from "vite-plus/test";

import { start, stop } from "./preview-stream.browser";

const JPEG_FRAME = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;

class TestSocket extends EventTarget {
  static OPEN = 1;
  readyState = TestSocket.OPEN;
  sent: Array<unknown> = [];
  constructor(sockets: TestSocket[]) {
    super();
    sockets.push(this);
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
  open() {
    this.dispatchEvent(new Event("open"));
  }
  disconnect() {
    this.dispatchEvent(new CloseEvent("close", { code: 1006 }));
  }
  receive(message: object) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
  receiveFrame() {
    this.dispatchEvent(new MessageEvent("message", { data: JPEG_FRAME }));
  }
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
}

function mountMobileStream(reuseNearbyTouchProbe = false) {
  const sockets: TestSocket[] = [];
  const posted: Array<Record<string, unknown>> = [];
  class BoundSocket extends TestSocket {
    constructor() {
      super(sockets);
    }
  }
  vi.useFakeTimers();
  const rectSpy = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 0, 300, 150));
  const contextSpy = vi
    .spyOn(HTMLCanvasElement.prototype, "getContext")
    .mockReturnValue({ drawImage() {} } as unknown as CanvasRenderingContext2D);
  vi.stubGlobal("WebSocket", BoundSocket);
  vi.stubGlobal("createImageBitmap", async () => ({
    width: 300,
    height: 150,
    close() {},
  }));
  vi.stubGlobal("ReactNativeWebView", {
    postMessage(raw: string) {
      posted.push(JSON.parse(raw) as Record<string, unknown>);
    },
  });
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(private readonly notify: () => void) {}
      observe() {
        this.notify();
      }
      disconnect() {}
    },
  );
  start({
    interactive: true,
    reuseNearbyTouchProbe,
    threadId: "thread",
    tabId: "tab",
    background: "black",
    access: {
      httpBase: "https://environment.test/api/preview",
      wsBase: "wss://environment.test/api/preview",
      credentials: false,
      query: {},
    },
  });
  vi.runOnlyPendingTimers();
  return {
    sockets,
    posted,
    cleanup() {
      stop();
      rectSpy.mockRestore();
      contextSpy.mockRestore();
      document.body.replaceChildren();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    },
  };
}

function tapCanvas(canvas: HTMLCanvasElement, x: number) {
  for (const type of ["pointerdown", "pointerup"]) {
    canvas.dispatchEvent(
      new PointerEvent(type, {
        pointerType: "touch",
        pointerId: 1,
        isPrimary: true,
        clientX: x,
        clientY: 40,
      }),
    );
  }
}

it.each([
  { platform: "android", reuseNearbyTouchProbe: false },
  { platform: "ios", reuseNearbyTouchProbe: true },
])(
  "uses nearby probe answers for touch keyboard focus only on iOS ($platform)",
  async ({ reuseNearbyTouchProbe }) => {
    const harness = mountMobileStream(reuseNearbyTouchProbe);
    try {
      const socket = harness.sockets[0]!;
      socket.open();
      socket.receive({ type: "viewport", width: 300, height: 150 });
      socket.receive({
        type: "control",
        canOperate: true,
        controller: "you",
        generation: 1,
        dialog: null,
      });
      socket.receiveFrame();
      await flushMicrotasks();

      const canvas = document.querySelector("canvas")!;
      const input = document.querySelector("textarea")!;

      expect(document.activeElement).not.toBe(input);
      // The first tap hits a text field. Its response comes after pointerup.
      tapCanvas(canvas, 40);
      socket.receive({ type: "probe", x: 40, y: 40, editable: true });
      expect(document.activeElement).toBe(input);
      input.blur();

      // The next tap hits a button close enough to reuse the previous answer on iOS.
      tapCanvas(canvas, 56);
      expect(document.activeElement === input).toBe(reuseNearbyTouchProbe);
      socket.receive({ type: "probe", x: 56, y: 40, editable: false });
      expect(document.activeElement).not.toBe(input);
    } finally {
      harness.cleanup();
    }
  },
);

it("gates touch input during mid-session reconnect until a replacement frame paints", async () => {
  const harness = mountMobileStream();
  try {
    const first = harness.sockets[0]!;
    first.open();
    first.receive({ type: "viewport", width: 300, height: 150 });
    first.receive({
      type: "control",
      canOperate: true,
      controller: "you",
      generation: 1,
      dialog: null,
    });
    first.receiveFrame();
    await flushMicrotasks();

    // Drop the live socket and reconnect.
    first.disconnect();
    vi.runOnlyPendingTimers();
    const second = harness.sockets[1]!;
    second.open();
    second.receive({
      type: "control",
      canOperate: true,
      controller: "you",
      generation: 2,
      dialog: null,
    });

    const canvas = document.querySelector("canvas")!;
    const input = document.querySelector("textarea")!;
    second.sent.length = 0;
    expect(input.disabled).toBe(true);
    tapCanvas(canvas, 40);
    expect(second.sent.filter((entry) => (entry as { type?: string }).type === "mouse")).toEqual(
      [],
    );

    second.receiveFrame();
    await flushMicrotasks();
    expect(input.disabled).toBe(false);
    tapCanvas(canvas, 40);
    expect(
      second.sent.filter((entry) => (entry as { type?: string }).type === "mouse").length,
    ).toBeGreaterThan(0);
  } finally {
    harness.cleanup();
  }
});

it("reports connecting on disconnect when control arrived before the first frame", () => {
  const harness = mountMobileStream();
  try {
    const socket = harness.sockets[0]!;
    socket.open();
    socket.receive({
      type: "control",
      canOperate: true,
      controller: "you",
      generation: 1,
      dialog: null,
    });
    harness.posted.length = 0;

    socket.disconnect();
    expect(harness.posted).toContainEqual({ type: "status", status: "connecting" });
  } finally {
    harness.cleanup();
  }
});
