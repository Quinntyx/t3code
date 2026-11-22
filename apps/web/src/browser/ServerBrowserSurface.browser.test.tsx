import { EnvironmentId } from "@t3tools/contracts";
import type {
  PreviewStreamControl,
  PreviewStreamEvents,
  PreviewStreamInput,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";

const mocks = vi.hoisted(() => ({
  createClient: vi.fn<(target: unknown, handlers: PreviewStreamEvents) => unknown>(),
  reset: vi.fn(),
  refreshAccess: vi.fn(),
  sent: [] as PreviewStreamInput[],
  access: { url: "ws://preview.test", token: "test" } as { url: string; token: string } | null,
  accessError: null as string | null,
  accessPending: false,
  painted: null as (() => void) | null,
}));

vi.mock(import("@t3tools/client-runtime/preview/server-browser-stream"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    createPreviewStreamClient: mocks.createClient as never,
    createPreviewFramePainter: (_canvas, onPainted) => {
      mocks.painted = onPainted ?? null;
      return { paint: () => undefined, reset: mocks.reset, stop: () => undefined };
    },
  };
});

vi.mock(import("~/state/previewStream"), async (original) => ({
  ...(await original()),
  usePreviewStreamAccess: () => mocks.access as never,
  usePreviewStreamAccessState: () => ({
    access: mocks.access as never,
    error: mocks.accessError,
    isPending: mocks.accessPending,
  }),
  refreshPreviewStreamAccess: mocks.refreshAccess,
}));

import { type ServerBrowserHandle, ServerBrowserSurface } from "./ServerBrowserSurface";

function setup() {
  mocks.sent.length = 0;
  mocks.painted = null;
  mocks.access = { url: "ws://preview.test", token: "test" };
  mocks.accessError = null;
  mocks.accessPending = false;
  mocks.reset.mockReset();
  mocks.refreshAccess.mockReset();
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
  const handleRef: { current: ServerBrowserHandle | null } = { current: null };
  const surface = (nextTabId: string) => (
    <ServerBrowserSurface
      ref={handleRef}
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
  await vi.waitFor(() =>
    expect(mocks.createClient.mock.calls.at(-1)?.[0]).toMatchObject({ tabId }),
  );
  stack.move();
  const handlers = () => mocks.createClient.mock.calls.at(-1)![1];
  return {
    screen,
    container,
    handleRef,
    handlers,
    flush: (nextTabId = tabId) => screen.rerender(surface(nextTabId)),
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
    await expect
      .element(screen.getByText("Waiting for video frame · You have control"))
      .toBeVisible();
    await expect.element(screen.getByText("Waiting for first frame…")).toBeVisible();
    expect(input.disabled).toBe(true);
    await expect.element(screen.getByRole("button", { name: "Release control" })).toBeVisible();
    mocks.sent.length = 0;
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "a", bubbles: true }));
    expect(keys()).toEqual([]);

    await act(() => mocks.painted?.());
    await expect.element(screen.getByText("You have control")).toBeVisible();
    await expect.element(screen.getByText("Connecting to remote browser")).not.toBeInTheDocument();
    await expect.element(screen.getByRole("button", { name: "Release control" })).toBeVisible();
    expect(input.disabled).toBe(false);

    await act(() => handlers().onConnectedChange?.(false));
    expect(mocks.reset).toHaveBeenCalledTimes(1);
    await expect.element(screen.getByText("Reconnecting stream…")).toBeVisible();
    await expect.element(screen.getByText("Reconnecting to remote browser…")).toBeVisible();
    expect(container.querySelector("canvas")).toBe(canvas);
    expect(input.disabled).toBe(true);
    await expect
      .element(screen.getByRole("button", { name: "Release control" }))
      .not.toBeInTheDocument();

    // Another viewer holding control during reconnect names the controller alongside the disabled Take control button.
    await act(() =>
      handlers().onControl?.({
        canOperate: true,
        controller: "another-viewer",
        generation: 2,
        dialog: null,
      }),
    );
    await expect
      .element(screen.getByText("Reconnecting stream · Another viewer has control"))
      .toBeVisible();
    await expect.element(screen.getByRole("button", { name: "Take control" })).toBeDisabled();

    // Control returning before a replacement frame paints keeps reconnecting active and gates input while exposing control recovery.
    await act(() =>
      handlers().onControl?.({
        canOperate: true,
        controller: "you",
        generation: 3,
        dialog: null,
      }),
    );
    await expect.element(screen.getByText("Reconnecting stream · You have control")).toBeVisible();
    await expect.element(screen.getByText("Reconnecting to remote browser…")).toBeVisible();
    expect(input.disabled).toBe(true);
    await expect.element(screen.getByRole("button", { name: "Release control" })).toBeVisible();
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

    // Even after a replacement frame paints, pointer input stays gated until the reconnected stream sends a fresh viewport.
    canvas.width = 400;
    canvas.height = 300;
    canvas.setPointerCapture = () => undefined;
    const { left, top, width, height } = canvas.getBoundingClientRect();
    const clickCenter = () =>
      canvas.dispatchEvent(
        new PointerEvent("pointerdown", {
          button: 0,
          buttons: 1,
          clientX: left + width / 2,
          clientY: top + height / 2,
          pointerType: "mouse",
          bubbles: true,
        }),
      );
    mocks.sent.length = 0;
    clickCenter();
    expect(mocks.sent.filter((entry) => entry.type === "mouse")).toEqual([]);

    await act(() => handlers().onViewport({ width: 800, height: 600 }));
    clickCenter();
    expect(mocks.sent.filter((entry) => entry.type === "mouse")).toContainEqual(
      expect.objectContaining({ type: "mouse", action: "down", x: 400, y: 300 }),
    );
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

  it("allows taking control during awaiting-frame with or without a dialog while gating page input", async () => {
    setup();
    const { screen, container, handlers } = await renderStream();
    await using _screen = screen;
    const input = container.querySelector("textarea")!;
    const canvas = container.querySelector("canvas")!;

    await act(() =>
      handlers().onControl?.({
        canOperate: true,
        controller: "unclaimed",
        generation: 1,
        dialog: null,
      }),
    );
    await expect.element(screen.getByText("Waiting for video frame · Watching")).toBeVisible();
    const takeControl = screen.getByRole("button", { name: "Take control" });
    await expect.element(takeControl).toBeVisible();
    await userEvent.click(takeControl);
    expect(mocks.sent).toContainEqual({ type: "takeControl" });
    expect(input.disabled).toBe(true);
    mocks.sent.length = 0;
    await userEvent.click(canvas);
    expect(mocks.sent.filter((entry) => entry.type === "mouse")).toEqual([]);

    const takeControlElement = takeControl.element() as HTMLElement;
    takeControlElement.focus();
    await act(() =>
      handlers().onControl?.({
        canOperate: true,
        controller: "unclaimed",
        generation: 2,
        dialog: { type: "alert", message: "Blocking alert", defaultValue: "" },
      }),
    );
    await expect.element(screen.getByText("Blocking alert")).toBeVisible();
    expect(document.activeElement).toBe(takeControlElement);
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toBe(
      "Browser dialog: Blocking alert",
    );
    await userEvent.click(screen.getByRole("button", { name: "Take control" }));
    expect(mocks.sent).toContainEqual({ type: "takeControl" });
  });

  it("ignores a touch gesture started before the first frame paints", async () => {
    setup();
    const { screen, container, handlers } = await renderStream();
    await using _screen = screen;
    const canvas = container.querySelector("canvas")!;
    canvas.width = 400;
    canvas.height = 300;
    await act(() => {
      handlers().onViewport?.({ width: 400, height: 300 });
      handlers().onControl?.({
        canOperate: true,
        controller: "you",
        generation: 1,
        dialog: null,
      });
    });

    const { left, top } = canvas.getBoundingClientRect();
    canvas.dispatchEvent(
      new PointerEvent("pointerdown", {
        pointerType: "touch",
        pointerId: 1,
        isPrimary: true,
        clientX: left + 20,
        clientY: top + 20,
        bubbles: true,
      }),
    );
    await act(() => mocks.painted?.());
    mocks.sent.length = 0;
    canvas.dispatchEvent(
      new PointerEvent("pointerup", {
        pointerType: "touch",
        pointerId: 1,
        isPrimary: true,
        clientX: left + 20,
        clientY: top + 20,
        bubbles: true,
      }),
    );
    expect(mocks.sent.filter((entry) => entry.type === "mouse")).toEqual([]);
  });

  it("hides decorative connecting and reconnecting overlays from assistive technology", async () => {
    setup();
    const { screen, handlers } = await renderStream();
    await using _screen = screen;

    const connectingOverlay = screen
      .getByText("Connecting to remote browser")
      .element()
      .closest('[aria-hidden="true"]');
    expect(connectingOverlay).not.toBeNull();
    expect(connectingOverlay?.textContent).toContain("Starting video stream from build-box…");

    await act(() => {
      handlers().onControl?.({
        canOperate: true,
        controller: "unclaimed",
        generation: 1,
        dialog: null,
      });
      mocks.painted?.();
    });
    await act(() => handlers().onConnectedChange?.(false));

    const reconnectingOverlay = screen
      .getByText("Reconnecting to remote browser…")
      .element()
      .closest('[aria-hidden="true"]');
    expect(reconnectingOverlay).not.toBeNull();
  });

  it("uses a full overlay for pre-frame refusal and a non-obscuring banner once a frame is retained", async () => {
    setup();
    const first = await renderStream();
    await using _first = first.screen;
    await act(() => {
      first.handlers().onUnauthorized?.();
      first.handlers().onUnauthorized?.();
      first.handlers().onUnauthorized?.();
    });
    expect(first.container.querySelector('[data-error-layout="overlay"]')).not.toBeNull();
    expect(first.container.querySelector('[data-error-layout="banner"]')).toBeNull();

    const second = await renderStream("tab-2");
    await using _second = second.screen;
    await act(() => {
      second.handlers().onControl?.({
        canOperate: true,
        controller: "unclaimed",
        generation: 1,
        dialog: null,
      });
      mocks.painted?.();
    });
    await act(() => {
      second.handlers().onConnectedChange?.(false);
      second.handlers().onUnauthorized?.();
      second.handlers().onUnauthorized?.();
      second.handlers().onUnauthorized?.();
    });
    expect(second.container.querySelector('[data-error-layout="banner"]')).not.toBeNull();
    expect(second.container.querySelector('[data-error-layout="overlay"]')).toBeNull();

    // Clicking Reconnect refreshes credentials and waits for a fresh access object instead of reopening with the refused token.
    const callsBeforeReconnect = mocks.createClient.mock.calls.length;
    mocks.refreshAccess.mockClear();
    await userEvent.click(second.screen.getByRole("button", { name: "Reconnect" }));
    expect(mocks.refreshAccess).toHaveBeenCalledTimes(1);
    expect(mocks.createClient).toHaveBeenCalledTimes(callsBeforeReconnect);

    mocks.accessPending = true;
    await second.flush("tab-2");
    await expect
      .element(second.screen.getByRole("button", { name: "Reconnecting…" }))
      .toBeDisabled();

    mocks.accessPending = false;
    mocks.access = { url: "ws://preview.test", token: "fresh-token" };
    await second.rerender("tab-2");
    expect(mocks.createClient).toHaveBeenCalledTimes(callsBeforeReconnect + 1);
    expect(second.container.querySelector('[data-error-layout="banner"]')).toBeNull();

    // A mid-session ticket lookup failure surfaces in the retained-frame banner instead of looping on "Reconnecting stream…".
    await act(() => {
      second.handlers().onViewport({ width: 400, height: 300 });
      second.handlers().onControl?.({
        canOperate: true,
        controller: "you",
        generation: 2,
        dialog: null,
      });
      mocks.painted?.();
    });
    mocks.sent.length = 0;
    mocks.access = null;
    mocks.accessError = "HTTP 403 Forbidden";
    await second.flush("tab-2");
    const banner = second.container.querySelector('[data-error-layout="banner"]');
    expect(banner?.textContent).toContain("HTTP 403 Forbidden");
    const statusText = second.screen.getByText("Stream disconnected").element();
    expect(statusText.getAttribute("role")).toBeNull();
    const statusBar = statusText.closest("div.flex.h-8");
    expect(statusBar?.getAttribute("aria-hidden")).toBeNull();
    expect(statusBar?.querySelector(".bg-destructive")).not.toBeNull();
    expect(statusBar?.querySelector(".bg-success")).toBeNull();
    expect(statusBar?.querySelector("button")).toBeNull();
    await userEvent.click(second.container.querySelector("canvas")!);
    expect(mocks.sent).toEqual([]);
    await expect.element(second.screen.getByRole("button", { name: "Reconnect" })).toBeEnabled();
    await userEvent.click(second.screen.getByRole("button", { name: "Reconnect" }));
    expect(mocks.refreshAccess).toHaveBeenCalledTimes(2);
  });

  it("keeps imperative canvas() available during reconnect for retained frames and clears it on tab change", async () => {
    setup();
    const { screen, container, handleRef, handlers, rerender } = await renderStream("tab-one");
    await using _screen = screen;
    const canvas = container.querySelector("canvas")!;

    expect(handleRef.current?.canvas()).toBeNull();

    await act(() =>
      handlers().onControl?.({
        canOperate: true,
        controller: "you",
        generation: 1,
        dialog: null,
      }),
    );
    expect(handleRef.current?.canvas()).toBeNull();

    await act(() => mocks.painted?.());
    expect(handleRef.current?.canvas()).toBe(canvas);

    await act(() => handlers().onConnectedChange?.(false));
    await expect.element(screen.getByText("Reconnecting stream…")).toBeVisible();
    expect(handleRef.current?.canvas()).toBe(canvas);

    await rerender("tab-two");
    expect(handleRef.current?.canvas()).toBeNull();

    await rerender("tab-one");
    expect(handleRef.current?.canvas()).toBeNull();
  });

  it("treats onGone as a terminal closed-tab state and clears the retained canvas", async () => {
    setup();
    const { screen, container, handleRef, handlers } = await renderStream("tab-closed");
    await using _screen = screen;
    const canvas = container.querySelector("canvas")!;

    await act(() => {
      handlers().onViewport({ width: 400, height: 300 });
      handlers().onControl?.({
        canOperate: true,
        controller: "you",
        generation: 1,
        dialog: null,
      });
      mocks.painted?.();
    });
    expect(handleRef.current?.canvas()).toBe(canvas);
    const clientCalls = mocks.createClient.mock.calls.length;

    await act(() => {
      handlers().onConnectedChange?.(false);
      handlers().onGone?.();
    });

    expect(handleRef.current?.canvas()).toBeNull();
    const overlay = container.querySelector('[data-error-layout="overlay"]');
    expect(overlay).not.toBeNull();
    expect(overlay?.textContent).toContain("This tab was closed.");
    expect(container.querySelector('[data-error-layout="banner"]')).toBeNull();
    await expect.element(screen.getByRole("button", { name: "Reconnect" })).not.toBeInTheDocument();
    await expect.element(screen.getByText("Reconnecting stream…")).not.toBeInTheDocument();
    expect(mocks.createClient).toHaveBeenCalledTimes(clientCalls);
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

describe("ServerBrowserSurface frames", () => {
  it("reports a connected stream that never delivers a frame until one arrives", async () => {
    setup();
    const onNoFrames = vi.fn();
    const container = document.createElement("div");
    container.style.cssText = "width: 400px; height: 300px; display: flex;";
    await using _screen = await render(
      <ServerBrowserSurface
        environmentId={EnvironmentId.make("environment-frames")}
        threadId="thread-frames"
        tabId="tab-frames"
        visible
        followSize={false}
        onNoFrames={onNoFrames}
        className="flex-1"
      />,
      { container },
    );
    await vi.waitFor(() => expect(mocks.createClient).toHaveBeenCalled());
    using _timers = fakeTimers();
    const handlers = mocks.createClient.mock.calls.at(-1)![1];
    await act(() => handlers.onConnectedChange(true));
    await act(() => vi.advanceTimersByTime(9_999));
    expect(onNoFrames).not.toHaveBeenCalled();
    expect(container.querySelector('[role="alert"]')).toBeNull();

    await act(() => vi.advanceTimersByTime(1));
    expect(onNoFrames).toHaveBeenCalledOnce();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("not drawing it");

    await act(() => mocks.painted?.());
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("clears the not-drawing alert when the same tab replaces its stream", async () => {
    setup();
    const container = document.createElement("div");
    container.style.cssText = "width: 400px; height: 300px; display: flex;";
    const screen = await render(
      <ServerBrowserSurface
        environmentId={EnvironmentId.make("environment-frames-reconnect")}
        threadId="thread-frames-reconnect"
        tabId="tab-frames-reconnect"
        visible
        followSize={false}
        className="flex-1"
      />,
      { container },
    );
    try {
      await vi.waitFor(() => expect(mocks.createClient).toHaveBeenCalledTimes(1));
      using _timers = fakeTimers();
      const handlers = mocks.createClient.mock.calls.at(-1)![1];
      await act(() => handlers.onConnectedChange(true));
      await act(() => vi.advanceTimersByTime(10_000));
      expect(container.querySelector('[role="alert"]')?.textContent).toContain("not drawing it");

      // Replacing the stream on the same tab (e.g. toggling followSize or visibility) must clear the stale alert.
      await screen.rerender(
        <ServerBrowserSurface
          environmentId={EnvironmentId.make("environment-frames-reconnect")}
          threadId="thread-frames-reconnect"
          tabId="tab-frames-reconnect"
          visible={false}
          followSize={false}
          className="flex-1"
        />,
      );
      await screen.rerender(
        <ServerBrowserSurface
          environmentId={EnvironmentId.make("environment-frames-reconnect")}
          threadId="thread-frames-reconnect"
          tabId="tab-frames-reconnect"
          visible
          followSize={false}
          className="flex-1"
        />,
      );
      expect(mocks.createClient).toHaveBeenCalledTimes(2);
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.textContent).toContain("Connecting to remote browser");
    } finally {
      await screen.unmount();
    }
  });
});
