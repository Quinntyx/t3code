import { EnvironmentId } from "@t3tools/contracts";
import type {
  PreviewStreamControl,
  PreviewStreamEvents,
  PreviewStreamInput,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn<(target: unknown, handlers: PreviewStreamEvents) => unknown>(),
  sent: [] as PreviewStreamInput[],
  access: { url: "ws://preview.test", token: "test" },
  painted: null as (() => void) | null,
  useRealPainter: false,
}));

vi.mock(import("@t3tools/client-runtime/preview/server-browser-stream"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createPreviewStreamClient: mocks.createClient as never,
    createPreviewFramePainter: (canvas, onPainted, onKeyFrameNeeded) => {
      if (mocks.useRealPainter) {
        return actual.createPreviewFramePainter(canvas, onPainted, onKeyFrameNeeded);
      }
      mocks.painted = onPainted ?? null;
      return { paint: () => undefined, reset: () => undefined, stop: () => undefined };
    },
  };
});

vi.mock(import("~/state/previewStream"), async (original) => ({
  ...(await original()),
  usePreviewStreamAccess: () => mocks.access as never,
}));

import { ServerBrowserSurface } from "./ServerBrowserSurface";

const JPEG_FRAME = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;

function setup() {
  mocks.sent.length = 0;
  mocks.painted = null;
  mocks.useRealPainter = false;
  mocks.createClient.mockReset().mockImplementation(() => ({
    send: (input: PreviewStreamInput) => mocks.sent.push(input),
    requestKeyFrame: () => undefined,
    stop: () => undefined,
  }));
}

async function renderSurface(controller: PreviewStreamControl["controller"]) {
  const container = document.createElement("div");
  container.style.cssText = "width: 400px; height: 300px; display: flex;";
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <ServerBrowserSurface
        environmentId={EnvironmentId.make("environment-copy")}
        threadId="thread-copy"
        tabId="tab-copy"
        visible
        followSize={false}
        className="flex-1"
      />,
      { container },
    ),
  );
  await vi.waitFor(() => expect(mocks.createClient).toHaveBeenCalled());
  const handlers = mocks.createClient.mock.calls.at(-1)![1];
  await act(() => {
    handlers.onControl?.({ canOperate: true, controller, generation: 1, dialog: null });
    mocks.painted?.();
  });
  mocks.sent.length = 0;
  const input = container.querySelector("textarea")!;
  const canvas = container.querySelector("canvas")!;
  stack.move();
  return { screen, input, canvas };
}

const keys = () => mocks.sent.filter((input) => input.type === "key");

async function renderStream(tabId = "tab-copy") {
  const container = document.createElement("div");
  container.style.cssText = "width: 400px; height: 300px; display: flex;";
  const surface = (nextTabId: string) => (
    <ServerBrowserSurface
      environmentId={EnvironmentId.make("environment-copy")}
      threadId="thread-copy"
      tabId={nextTabId}
      visible
      followSize={false}
      environmentLabel="build-box"
      className="flex-1"
    />
  );
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(surface(tabId), { container }));
  await vi.waitFor(() => expect(mocks.createClient).toHaveBeenCalled());
  stack.move();
  const handlers = () => mocks.createClient.mock.calls.at(-1)![1];
  return {
    screen,
    container,
    handlers,
    rerender: async (nextTabId: string) => {
      await screen.rerender(surface(nextTabId));
      await vi.waitFor(() =>
        expect(mocks.createClient.mock.calls.at(-1)![0]).toMatchObject({ tabId: nextTabId }),
      );
    },
  };
}

describe("ServerBrowserSurface stream phases", () => {
  it("moves from connecting to live, gates input until video paints, and recovers cleanly on reconnect", async () => {
    setup();
    const { screen, container, handlers } = await renderStream();
    await using _screen = screen;
    const canvas = container.querySelector("canvas")!;
    const input = container.querySelector("textarea")!;

    await expect.element(screen.getByText("Connecting to remote stream…")).toBeVisible();
    await expect.element(screen.getByText("Connecting to remote browser")).toBeVisible();
    await expect.element(screen.getByText("build-box")).toBeVisible();
    expect(input.disabled).toBe(true);
    await expect
      .element(screen.getByRole("button", { name: "Take control" }))
      .not.toBeInTheDocument();

    // Control ownership before the first frame paints stays awaiting-frame and keeps keyboard input disabled.
    await act(() => {
      handlers().onViewport?.({ width: 400, height: 300 });
      handlers().onControl?.({
        canOperate: true,
        controller: "you",
        generation: 1,
        dialog: null,
      });
    });
    await expect.element(screen.getByText("Waiting for video frame…")).toBeVisible();
    await expect.element(screen.getByText("Waiting for first frame…")).toBeVisible();
    expect(input.disabled).toBe(true);
    await expect
      .element(screen.getByRole("button", { name: "Release control" }))
      .not.toBeInTheDocument();
    mocks.sent.length = 0;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(keys()).toEqual([]);

    await act(() => mocks.painted?.());
    await expect.element(screen.getByText("You have control")).toBeVisible();
    await expect.element(screen.getByText("Connecting to remote browser")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Release control" })).toBeVisible();
    expect(input.disabled).toBe(false);

    await act(() => handlers().onConnectedChange?.(false));
    await expect.element(screen.getByText("Reconnecting stream…")).toBeVisible();
    await expect.element(screen.getByText("Reconnecting to remote browser…")).toBeVisible();
    expect(container.querySelector("canvas")).toBe(canvas);
    expect(input.disabled).toBe(true);
    await expect
      .element(screen.getByRole("button", { name: "Release control" }))
      .not.toBeInTheDocument();

    // Control returning before a replacement frame paints keeps reconnecting active and gates input.
    await act(() =>
      handlers().onControl?.({
        canOperate: true,
        controller: "you",
        generation: 2,
        dialog: null,
      }),
    );
    await expect.element(screen.getByText("Reconnecting stream…")).toBeVisible();
    await expect.element(screen.getByText("Reconnecting to remote browser…")).toBeVisible();
    expect(input.disabled).toBe(true);
    await expect
      .element(screen.getByRole("button", { name: "Release control" }))
      .not.toBeInTheDocument();
    mocks.sent.length = 0;
    await userEvent.click(canvas);
    expect(mocks.sent.filter((entry) => entry.type === "mouse")).toEqual([]);

    await act(() => mocks.painted?.());
    await expect.element(screen.getByText("You have control")).toBeVisible();
    await expect
      .element(screen.getByText("Reconnecting to remote browser…"))
      .not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Release control" })).toBeVisible();
    expect(input.disabled).toBe(false);
  });

  it("ignores an in-flight frame decode from a dropped connection after reconnect", async () => {
    setup();
    mocks.useRealPainter = true;
    const decodes: Array<(bitmap: ImageBitmap) => void> = [];
    const createBitmapSpy = vi.spyOn(window, "createImageBitmap").mockImplementation(
      () =>
        new Promise((resolve) => {
          decodes.push(resolve);
        }),
    );
    const drawImageSpy = vi
      .spyOn(CanvasRenderingContext2D.prototype, "drawImage")
      .mockImplementation(() => undefined);
    try {
      const { screen, container, handlers } = await renderStream();
      await using _screen = screen;
      const input = container.querySelector("textarea")!;
      const fakeBitmap = () =>
        ({ width: 400, height: 300, close: vi.fn() }) as unknown as ImageBitmap;

      // Paint first frame so the surface is live.
      await act(async () => {
        handlers().onViewport?.({ width: 400, height: 300 });
        handlers().onControl?.({
          canOperate: true,
          controller: "you",
          generation: 1,
          dialog: null,
        });
        handlers().onFrame?.(JPEG_FRAME);
        decodes.shift()!(fakeBitmap());
        await Promise.resolve();
      });
      await expect.element(screen.getByText("You have control")).toBeVisible();
      expect(input.disabled).toBe(false);

      // Queue a frame decode on the first connection, then drop the socket before it resolves.
      await act(() => {
        handlers().onFrame?.(JPEG_FRAME);
        handlers().onConnectedChange?.(false);
      });
      expect(decodes).toHaveLength(1);
      await expect.element(screen.getByText("Reconnecting stream…")).toBeVisible();

      // Replacement socket grants control before sending video, then the stale decode finishes.
      const staleBitmap = fakeBitmap();
      await act(async () => {
        handlers().onControl?.({
          canOperate: true,
          controller: "you",
          generation: 2,
          dialog: null,
        });
        decodes.shift()!(staleBitmap);
        await Promise.resolve();
        await Promise.resolve();
      });
      expect(staleBitmap.close).toHaveBeenCalledOnce();
      await expect.element(screen.getByText("Reconnecting stream…")).toBeVisible();
      await expect.element(screen.getByText("Reconnecting to remote browser…")).toBeVisible();
      expect(input.disabled).toBe(true);

      // A fresh frame on the replacement connection restores live state.
      await act(async () => {
        handlers().onFrame?.(JPEG_FRAME);
        decodes.shift()!(fakeBitmap());
        await Promise.resolve();
        await Promise.resolve();
      });
      await expect.element(screen.getByText("You have control")).toBeVisible();
      expect(input.disabled).toBe(false);
    } finally {
      createBitmapSpy.mockRestore();
      drawImageSpy.mockRestore();
    }
  });

  it("starts over at connecting when the tab changes", async () => {
    setup();
    const { screen, handlers, rerender } = await renderStream("tab-one");
    await using _screen = screen;

    await act(() => {
      handlers().onControl?.({
        canOperate: true,
        controller: "you",
        generation: 1,
        dialog: null,
      });
      mocks.painted?.();
    });
    await expect.element(screen.getByText("You have control")).toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Release control" })).toBeVisible();

    await rerender("tab-two");
    await expect.element(screen.getByText("Connecting to remote stream…")).toBeVisible();
    await expect.element(screen.getByText("Connecting to remote browser")).toBeVisible();
    await expect
      .element(screen.getByRole("button", { name: "Release control" }))
      .not.toBeInTheDocument();
  });
});

describe("ServerBrowserSurface clipboard commands", () => {
  it("sends a native Copy or Cut menu command to the page once", async () => {
    setup();
    const { screen, input, canvas } = await renderSurface("you");
    await using _screen = screen;
    // Chromium runs a script Copy or Cut only during a user gesture, as a menu click is.
    await userEvent.click(canvas);
    input.focus();
    mocks.sent.length = 0;

    // Like Electron's webContents.copy(): the browser's Copy command, with no key.
    expect(document.execCommand("copy")).toBe(true);
    expect(keys()).toEqual([
      { type: "key", action: "down", key: "c", code: "KeyC", keyCode: 67, modifiers: 2 },
      { type: "key", action: "up", key: "c", code: "KeyC", keyCode: 67, modifiers: 2 },
    ]);

    mocks.sent.length = 0;
    expect(document.execCommand("cut")).toBe(true);
    expect(input.value).toBe("\u200b");
    expect(keys()).toEqual([
      { type: "key", action: "down", key: "x", code: "KeyX", keyCode: 88, modifiers: 2 },
      { type: "key", action: "up", key: "x", code: "KeyX", keyCode: 88, modifiers: 2 },
    ]);
  });

  it("sends a keyboard Copy or Cut once and leaves menu Copy working after any shortcut", async () => {
    setup();
    const { screen, input, canvas } = await renderSurface("you");
    await using _screen = screen;
    await userEvent.click(canvas);
    input.focus();
    const prevented: boolean[] = [];
    const onKeyDown = (event: KeyboardEvent) => {
      if (/^[cx]$/i.test(event.key)) prevented.push(event.defaultPrevented);
    };
    window.addEventListener("keydown", onKeyDown);
    using _listener = { [Symbol.dispose]: () => window.removeEventListener("keydown", onKeyDown) };

    // An unprevented copy or cut key also makes the browser fire copy or cut: here Chromium's
    // Ctrl key binding, on macOS Electron's menu after the Meta keyup.
    for (const [shortcut, cancels] of [
      ["{Control>}x{/Control}", true],
      ["{Control>}c{/Control}", true],
      ["{Meta>}{x>}{/Meta}{/x}", true],
      ["{Control>}{Shift>}c{/Shift}{/Control}", false],
      ["{Control>}{Alt>}x{/Alt}{/Control}", false],
    ] as const) {
      mocks.sent.length = 0;
      prevented.length = 0;
      await userEvent.keyboard(shortcut);
      expect(prevented, shortcut).toEqual([cancels]);
      expect(keys().filter((key) => /^[cx]$/i.test(key.key)).length, shortcut).toBe(2);
      expect(input.value).toBe("\u200b");

      mocks.sent.length = 0;
      expect(document.execCommand("copy")).toBe(true);
      expect(keys(), shortcut).toEqual([
        { type: "key", action: "down", key: "c", code: "KeyC", keyCode: 67, modifiers: 2 },
        { type: "key", action: "up", key: "c", code: "KeyC", keyCode: 67, modifiers: 2 },
      ]);
    }
  });

  it("sends nothing when another viewer controls the page", async () => {
    setup();
    const { screen, input } = await renderSurface("another-viewer");
    await using _screen = screen;

    expect(
      input.dispatchEvent(new ClipboardEvent("copy", { bubbles: true, cancelable: true })),
    ).toBe(false);
    expect(
      input.dispatchEvent(new ClipboardEvent("cut", { bubbles: true, cancelable: true })),
    ).toBe(false);
    expect(mocks.sent).toEqual([]);
  });
});

const mouseUp = (canvas: HTMLCanvasElement, button: number) => {
  const event = new MouseEvent("mouseup", { button, bubbles: true, cancelable: true });
  canvas.dispatchEvent(event);
  return event;
};

describe("ServerBrowserSurface history", () => {
  it("routes mouse thumb buttons to the preview's history instead of the app", async () => {
    setup();
    const { screen, input } = await renderSurface("you");
    await using _screen = screen;
    const canvas = input.closest("[data-server-browser-surface]")!.querySelector("canvas")!;

    expect(mouseUp(canvas, 3).defaultPrevented).toBe(true);
    expect(mouseUp(canvas, 4).defaultPrevented).toBe(true);
    expect(mocks.sent).toEqual([
      { type: "history", delta: -1 },
      { type: "history", delta: 1 },
    ]);
  });

  it("leaves other mouse buttons alone", async () => {
    setup();
    const { screen, input } = await renderSurface("you");
    await using _screen = screen;
    const canvas = input.closest("[data-server-browser-surface]")!.querySelector("canvas")!;

    expect(mouseUp(canvas, 0).defaultPrevented).toBe(false);
    expect(mocks.sent).toEqual([]);
  });

  it("does not forward thumb-button presses to the page", async () => {
    setup();
    const { screen, input } = await renderSurface("you");
    await using _screen = screen;
    const canvas = input.closest("[data-server-browser-surface]")!.querySelector("canvas")!;
    canvas.width = 400;
    canvas.height = 300;
    // Synthetic pointers have no active pointer id to capture.
    canvas.setPointerCapture = () => undefined;
    const handlers = mocks.createClient.mock.calls.at(-1)![1];
    await act(() => {
      mocks.painted?.();
      handlers.onViewport({ width: 400, height: 300 });
    });
    const { left, top } = canvas.getBoundingClientRect();
    const press = (type: "pointerdown" | "pointerup", button: number) =>
      canvas.dispatchEvent(
        new PointerEvent(type, {
          button,
          buttons: type === "pointerdown" ? 1 << button : 0,
          clientX: left + 10,
          clientY: top + 10,
          pointerType: "mouse",
          bubbles: true,
        }),
      );
    const mouseInputs = () => mocks.sent.filter((input) => input.type === "mouse");

    for (const button of [3, 4]) {
      press("pointerdown", button);
      press("pointerup", button);
    }
    expect(mouseInputs()).toEqual([]);

    press("pointerdown", 0);
    expect(mouseInputs()).not.toEqual([]);
  });
});
