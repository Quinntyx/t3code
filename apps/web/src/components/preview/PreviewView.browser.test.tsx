import {
  BUILT_IN_BROWSER_PROFILES,
  DEFAULT_BROWSER_PROFILE_ID,
  DEFAULT_PREVIEW_APPEARANCE,
  DEFAULT_PREVIEW_ZOOM_FACTOR,
  EnvironmentId,
  FILL_PREVIEW_VIEWPORT,
  ThreadId,
} from "@t3tools/contracts";
import { type ComponentProps } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";

import type { PreviewableServer } from "./useDiscoveredLocalServers";
import type {
  PreviewStreamControl,
  PreviewStreamEvents,
} from "@t3tools/client-runtime/preview/server-browser-stream";

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(async (_tabId: string, _url: string): Promise<void> => undefined),
  rememberPreviewUrl: vi.fn(),
  readPreparedConnection: vi.fn(() => ({ httpBaseUrl: "http://172.25.85.75:3773" })),
  readEnvironmentScope: vi.fn((_environmentId?: unknown, _scope?: unknown) => true),
  setAnnotationSendEnabled: vi.fn(async (_tabId: string, _enabled: boolean): Promise<void> => {}),
  cancelPickElement: vi.fn(async (_tabId: string) => undefined),
  openPictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  closePictureInPicture: vi.fn(async (_tabId: string): Promise<void> => undefined),
  pickElement: vi.fn(),
  addPreviewAnnotation: vi.fn(),
  addImage: vi.fn(),
  pictureInPicture: false,
  showEmptyState: false,
  loading: false,
  nativeServerTab: false,
  serverTab: false,
  navStatus: null as unknown,
  streamAccess: { url: "ws://preview.test", token: "test" },
  streamHandlers: null as PreviewStreamEvents | null,
  streamHandlersByTabId: new Map<string, PreviewStreamEvents>(),
  streamSend: vi.fn(() => false),
  serverEpoch: null as string | null,
  servers: [] as PreviewableServer[],
  recordingTabIds: new Set<string>(),
  recordingRuntimeTabId: null as string | null,
  recordVisitForThread: vi.fn(),
}));

const STUB_BROWSER_DEFAULTS = {
  viewport: FILL_PREVIEW_VIEWPORT,
  zoomFactor: DEFAULT_PREVIEW_ZOOM_FACTOR,
  appearance: DEFAULT_PREVIEW_APPEARANCE,
  autoShowFloatingPreview: true,
  profiles: BUILT_IN_BROWSER_PROFILES,
  profileId: DEFAULT_BROWSER_PROFILE_ID,
};

// The desktop bridge only exists inside Electron; the view reads it once at import.
vi.mock(import("./previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    navigate: mocks.navigate,
    pickElement: mocks.pickElement,
    annotationVoice: { onEvent: () => () => {}, update: async () => {} },
    setAnnotationSendEnabled: mocks.setAnnotationSendEnabled,
    cancelPickElement: mocks.cancelPickElement,
    refresh: vi.fn(async () => undefined),
    goBack: vi.fn(async () => undefined),
    goForward: vi.fn(async () => undefined),
    hardReload: vi.fn(async () => undefined),
    openDevTools: vi.fn(async () => undefined),
    setColorScheme: vi.fn(async () => undefined),
    zoomIn: vi.fn(async () => undefined),
    zoomOut: vi.fn(async () => undefined),
    resetZoom: vi.fn(async () => undefined),
    clearCookies: vi.fn(async () => undefined),
    clearCache: vi.fn(async () => undefined),
    pictureInPicture: {
      open: mocks.openPictureInPicture,
      close: mocks.closePictureInPicture,
    },
  } as never,
}));
vi.mock(import("~/browserHistoryStore"), async (original) => ({
  ...(await original()),
  recordVisitForThread: mocks.recordVisitForThread,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readPreparedConnection: mocks.readPreparedConnection as never,
  readEnvironmentScope: mocks.readEnvironmentScope,
  useEnvironmentScope: mocks.readEnvironmentScope,
}));
vi.mock(import("~/browser/browserDefaults"), async (original) => ({
  ...(await original()),
  useBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
  getBrowserDefaults: () => STUB_BROWSER_DEFAULTS,
}));
vi.mock(import("~/previewStateStore"), async (original) => ({
  ...(await original()),
  rememberPreviewUrl: mocks.rememberPreviewUrl,
  useThreadPreviewState: (() => ({
    activeTabId: "tab-1",
    serverEpoch: mocks.serverEpoch,
    desktopByTabId: {
      "tab-1": {
        hasWebContents: true,
        canGoBack: false,
        canGoForward: false,
        loading: mocks.loading,
        zoomFactor: 1,
        pictureInPicture: mocks.pictureInPicture,
        colorScheme: "system",
        audioMuted: false,
        audible: false,
        controller: "none",
      },
    },
    recentlySeenUrls: [],
    sessions: mocks.showEmptyState
      ? {}
      : {
          "tab-1": {
            threadId: "thread-1",
            tabId: "tab-1",
            runtime: mocks.serverTab || mocks.nativeServerTab ? "server" : "desktop",
            navStatus: mocks.navStatus,
            canGoBack: false,
            canGoForward: false,
            updatedAt: "2026-07-13T00:00:00.000Z",
          },
          "tab-2": {
            threadId: "thread-1",
            tabId: "tab-2",
            runtime: mocks.serverTab || mocks.nativeServerTab ? "server" : "desktop",
            navStatus: mocks.navStatus,
            canGoBack: false,
            canGoForward: false,
            updatedAt: "2026-07-13T00:00:00.000Z",
          },
        },
  })) as never,
}));
vi.mock(import("~/state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: (() => ({ label: "WSL" })) as never,
  useEnvironmentHttpBaseUrl: () => "http://172.25.85.75:3773",
  usePrimaryEnvironmentId: () => null,
}));
vi.mock(import("~/browser/browserRecording"), async (original) => ({
  ...(await original()),
  findActiveBrowserRecordingRuntimeTabId: () => mocks.recordingRuntimeTabId,
  useActiveBrowserRecordingTabIds: () => mocks.recordingTabIds,
}));
vi.mock(import("./useDiscoveredLocalServers"), async (original) => ({
  ...(await original()),
  useDiscoveredLocalServers: () => mocks.servers,
}));
vi.mock(import("./usePreviewSession"), async (original) => ({
  ...(await original()),
  usePreviewSession: () => {},
}));

vi.mock(import("~/browser/previewRuntime"), async (original) => ({
  ...(await original()),
  useRendersServerTabNatively: () => mocks.nativeServerTab,
}));

vi.mock(import("~/state/previewStream"), async (original) => ({
  ...(await original()),
  usePreviewStreamAccess: () => mocks.streamAccess as never,
}));

vi.mock(import("@t3tools/client-runtime/preview/server-browser-stream"), async (original) => ({
  ...(await original()),
  createPreviewStreamClient: (target: { tabId: string }, handlers: PreviewStreamEvents) => {
    mocks.streamHandlers = handlers;
    mocks.streamHandlersByTabId.set(target.tabId, handlers);
    return {
      send: mocks.streamSend,
      requestKeyFrame: () => undefined,
      stop: () => undefined,
    };
  },
  createPreviewFramePainter: () => ({
    paint: () => undefined,
    reset: () => undefined,
    stop: () => undefined,
  }),
}));

vi.mock(import("~/browser/browserViewportActions"), { spy: true });

import { useComposerDraftStore } from "~/composerDraftStore";
import { useBrowserPointerStore } from "~/browser/browserPointerStore";
import { previewRuntimeTabId } from "~/browser/previewRuntimeTabId";
import { usePreviewMiniPlayerStore } from "~/previewMiniPlayerStore";
import { dispatchPreviewAction } from "./previewActionBus";
import { PreviewView } from "./PreviewView";
import { ToastProvider } from "~/components/ui/toast";

const TEST_THREAD_REF = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
} as const;
const TEST_RUNTIME_TAB_ID = previewRuntimeTabId(TEST_THREAD_REF, null, "tab-1");

function view(
  onSendAnnotation?: ComponentProps<typeof PreviewView>["onSendAnnotation"],
  tabId = "tab-1",
) {
  return (
    <PreviewView
      threadRef={TEST_THREAD_REF}
      tabId={tabId}
      visible
      {...(onSendAnnotation ? { onSendAnnotation } : {})}
    />
  );
}

function annotation(id: string, screenshot: unknown = null) {
  return {
    id,
    pageUrl: "https://example.com/dashboard",
    pageTitle: "Dashboard",
    comment: "Tighten this spacing",
    elements: [],
    regions: [],
    strokes: [],
    styleChanges: [],
    screenshot,
    createdAt: "2026-07-27T00:00:00.000Z",
  };
}

// The mocked modules and stores are shared by the whole file, so every test starts by
// resetting them.
function setup() {
  vi.clearAllMocks();
  mocks.readEnvironmentScope.mockReset().mockReturnValue(true);
  mocks.setAnnotationSendEnabled.mockReset().mockResolvedValue(undefined);
  mocks.pickElement.mockReset();
  mocks.pictureInPicture = false;
  mocks.showEmptyState = false;
  mocks.loading = false;
  mocks.nativeServerTab = false;
  mocks.serverTab = false;
  mocks.navStatus = { _tag: "Success", url: "http://example.com/", title: "Example" };
  mocks.streamHandlers = null;
  mocks.streamHandlersByTabId.clear();
  mocks.streamSend.mockReset().mockReturnValue(false);
  mocks.serverEpoch = null;
  mocks.servers = [];
  mocks.recordingTabIds = new Set();
  mocks.recordingRuntimeTabId = null;
  useComposerDraftStore.setState({
    addPreviewAnnotation: mocks.addPreviewAnnotation,
    addImage: mocks.addImage,
  });
  usePreviewMiniPlayerStore.setState({ byThreadKey: {} });
  useBrowserPointerStore.setState({ byTabId: {} });
}

async function renderServerPreview() {
  mocks.serverTab = true;
  const container = document.createElement("div");
  container.style.cssText = "width: 800px; height: 600px; display: flex;";
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await render(view(), { container }));
  await vi.waitFor(() => expect(mocks.streamHandlers).not.toBeNull());
  stack.move();
  return screen;
}

function loadingProgress(screen: { readonly container: HTMLElement }): HTMLElement {
  return screen.container.querySelector(".preview-loading-progress")!;
}

async function setStreamControl(
  controller: PreviewStreamControl["controller"],
  canOperate = true,
): Promise<void> {
  await act(() =>
    mocks.streamHandlers?.onControl?.({ canOperate, controller, generation: 1, dialog: null }),
  );
}

function tooltipText(): string | null | undefined {
  return document.querySelector('[data-slot="tooltip-popup"]')?.textContent;
}

describe("PreviewView", () => {
  it("does not spin or progress the chrome while a remote stream connects", async () => {
    setup();
    await using screen = await renderServerPreview();
    await expect.element(page.getByText("Connecting to remote browser")).toBeVisible();
    expect(loadingProgress(screen).getAttribute("data-loading")).toBe("false");
  });

  it("shows the page's own loading state independently of the stream", async () => {
    setup();
    mocks.navStatus = { _tag: "Loading", url: "http://example.com/", title: "Example" };
    await using screen = await renderServerPreview();
    await vi.waitFor(() =>
      expect(loadingProgress(screen).getAttribute("data-loading")).toBe("true"),
    );
    // Clicking reloads while loading, so the control never renames itself Stop.
    const refresh = page.getByRole("button", { name: "Refresh" });
    await expect.element(refresh).toBeVisible();
    expect(document.querySelector('button[aria-label="Stop"]')).toBeNull();
    // Disabled reason takes precedence over "Loading…" while this viewer cannot drive the stream.
    await userEvent.hover(refresh);
    await vi.waitFor(() => expect(tooltipText()).toBe("Waiting for remote browser"));
  });

  it("says why refresh is unavailable via keyboard focus and hover while this viewer cannot drive the stream", async () => {
    setup();
    await using _screen = await renderServerPreview();
    const refresh = page.getByRole("button", { name: "Refresh" });
    await expect.element(refresh).toHaveAttribute("aria-disabled", "true");
    await expect.element(refresh).toHaveAttribute("aria-description", "Waiting for remote browser");

    // Keyboard focus reveals the disabled reason tooltip and activation remains a no-op.
    await act(() => (refresh.element() as HTMLButtonElement).focus());
    await vi.waitFor(() => expect(tooltipText()).toBe("Waiting for remote browser"));
    await userEvent.keyboard("{Enter}");
    expect(mocks.streamSend).not.toHaveBeenCalled();
    await act(() => (refresh.element() as HTMLButtonElement).blur());

    await userEvent.hover(refresh);
    await vi.waitFor(() => expect(tooltipText()).toBe("Waiting for remote browser"));
    await setStreamControl("unclaimed", false);
    await expect.element(refresh).toHaveAttribute("aria-disabled", "true");
    await vi.waitFor(() => expect(tooltipText()).toBe("Read-only preview"));
    await setStreamControl("another-viewer");
    await vi.waitFor(() => expect(tooltipText()).toBe("Another viewer has control"));
    await setStreamControl("unclaimed");
    await vi.waitFor(() => expect(tooltipText()).toBe("Take control to refresh"));
    await userEvent.click(refresh, { force: true });
    expect(mocks.streamSend).not.toHaveBeenCalled();
    await setStreamControl("you");
    await expect.element(refresh).not.toHaveAttribute("aria-disabled");
    await userEvent.unhover(refresh);
    await userEvent.hover(refresh);
    await vi.waitFor(() => expect(tooltipText()).toBe("Refresh"));
  });

  it("ignores stale null control cleanup from a previous tab after the next tab gains control", async () => {
    setup();
    await using screen = await renderServerPreview();
    const tabOneHandlers = mocks.streamHandlersByTabId.get("tab-1")!;
    await setStreamControl("you");

    await screen.rerender(view(undefined, "tab-2"));
    await vi.waitFor(() => expect(mocks.streamHandlersByTabId.has("tab-2")).toBe(true));

    await act(() =>
      mocks.streamHandlersByTabId.get("tab-2")?.onControl?.({
        canOperate: true,
        controller: "you",
        generation: 1,
        dialog: null,
      }),
    );
    const refresh = page.getByRole("button", { name: "Refresh" });
    await expect.element(refresh).not.toHaveAttribute("aria-disabled");

    // Simulate a late disconnect/cleanup from tab-1 arriving after tab-2 already reported control.
    await act(() => tabOneHandlers.onConnectedChange?.(false));
    await expect.element(refresh).not.toHaveAttribute("aria-disabled");
  });

  it("does not show a waiting or take-control refresh tooltip on an idle server tab", async () => {
    setup();
    mocks.navStatus = { _tag: "Idle" };
    await using _screen = await renderServerPreview();
    const refresh = page.getByRole("button", { name: "Refresh" });
    await expect.element(refresh).toBeDisabled();
    await expect.element(refresh).not.toHaveAttribute("aria-description");

    await setStreamControl("unclaimed");
    await expect.element(refresh).toBeDisabled();
    await expect.element(refresh).not.toHaveAttribute("aria-description");
  });

  it("gates hard reload in the preview menu on stream control and sends it over the stream", async () => {
    setup();
    await using _screen = await renderServerPreview();
    const menuTrigger = page.getByRole("button", { name: "Preview menu" });

    await setStreamControl("unclaimed");
    mocks.streamSend.mockClear();
    await act(() => dispatchPreviewAction("refresh"));
    expect(mocks.streamSend).not.toHaveBeenCalled();
    await userEvent.click(menuTrigger);
    const hardReload = page.getByRole("menuitem", { name: "Hard reload" });
    await expect.element(hardReload).toHaveAttribute("aria-disabled", "true");
    await userEvent.keyboard("{Escape}");

    await setStreamControl("you");
    mocks.streamSend.mockClear();
    await userEvent.click(menuTrigger);
    await expect.element(hardReload).not.toHaveAttribute("aria-disabled");
    await userEvent.click(hardReload);
    expect(mocks.streamSend).toHaveBeenCalledWith({ type: "reload", ignoreCache: true });
  });

  it("disables hard reload in the preview menu on an idle server tab even with control", async () => {
    setup();
    mocks.navStatus = { _tag: "Idle" };
    await using _screen = await renderServerPreview();
    await setStreamControl("you");
    mocks.streamSend.mockClear();
    await act(() => dispatchPreviewAction("refresh"));
    expect(mocks.streamSend).not.toHaveBeenCalled();
    await userEvent.click(page.getByRole("button", { name: "Preview menu" }));
    await expect
      .element(page.getByRole("menuitem", { name: "Hard reload" }))
      .toHaveAttribute("aria-disabled", "true");
  });

  it.each(["mailto:alice@example.com", "http://"])(
    "reports rejected address %s without navigating or recording it",
    async (address) => {
      setup();
      await using _screen = await render(<ToastProvider timeout={0}>{view()}</ToastProvider>);
      const input = page.getByPlaceholder("Search or enter URL");
      await input.fill(address);
      await userEvent.keyboard("{Enter}");

      await expect.element(page.getByText("Could not open this address")).toBeVisible();
      await expect.element(page.getByText("Enter an http or https URL.")).toBeVisible();
      expect(mocks.navigate).not.toHaveBeenCalled();
      expect(mocks.recordVisitForThread).not.toHaveBeenCalled();
      await userEvent.click(page.getByRole("button", { name: "Dismiss notification" }));
    },
  );

  it("retains the annotation locally when its own environment loses access during capture", async () => {
    setup();
    const picked = annotation("annotation-revoked");
    const onSendAnnotation = vi.fn();
    let submitPick: (() => void) | undefined;
    mocks.pickElement.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          submitPick = () => resolve({ annotation: picked, submission: "send" });
        }),
    );
    await using screen = await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(submitPick).toBeDefined());
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, true);

    mocks.readEnvironmentScope.mockImplementation(
      (environmentId?: unknown) => environmentId !== TEST_THREAD_REF.environmentId,
    );
    await screen.rerender(view(onSendAnnotation));
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, false);
    await act(async () => submitPick!());
    await vi.waitFor(() =>
      expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, picked),
    );
    expect(onSendAnnotation).not.toHaveBeenCalled();

    mocks.readEnvironmentScope.mockReturnValue(true);
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await screen.rerender(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));
    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(picked, null));
    expect(mocks.setAnnotationSendEnabled).toHaveBeenLastCalledWith(TEST_RUNTIME_TAB_ID, true);
  });

  it("still sends annotation text when the picked element's crop is malformed", async () => {
    setup();
    const picked = annotation("annotation-2", {
      dataUrl: "data:image/png;base64,%%%",
      width: 10,
      height: 10,
      cropRect: { x: 0, y: 0, width: 10, height: 10 },
    });
    const onSendAnnotation = vi.fn();
    mocks.pickElement.mockResolvedValue({ annotation: picked, submission: "send" });
    await using _screen = await render(view(onSendAnnotation));
    await userEvent.click(page.getByRole("button", { name: "Annotate preview" }));

    const sent = { ...picked, screenshot: null };
    await vi.waitFor(() => expect(onSendAnnotation).toHaveBeenCalledWith(sent, null));
    expect(mocks.addPreviewAnnotation).toHaveBeenCalledWith(TEST_THREAD_REF, sent);
    expect(mocks.addImage).not.toHaveBeenCalled();
  });

  it("focuses and selects the address from forwarded desktop actions only while visible", async () => {
    setup();
    using stack = new DisposableStack();
    const previousBridge = window.desktopBridge;
    stack.defer(() => {
      if (previousBridge) window.desktopBridge = previousBridge;
      else delete window.desktopBridge;
    });
    const listeners = new Set<(action: string) => void>();
    window.desktopBridge = {
      getWindowZoomFactor: () => 1,
      onMenuAction: (listener: (action: string) => void) => {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    } as NonNullable<typeof window.desktopBridge>;
    await using screen = await render(view());
    const address = page.getByRole("textbox");
    const input = address.element() as HTMLInputElement;
    const forward = () =>
      act(() => {
        listeners.forEach((listener) => listener("preview.focusUrl"));
      });

    await forward();
    await expect.element(address).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(input.value.length);
    await act(() => input.blur());
    await forward();
    await expect.element(address).toHaveFocus();

    await act(() => input.blur());
    await screen.rerender(
      <PreviewView threadRef={TEST_THREAD_REF} tabId="tab-1" visible={false} />,
    );
    await forward();
    await expect.element(address).not.toHaveFocus();
    expect(listeners.size).toBe(0);
  });

  it("focuses the address bar each time the focus-url shortcut fires", async () => {
    setup();
    await using _screen = await render(view());
    const address = page.getByRole("textbox");

    act(() => dispatchPreviewAction("focus-url"));
    await expect.element(address).toHaveFocus();

    (address.element() as HTMLInputElement).blur();
    await expect.element(address).not.toHaveFocus();
    act(() => dispatchPreviewAction("focus-url"));
    await expect.element(address).toHaveFocus();
  });
});
