import { describe, expect, it } from "vite-plus/test";

import { buildPreviewStreamScript } from "../../../scripts/generate-device-stream.mts";
import { previewStreamDocument, type PreviewStreamMessage } from "./preview-stream-document";

const configuration = JSON.stringify({
  access: {
    httpBase: "https://environment.test/api/preview-stream",
    wsBase: "wss://environment.test/api/preview-stream",
    credentials: false,
    query: {},
  },
  threadId: "thread",
  tabId: "tab",
  interactive: true,
  background: "#000",
  reuseNearbyTouchProbe: false,
  labels: {
    page: "Browser page",
    pageInput: "Browser page input",
    pictureInPictureNotReady: "The page has not shown yet. Try again in a moment.",
    pictureInPictureUnavailable: "Picture in picture is unavailable.",
  },
});

const STOPPED_DETAIL = "Browser viewer stopped unexpectedly.";

const statuses = (messages: ReadonlyArray<PreviewStreamMessage>) =>
  messages.flatMap((message) => (message.type === "status" ? [message.status] : []));

/**
 * Runs the document's own script element in this window, the way an inline script runs: global
 * scope, so the viewer's own global appears where the WebView would put it.
 */
const runDocument = (html: string) => {
  const messages: PreviewStreamMessage[] = [];
  Object.assign(window, {
    ReactNativeWebView: {
      postMessage: (data: string) => messages.push(JSON.parse(data) as PreviewStreamMessage),
    },
    // Measurement waits for a real layout; the viewer must still reach its first start.
    ResizeObserver: class {
      observe() {}
      disconnect() {}
    },
    WebSocket: class {
      static readonly OPEN = 1;
      readyState = 0;
      addEventListener() {}
      send() {}
      close() {}
    },
  });
  // jsdom has no 2D context without its canvas package; painting is not what this proves.
  HTMLCanvasElement.prototype.getContext = () => null;
  const script = new DOMParser().parseFromString(html, "text/html").querySelector("script");
  // An uncaught throw is what a browser turns into the error event the document reports.
  try {
    // oxlint-disable-next-line eslint/no-eval -- This runs the document's own inline script, as a WebView would.
    globalThis.eval(script?.textContent ?? "");
    return { messages, failure: null };
  } catch (error) {
    return { messages, failure: String(error) };
  }
};

describe("preview stream document", () => {
  // One build for both cases; the bundler is the slow part of this file.
  const script = buildPreviewStreamScript();

  it("runs the production bundle before it seeds mute and starts the viewer", async () => {
    for (const muted of [true, false]) {
      const { messages, failure } = runDocument(
        previewStreamDocument(configuration, await script, STOPPED_DETAIL, muted),
      );
      expect(failure).toBeNull();
      expect(statuses(messages)).toEqual(["connecting"]);
      expect(document.querySelector("canvas")).not.toBeNull();
      expect(document.querySelector('textarea[aria-label="Browser page input"]')).not.toBeNull();
      expect(
        (window as unknown as { T3PreviewStream: { muted?: boolean } }).T3PreviewStream.muted,
      ).toBe(muted);
    }
  });

  it("would fail if mute were seeded before the bundle defined the viewer", async () => {
    // A fresh document has no viewer or page in it; the first case left both on this window.
    Reflect.deleteProperty(globalThis, "T3PreviewStream");
    document.body.replaceChildren();
    // The ordering this guards: the old document seeded a global the bundle had not created yet.
    // In the WebView that throw reaches the document's error handler, so the viewer never starts.
    const { messages, failure } = runDocument(
      previewStreamDocument(
        configuration,
        `window.T3PreviewStream.muted = false;\n${await script}`,
        STOPPED_DETAIL,
      ),
    );
    expect(failure).toContain("setting 'muted'");
    expect(statuses(messages)).toEqual([]);
    expect(document.querySelector("canvas")).toBeNull();
  });
});
