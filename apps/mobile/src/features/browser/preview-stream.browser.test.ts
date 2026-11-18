import { expect, it, vi } from "vite-plus/test";

import { start, stop } from "./preview-stream.browser";

it.each([
  { platform: "android", reuseNearbyTouchProbe: false },
  { platform: "ios", reuseNearbyTouchProbe: true },
])(
  "uses nearby probe answers for touch keyboard focus only on iOS ($platform)",
  ({ reuseNearbyTouchProbe }) => {
    const sockets: TestSocket[] = [];
    class TestSocket extends EventTarget {
      static OPEN = 1;
      readyState = TestSocket.OPEN;
      constructor() {
        super();
        sockets.push(this);
      }
      send() {}
      close() {}
      receive(message: object) {
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
      }
    }
    vi.useFakeTimers();
    using _rect = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue(new DOMRect(0, 0, 300, 150));
    using _context = vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(null);
    vi.stubGlobal("WebSocket", TestSocket);
    vi.stubGlobal("ReactNativeWebView", { postMessage() {} });
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
    try {
      const configuration = {
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
      };
      start(configuration);
      vi.runOnlyPendingTimers();
      const socket = sockets[0]!;
      socket.receive({ type: "viewport", width: 300, height: 150 });
      socket.receive({
        type: "control",
        canOperate: true,
        controller: "you",
        generation: 1,
        dialog: null,
      });

      const canvas = document.querySelector("canvas")!;
      const input = document.querySelector("textarea")!;
      const tap = (x: number) => {
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
      };

      expect(document.activeElement).not.toBe(input);
      // The first tap hits a text field. Its response comes after pointerup.
      tap(40);
      socket.receive({ type: "probe", x: 40, y: 40, editable: true });
      expect(document.activeElement).toBe(input);
      input.blur();

      // The next tap hits a button close enough to reuse the previous answer on iOS.
      tap(56);
      expect(document.activeElement === input).toBe(reuseNearbyTouchProbe);
      socket.receive({ type: "probe", x: 56, y: 40, editable: false });
      expect(document.activeElement).not.toBe(input);
    } finally {
      stop();
      document.body.replaceChildren();
      vi.unstubAllGlobals();
      vi.useRealTimers();
    }
  },
);
