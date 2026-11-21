import type { PreviewStreamPhase } from "@t3tools/client-runtime/preview/server-browser-stream";
import type { EnvironmentId } from "@t3tools/contracts";
import { act, useEffect, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vite-plus/test";

type ViewProps = {
  readonly children?: ReactNode;
  readonly testID?: string;
  readonly accessibilityElementsHidden?: boolean;
  readonly importantForAccessibility?: string;
};

type TextProps = {
  readonly children?: ReactNode;
  readonly accessibilityLiveRegion?: string;
};

const IS_ANDROID = process.env.T3_MOBILE_TEST_PLATFORM === "android";

const mocks = vi.hoisted(() => ({
  onMessage: null as ((event: { nativeEvent: { data: string } }) => void) | null,
  onProcessTerminated: null as (() => void) | null,
  lastSourceHtml: "",
  injected: [] as string[],
  webViewMounts: 0,
  announce: vi.fn(),
  announceWithOptions: vi.fn(),
  getClipboard: vi.fn<() => Promise<string>>(async () => ""),
  accessState: {
    access: {
      httpBase: "https://environment.test/api/preview",
      wsBase: "wss://environment.test/api/preview",
      credentials: false,
      query: {},
    } as {
      httpBase: string;
      wsBase: string;
      credentials: boolean;
      query: Record<string, string>;
    } | null,
    error: null as string | null,
    isPending: false,
    refresh: vi.fn(),
    retryAfter: vi.fn(),
  },
}));

vi.mock("react-native", () => ({
  AccessibilityInfo: {
    announceForAccessibility: mocks.announce,
    announceForAccessibilityWithOptions: mocks.announceWithOptions,
  },
  Platform: { OS: process.env.T3_MOBILE_TEST_PLATFORM === "android" ? "android" : "ios" },
  View: ({
    children,
    testID,
    accessibilityElementsHidden,
    importantForAccessibility,
  }: ViewProps) => (
    <div
      data-testid={testID}
      data-a11y-hidden={accessibilityElementsHidden ? "true" : undefined}
      data-a11y-important={importantForAccessibility}
    >
      {children}
    </div>
  ),
  Pressable: ({ children, onPress }: ViewProps & { readonly onPress?: () => void }) => (
    <button type="button" onClick={onPress}>
      {children}
    </button>
  ),
  TextInput: () => <input />,
}));

vi.mock("react-native-webview", () => ({
  WebView: ({
    ref,
    source,
    onMessage,
    onContentProcessDidTerminate,
  }: {
    readonly ref?: { current: { injectJavaScript: (script: string) => void } | null };
    readonly source?: { readonly html?: string };
    readonly onMessage?: (event: { nativeEvent: { data: string } }) => void;
    readonly onContentProcessDidTerminate?: () => void;
  }) => {
    useEffect(() => {
      mocks.webViewMounts += 1;
    }, []);
    mocks.onMessage = onMessage ?? null;
    mocks.onProcessTerminated = onContentProcessDidTerminate ?? null;
    mocks.lastSourceHtml = source?.html ?? "";
    if (ref) {
      ref.current = {
        injectJavaScript: (script: string) => {
          mocks.injected.push(script);
        },
      };
    }
    return <div data-testid="webview" />;
  },
}));

vi.mock("@t3tools/mobile-preview-stream", () => ({ default: "" }));
vi.mock("expo-clipboard", () => ({
  getStringAsync: () => mocks.getClipboard(),
  setStringAsync: vi.fn(async () => undefined),
}));
vi.mock("../../components/ui/AppText", () => ({
  AppText: ({ children, accessibilityLiveRegion }: TextProps) => (
    <span data-live-region={accessibilityLiveRegion}>{children}</span>
  ),
}));
vi.mock("../../components/ui/Button", () => ({
  Button: ({
    label,
    disabled,
    loading,
    onPress,
  }: {
    readonly label: string;
    readonly disabled?: boolean;
    readonly loading?: boolean;
    readonly onPress?: () => void;
  }) => (
    <button
      type="button"
      disabled={Boolean(disabled || loading)}
      data-loading={loading ? "true" : undefined}
      onClick={onPress}
    >
      {label}
    </button>
  ),
}));
vi.mock("../../components/ui/AppActivityIndicator", () => ({
  AppActivityIndicator: () => <span data-testid="spinner" />,
}));
vi.mock("../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../components/PdfPreview", () => ({ PdfPreview: () => <div data-testid="pdf" /> }));
vi.mock("../../lib/attachmentDownload", () => ({ downloadAndShareAttachment: vi.fn() }));
vi.mock("../../lib/foreground-handoff", () => ({ beginForegroundHandoff: () => () => {} }));
vi.mock("../connection/ConnectionStatusDot", () => ({
  ConnectionStatusDot: ({ state }: { readonly state: string }) => <span data-dot={state} />,
}));
vi.mock("../../state/preview", () => ({
  usePreviewStreamAccess: () => mocks.accessState,
}));

import { PreviewStreamWebView, type PreviewStreamRef } from "./PreviewStreamWebView";

function emit(payload: object) {
  mocks.onMessage?.({ nativeEvent: { data: JSON.stringify(payload) } });
}

function mountView(
  props: {
    readonly compact?: boolean;
    readonly paused?: boolean;
    readonly onStreamingChange?: (streaming: boolean) => void;
    readonly onPhaseChange?: (phase: PreviewStreamPhase) => void;
    readonly onErrorChange?: (failed: boolean) => void;
    readonly access?: typeof mocks.accessState.access;
    readonly accessError?: string | null;
  } = {},
) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  mocks.onMessage = null;
  mocks.onProcessTerminated = null;
  mocks.lastSourceHtml = "";
  mocks.injected.length = 0;
  mocks.webViewMounts = 0;
  mocks.announce.mockReset();
  mocks.announceWithOptions.mockReset();
  mocks.getClipboard.mockReset().mockResolvedValue("");
  mocks.accessState = {
    access:
      props.access !== undefined
        ? props.access
        : {
            httpBase: "https://environment.test/api/preview",
            wsBase: "wss://environment.test/api/preview",
            credentials: false,
            query: {},
          },
    error: props.accessError ?? null,
    isPending: false,
    refresh: vi.fn(),
    retryAfter: vi.fn(),
  };
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const streamRef: { current: PreviewStreamRef | null } = { current: null };
  let paused = props.paused;
  const renderElement = () => (
    <PreviewStreamWebView
      ref={streamRef}
      environmentId={"env-1" as EnvironmentId}
      threadId="thread-1"
      tabId="tab-1"
      interactive={!props.compact}
      background="#000"
      environmentLabel="build-box"
      compact={props.compact}
      paused={paused}
      onStreamingChange={props.onStreamingChange}
      onPhaseChange={props.onPhaseChange}
      onErrorChange={props.onErrorChange}
    />
  );
  act(() => {
    root.render(renderElement());
  });
  return {
    container,
    streamRef,
    rerender(next?: { readonly paused?: boolean }) {
      if (next && "paused" in next) paused = next.paused;
      act(() => {
        root.render(renderElement());
      });
    },
    cleanup() {
      act(() => root.unmount());
      container.remove();
      vi.unstubAllGlobals();
    },
  };
}

const POLITE_IOS_ANNOUNCEMENT = { queue: true, priority: "low" };

it("announces phase transitions through one live region, suppresses duplicate badges, and hides the status row on error", () => {
  const { container, cleanup } = mountView();
  try {
    const liveRegions = () => [...container.querySelectorAll('[data-live-region="polite"]')];
    expect(liveRegions().map((el) => el.textContent)).toEqual(["Connecting to remote stream…"]);
    const hiddenConnecting = container.querySelector('[data-a11y-hidden="true"]');
    expect(hiddenConnecting?.textContent).toContain("Connecting to remote browser");
    expect(hiddenConnecting?.textContent).toContain("Starting video stream from build-box…");
    expect(mocks.announce).not.toHaveBeenCalled();
    expect(mocks.announceWithOptions).not.toHaveBeenCalled();

    act(() =>
      emit({
        type: "control",
        canOperate: true,
        controller: "unclaimed",
        generation: 1,
        dialog: null,
      }),
    );
    expect(liveRegions().map((el) => el.textContent)).toEqual([
      "Waiting for video frame · Watching",
    ]);
    expect(container.textContent).toContain("Waiting for first frame…");
    expect(container.querySelector("button")?.textContent).toBe("Take control");

    act(() => emit({ type: "status", status: "streaming" }));
    expect(liveRegions().map((el) => el.textContent)).toEqual(["Watching"]);
    expect(container.querySelector("button")?.textContent).toBe("Take control");

    act(() => emit({ type: "status", status: "connecting" }));
    expect(liveRegions().map((el) => el.textContent)).toEqual(["Reconnecting stream…"]);
    const hiddenPill = container.querySelector('[data-a11y-hidden="true"]');
    expect(hiddenPill?.textContent).toContain("Reconnecting to remote browser…");
    expect(container.querySelector("button")).toBeNull();

    // Another viewer holding control before the replacement frame paints names the controller alongside the disabled Take control button.
    act(() =>
      emit({
        type: "control",
        canOperate: true,
        controller: "another-viewer",
        generation: 2,
        dialog: null,
      }),
    );
    expect(liveRegions().map((el) => el.textContent)).toEqual([
      "Reconnecting stream · Another viewer has control",
    ]);
    expect(container.querySelector("button")?.disabled).toBe(true);

    act(() => emit({ type: "status", status: "error", detail: "Stream failed." }));
    expect(liveRegions().map((el) => el.textContent)).toEqual(["Stream failed."]);
    expect(container.querySelector('[data-testid="stream-error-banner"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="stream-error-overlay"]')).toBeNull();
    expect(container.querySelector('[data-a11y-hidden="true"]')).toBeNull();
    expect(container.querySelector("button")?.textContent).toBe("Reconnect");
    expect(container.textContent).not.toContain("Reconnecting to remote browser…");
    expect(mocks.announce).not.toHaveBeenCalled();
    if (IS_ANDROID) {
      expect(mocks.announceWithOptions).not.toHaveBeenCalled();
    } else {
      expect(mocks.announceWithOptions.mock.calls).toEqual([
        ["Waiting for video frame · Watching", POLITE_IOS_ANNOUNCEMENT],
        ["Watching", POLITE_IOS_ANNOUNCEMENT],
        ["Reconnecting stream…", POLITE_IOS_ANNOUNCEMENT],
        ["Reconnecting stream · Another viewer has control", POLITE_IOS_ANNOUNCEMENT],
        ["Stream failed.", POLITE_IOS_ANNOUNCEMENT],
      ]);
    }
  } finally {
    cleanup();
  }
});

it("keeps Take control available during awaiting-frame with or without a pending dialog and announces newly opened dialogs once", () => {
  const { container, cleanup } = mountView();
  try {
    act(() =>
      emit({
        type: "control",
        canOperate: true,
        controller: "unclaimed",
        generation: 1,
        dialog: null,
      }),
    );
    expect(container.textContent).toContain("Waiting for video frame · Watching");
    const buttonWithoutDialog = container.querySelector("button");
    expect(buttonWithoutDialog?.textContent).toBe("Take control");
    act(() => buttonWithoutDialog?.click());
    expect(mocks.injected.some((script) => script.includes('"takeControl"'))).toBe(true);

    mocks.injected.length = 0;
    mocks.announceWithOptions.mockClear();
    act(() =>
      emit({
        type: "control",
        canOperate: true,
        controller: "unclaimed",
        generation: 2,
        dialog: { type: "alert", message: "Confirm action", defaultValue: "" },
      }),
    );
    expect(container.textContent).toContain("Waiting for video frame · Watching");
    expect(container.textContent).toContain("Confirm action");
    const liveTexts = [...container.querySelectorAll('[data-live-region="polite"]')].map(
      (el) => el.textContent,
    );
    expect(liveTexts).toContain("Confirm action");
    expect(mocks.announce).not.toHaveBeenCalled();
    if (IS_ANDROID) {
      expect(mocks.announceWithOptions).not.toHaveBeenCalled();
    } else {
      expect(mocks.announceWithOptions.mock.calls).toEqual([
        ["Browser dialog: Confirm action", POLITE_IOS_ANNOUNCEMENT],
      ]);
    }
    const button = container.querySelector("button");
    expect(button?.textContent).toBe("Take control");
    act(() => button?.click());
    expect(mocks.injected.some((script) => script.includes('"takeControl"'))).toBe(true);

    // Gaining control for the same dialog announces the new ownership status without re-announcing the dialog.
    act(() =>
      emit({
        type: "control",
        canOperate: true,
        controller: "you",
        generation: 3,
        dialog: { type: "alert", message: "Confirm action", defaultValue: "" },
      }),
    );
    if (!IS_ANDROID) {
      expect(mocks.announceWithOptions.mock.calls).toEqual([
        ["Browser dialog: Confirm action", POLITE_IOS_ANNOUNCEMENT],
        ["Waiting for video frame · You have control", POLITE_IOS_ANNOUNCEMENT],
      ]);
    }

    // Empty-message dialogs announce a non-empty fallback on both Android and iOS.
    mocks.announceWithOptions.mockClear();
    act(() =>
      emit({
        type: "control",
        canOperate: true,
        controller: "you",
        generation: 4,
        dialog: { type: "alert", message: "   ", defaultValue: "" },
      }),
    );
    const emptyDialogLiveTexts = [...container.querySelectorAll('[data-live-region="polite"]')].map(
      (el) => el.textContent,
    );
    expect(emptyDialogLiveTexts).toContain("Browser dialog opened.");
    expect(mocks.announce).not.toHaveBeenCalled();
    if (IS_ANDROID) {
      expect(mocks.announceWithOptions).not.toHaveBeenCalled();
    } else {
      expect(mocks.announceWithOptions.mock.calls).toEqual([
        ["Browser dialog opened.", POLITE_IOS_ANNOUNCEMENT],
      ]);
    }
  } finally {
    cleanup();
  }
});

it("shows compact reconnect and terminal error badges while reporting error state to floating previews", () => {
  const streamingChanges: boolean[] = [];
  const errorChanges: boolean[] = [];
  const { container, cleanup } = mountView({
    compact: true,
    onStreamingChange: (streaming) => streamingChanges.push(streaming),
    onErrorChange: (failed) => errorChanges.push(failed),
  });
  try {
    expect(errorChanges).toEqual([false]);
    expect(container.querySelector('[data-testid="spinner"]')).not.toBeNull();

    act(() => {
      emit({
        type: "control",
        canOperate: false,
        controller: "unclaimed",
        generation: 1,
        dialog: null,
      });
      emit({ type: "status", status: "streaming" });
    });
    expect(streamingChanges).toEqual([true]);
    expect(container.querySelector('[data-testid="spinner"]')).toBeNull();
    expect(container.textContent).not.toContain("Reconnecting…");

    act(() => emit({ type: "status", status: "connecting" }));
    expect(streamingChanges).toEqual([true, false]);
    expect(container.querySelector('[data-testid="spinner"]')).toBeNull();
    expect(container.textContent).toContain("Reconnecting…");

    act(() => emit({ type: "status", status: "error", detail: "Stream failed." }));
    expect(errorChanges).toEqual([false, true]);
    expect(container.querySelector('[data-testid="spinner"]')).toBeNull();
    expect(container.textContent).not.toContain("Reconnecting…");
    expect(container.textContent).toContain("Unavailable");
    expect(container.querySelector('[data-dot="error"]')).not.toBeNull();
    expect(mocks.announce).not.toHaveBeenCalled();
    expect(mocks.announceWithOptions).not.toHaveBeenCalled();
  } finally {
    cleanup();
  }
});

it("reports terminal access errors without spinning in compact mode", () => {
  const errorChanges: boolean[] = [];
  const { container, cleanup } = mountView({
    compact: true,
    access: null,
    accessError: "Could not authorize browser stream.",
    onErrorChange: (failed) => errorChanges.push(failed),
  });
  try {
    expect(errorChanges).toEqual([true]);
    expect(container.querySelector('[data-testid="spinner"]')).toBeNull();
    expect(container.textContent).toContain("Unavailable");
    expect(container.querySelector('[data-dot="error"]')).not.toBeNull();
    expect(mocks.announce).not.toHaveBeenCalled();
    expect(mocks.announceWithOptions).not.toHaveBeenCalled();
  } finally {
    cleanup();
  }
});

it("announces initial fallback access errors via live region and VoiceOver", () => {
  const { container, rerender, cleanup } = mountView({
    access: null,
    accessError: null,
  });
  try {
    expect(container.querySelector('[data-live-region="polite"]')).toBeNull();
    expect(mocks.announce).not.toHaveBeenCalled();
    expect(mocks.announceWithOptions).not.toHaveBeenCalled();

    mocks.accessState = {
      ...mocks.accessState,
      error: "Could not authorize browser stream.",
    };
    rerender();

    expect(container.querySelector('[data-live-region="polite"]')?.textContent).toBe(
      "Could not authorize browser stream.",
    );
    expect(mocks.announce).not.toHaveBeenCalled();
    if (IS_ANDROID) {
      expect(mocks.announceWithOptions).not.toHaveBeenCalled();
    } else {
      expect(mocks.announceWithOptions).toHaveBeenCalledTimes(1);
      expect(mocks.announceWithOptions).toHaveBeenCalledWith(
        "Could not authorize browser stream.",
        POLITE_IOS_ANNOUNCEMENT,
      );
    }
  } finally {
    cleanup();
  }
});

it("refreshes stream access in place after mid-session unauthorized refusal and ignores stale messages from the replaced generation", () => {
  const streamingChanges: boolean[] = [];
  const { container, rerender, cleanup } = mountView({
    onStreamingChange: (streaming) => streamingChanges.push(streaming),
  });
  try {
    expect(mocks.webViewMounts).toBe(1);
    const liveRegions = () => [...container.querySelectorAll('[data-live-region="polite"]')];

    act(() => {
      emit({ type: "status", status: "connecting", accessGeneration: 0 });
      emit({
        type: "control",
        canOperate: true,
        controller: "unclaimed",
        generation: 1,
        dialog: null,
        accessGeneration: 0,
      });
      emit({ type: "status", status: "streaming", accessGeneration: 0 });
    });
    expect(liveRegions().map((el) => el.textContent)).toEqual(["Watching"]);

    act(() => {
      emit({ type: "unauthorized", accessGeneration: 0 });
    });
    expect(mocks.accessState.retryAfter).toHaveBeenCalledWith(0);

    // Selecting replacement access clears live control/streaming immediately and advances generation.
    mocks.accessState = {
      ...mocks.accessState,
      access: {
        httpBase: "https://environment.test/api/preview",
        wsBase: "wss://environment.test/api/preview",
        credentials: false,
        query: { wsTicket: "fresh-ticket" },
      },
    };
    rerender();

    expect(mocks.webViewMounts).toBe(1);
    expect(streamingChanges.at(-1)).toBe(false);
    expect(container.querySelector("button")).toBeNull();
    expect(
      mocks.injected.some(
        (script) =>
          script.includes("window.T3PreviewStream?.updateAccess(") &&
          script.includes('"fresh-ticket"') &&
          script.includes(", 1)"),
      ),
    ).toBe(true);
    expect(liveRegions().map((el) => el.textContent)).toEqual(["Reconnecting stream…"]);
    expect(container.textContent).not.toContain("Connecting to remote browser");

    // Queued messages from the replaced generation (0) must not restore controls, mark streaming, or count refusals.
    mocks.accessState.retryAfter.mockClear();
    act(() => {
      emit({
        type: "control",
        canOperate: true,
        controller: "you",
        generation: 1,
        dialog: null,
        accessGeneration: 0,
      });
      emit({ type: "status", status: "streaming", accessGeneration: 0 });
      emit({ type: "unauthorized", accessGeneration: 0 });
      emit({ type: "unauthorized", accessGeneration: 0 });
    });
    expect(mocks.accessState.retryAfter).not.toHaveBeenCalled();
    expect(container.querySelector("button")).toBeNull();
    expect(container.querySelector('[data-testid="stream-error-banner"]')).toBeNull();
    expect(liveRegions().map((el) => el.textContent)).toEqual(["Reconnecting stream…"]);

    // Messages tagged with the new generation (1) restore controls and streaming.
    act(() => {
      emit({
        type: "control",
        canOperate: true,
        controller: "unclaimed",
        generation: 2,
        dialog: null,
        accessGeneration: 1,
      });
      emit({ type: "status", status: "streaming", accessGeneration: 1 });
    });
    expect(liveRegions().map((el) => el.textContent)).toEqual(["Watching"]);
    expect(container.querySelector("button")?.textContent).toBe("Take control");
  } finally {
    cleanup();
  }
});

it("keeps the WebView mounted across a mid-session access failure and recovers in place", () => {
  const streamingChanges: boolean[] = [];
  const errorChanges: boolean[] = [];
  const { container, rerender, cleanup } = mountView({
    onStreamingChange: (streaming) => streamingChanges.push(streaming),
    onErrorChange: (failed) => errorChanges.push(failed),
  });
  try {
    expect(mocks.webViewMounts).toBe(1);
    const liveRegions = () => [...container.querySelectorAll('[data-live-region="polite"]')];

    act(() => {
      emit({ type: "status", status: "connecting", accessGeneration: 0 });
      emit({
        type: "control",
        canOperate: true,
        controller: "unclaimed",
        generation: 1,
        dialog: null,
        accessGeneration: 0,
      });
      emit({ type: "status", status: "streaming", accessGeneration: 0 });
    });
    expect(liveRegions().map((el) => el.textContent)).toEqual(["Watching"]);
    mocks.injected.length = 0;
    mocks.announce.mockClear();
    mocks.announceWithOptions.mockClear();

    // Mid-session access failure suspends transport without unmounting the WebView.
    mocks.accessState = {
      ...mocks.accessState,
      access: null,
      error: "Could not authorize browser stream.",
    };
    rerender();

    expect(mocks.webViewMounts).toBe(1);
    expect(mocks.injected).toContain("window.T3PreviewStream?.updateAccess(null, 1); true;");
    expect(streamingChanges.at(-1)).toBe(false);
    expect(errorChanges).toEqual([false, true]);
    expect(container.querySelector('[data-testid="stream-error-banner"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="stream-error-overlay"]')).toBeNull();
    expect(liveRegions().map((el) => el.textContent)).toEqual([
      "Could not authorize browser stream.",
    ]);
    expect(mocks.announce).not.toHaveBeenCalled();
    if (IS_ANDROID) {
      expect(mocks.announceWithOptions).not.toHaveBeenCalled();
    } else {
      expect(mocks.announceWithOptions).toHaveBeenCalledWith(
        "Could not authorize browser stream.",
        POLITE_IOS_ANNOUNCEMENT,
      );
    }

    // Stale in-flight unauthorized or fileChooser messages while access is null must not fail or trigger retries.
    act(() => {
      emit({ type: "unauthorized", accessGeneration: 0 });
      emit({ type: "unauthorized", accessGeneration: 1 });
      emit({ type: "unauthorized", accessGeneration: 1 });
      emit({
        type: "fileChooser",
        chooser: {
          multiple: false,
          accept: "*/*",
          uploadUrl: "https://example.test",
          credentials: false,
        },
        accessGeneration: 1,
      });
    });
    expect(mocks.accessState.retryAfter).not.toHaveBeenCalled();
    expect(container.querySelector('[data-testid="stream-error-banner"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="stream-error-overlay"]')).toBeNull();

    const retryButton = container.querySelector("button");
    expect(retryButton?.textContent).toBe("Retry");
    act(() => retryButton?.click());
    expect(mocks.accessState.refresh).toHaveBeenCalledOnce();

    // Access recovery resumes in place with the retained frame and reconnecting state.
    mocks.accessState = {
      ...mocks.accessState,
      access: {
        httpBase: "https://environment.test/api/preview",
        wsBase: "wss://environment.test/api/preview",
        credentials: false,
        query: { wsTicket: "recovered-ticket" },
      },
      error: null,
    };
    rerender();

    expect(mocks.webViewMounts).toBe(1);
    expect(errorChanges).toEqual([false, true, false]);
    expect(
      mocks.injected.some(
        (script) =>
          script.includes("window.T3PreviewStream?.updateAccess(") &&
          script.includes('"recovered-ticket"') &&
          script.includes(", 2)"),
      ),
    ).toBe(true);
    expect(liveRegions().map((el) => el.textContent)).toEqual(["Reconnecting stream…"]);
    expect(container.textContent).not.toContain("Connecting to remote browser");
    expect(mocks.announce).not.toHaveBeenCalled();
    if (IS_ANDROID) {
      expect(mocks.announceWithOptions).not.toHaveBeenCalled();
    } else {
      expect(mocks.announceWithOptions).toHaveBeenCalledWith(
        "Reconnecting stream…",
        POLITE_IOS_ANNOUNCEMENT,
      );
    }

    act(() => {
      emit({
        type: "control",
        canOperate: true,
        controller: "unclaimed",
        generation: 2,
        dialog: null,
        accessGeneration: 2,
      });
      emit({ type: "status", status: "streaming", accessGeneration: 2 });
    });
    expect(liveRegions().map((el) => el.textContent)).toEqual(["Watching"]);
    expect(mocks.announce).not.toHaveBeenCalled();
    if (IS_ANDROID) {
      expect(mocks.announceWithOptions).not.toHaveBeenCalled();
    } else {
      expect(mocks.announceWithOptions).toHaveBeenLastCalledWith(
        "Watching",
        POLITE_IOS_ANNOUNCEMENT,
      );
    }
  } finally {
    cleanup();
  }
});

it("retries exhausted mid-session authorization in place over a banner without remounting the WebView", () => {
  const { container, rerender, cleanup } = mountView();
  try {
    expect(mocks.webViewMounts).toBe(1);
    const liveRegions = () => [...container.querySelectorAll('[data-live-region="polite"]')];

    act(() => {
      emit({ type: "status", status: "connecting", accessGeneration: 0 });
      emit({
        type: "control",
        canOperate: true,
        controller: "unclaimed",
        generation: 1,
        dialog: null,
        accessGeneration: 0,
      });
      emit({ type: "status", status: "streaming", accessGeneration: 0 });
    });
    mocks.injected.length = 0;

    act(() => {
      emit({ type: "status", status: "connecting", accessGeneration: 0 });
      emit({ type: "unauthorized", accessGeneration: 0 });
      emit({ type: "unauthorized", accessGeneration: 0 });
      emit({ type: "unauthorized", accessGeneration: 0 });
    });

    expect(mocks.webViewMounts).toBe(1);
    expect(mocks.injected).toContain("window.T3PreviewStream?.updateAccess(null, 1); true;");
    expect(container.querySelector('[data-testid="stream-error-banner"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="stream-error-overlay"]')).toBeNull();
    expect(liveRegions().map((el) => el.textContent)).toEqual([
      "This session can't open the browser stream. Reconnect to try again.",
    ]);

    const reconnectButton = container.querySelector("button");
    expect(reconnectButton?.textContent).toBe("Reconnect");
    act(() => reconnectButton?.click());
    expect(mocks.accessState.refresh).toHaveBeenCalledOnce();
    expect(mocks.webViewMounts).toBe(1);

    // While the refresh is in flight, the banner button reflects pending loading state.
    mocks.accessState = { ...mocks.accessState, isPending: true };
    rerender();
    expect(container.querySelector("button")?.disabled).toBe(true);
    expect(container.querySelector("button")?.getAttribute("data-loading")).toBe("true");

    mocks.accessState = {
      ...mocks.accessState,
      access: {
        httpBase: "https://environment.test/api/preview",
        wsBase: "wss://environment.test/api/preview",
        credentials: false,
        query: { wsTicket: "reconnected-ticket" },
      },
      error: null,
      isPending: false,
    };
    rerender();

    expect(mocks.webViewMounts).toBe(1);
    expect(
      mocks.injected.some(
        (script) =>
          script.includes("window.T3PreviewStream?.updateAccess(") &&
          script.includes('"reconnected-ticket"') &&
          script.includes(", 2)"),
      ),
    ).toBe(true);
    expect(liveRegions().map((el) => el.textContent)).toEqual(["Reconnecting stream…"]);
    expect(container.textContent).not.toContain("Connecting to remote browser");

    act(() => {
      emit({
        type: "control",
        canOperate: true,
        controller: "unclaimed",
        generation: 2,
        dialog: null,
        accessGeneration: 2,
      });
      emit({ type: "status", status: "streaming", accessGeneration: 2 });
    });
    expect(liveRegions().map((el) => el.textContent)).toEqual(["Watching"]);
  } finally {
    cleanup();
  }
});

it("reports connecting rather than reconnecting through onPhaseChange when paused discards the canvas", () => {
  const phases: PreviewStreamPhase[] = [];
  const { rerender, cleanup } = mountView({
    compact: true,
    onPhaseChange: (phase) => phases.push(phase),
  });
  try {
    expect(phases).toEqual(["connecting"]);

    act(() => {
      emit({
        type: "control",
        canOperate: false,
        controller: "unclaimed",
        generation: 1,
        dialog: null,
      });
      emit({ type: "status", status: "streaming" });
    });
    expect(phases.at(-1)).toBe("live");

    // Socket drop with retained canvas transitions to reconnecting.
    act(() => emit({ type: "status", status: "connecting" }));
    expect(phases.at(-1)).toBe("reconnecting");

    act(() => {
      emit({
        type: "control",
        canOperate: false,
        controller: "unclaimed",
        generation: 2,
        dialog: null,
      });
      emit({ type: "status", status: "streaming" });
    });
    expect(phases.at(-1)).toBe("live");

    // Pausing unmounts the WebView and discards the canvas, resetting phase to connecting.
    rerender({ paused: true });
    expect(phases.at(-1)).toBe("connecting");
    expect(mocks.webViewMounts).toBe(1);

    // Resuming mounts a fresh WebView in connecting, never reconnecting.
    rerender({ paused: false });
    expect(mocks.webViewMounts).toBe(2);
    expect(phases.at(-1)).toBe("connecting");
  } finally {
    cleanup();
  }
});

it("cancels pending deferred clipboard pastes across disconnect, access replacement, and loss of control", async () => {
  const { streamRef, rerender, cleanup } = mountView();
  try {
    act(() => {
      emit({
        type: "control",
        canOperate: true,
        controller: "you",
        generation: 1,
        dialog: null,
        inputSession: 1,
      });
      emit({ type: "status", status: "streaming" });
    });

    // 1) Disconnect + reconnect + regain control before clipboard resolves must drop the old paste.
    let resolveDisconnectPaste!: (text: string) => void;
    mocks.getClipboard.mockImplementationOnce(
      () => new Promise<string>((resolve) => (resolveDisconnectPaste = resolve)),
    );
    act(() => streamRef.current?.paste());
    act(() => {
      emit({ type: "status", status: "connecting" });
      emit({
        type: "control",
        canOperate: true,
        controller: "you",
        generation: 2,
        dialog: null,
        inputSession: 2,
      });
      emit({ type: "status", status: "streaming" });
    });
    mocks.injected.length = 0;
    await act(async () => {
      resolveDisconnectPaste("stale-after-reconnect");
      await Promise.resolve();
    });
    expect(mocks.injected.some((script) => script.includes("stale-after-reconnect"))).toBe(false);

    // 2) Loss of control + regaining control before clipboard resolves must drop the old paste.
    let resolveControlPaste!: (text: string) => void;
    mocks.getClipboard.mockImplementationOnce(
      () => new Promise<string>((resolve) => (resolveControlPaste = resolve)),
    );
    act(() => streamRef.current?.paste());
    act(() => {
      emit({
        type: "control",
        canOperate: true,
        controller: "another-viewer",
        generation: 3,
        dialog: null,
        inputSession: 3,
      });
      emit({
        type: "control",
        canOperate: true,
        controller: "you",
        generation: 4,
        dialog: null,
        inputSession: 4,
      });
    });
    mocks.injected.length = 0;
    await act(async () => {
      resolveControlPaste("stale-after-control-loss");
      await Promise.resolve();
    });
    expect(mocks.injected.some((script) => script.includes("stale-after-control-loss"))).toBe(
      false,
    );

    // 3) Access replacement before clipboard resolves must drop the old paste.
    let resolveAccessPaste!: (text: string) => void;
    mocks.getClipboard.mockImplementationOnce(
      () => new Promise<string>((resolve) => (resolveAccessPaste = resolve)),
    );
    act(() => streamRef.current?.paste());
    mocks.accessState = {
      ...mocks.accessState,
      access: {
        httpBase: "https://environment.test/api/preview",
        wsBase: "wss://environment.test/api/preview",
        credentials: false,
        query: { wsTicket: "replacement-ticket" },
      },
    };
    rerender();
    act(() => {
      emit({
        type: "control",
        canOperate: true,
        controller: "you",
        generation: 5,
        dialog: null,
        inputSession: 5,
        accessGeneration: 1,
      });
      emit({ type: "status", status: "streaming", accessGeneration: 1 });
    });
    mocks.injected.length = 0;
    await act(async () => {
      resolveAccessPaste("stale-after-access-refresh");
      await Promise.resolve();
    });
    expect(mocks.injected.some((script) => script.includes("stale-after-access-refresh"))).toBe(
      false,
    );

    // 4) A paste within the active session forwards the current inputSession token to the WebView.
    mocks.getClipboard.mockResolvedValueOnce("fresh-paste");
    await act(async () => {
      streamRef.current?.paste();
      await Promise.resolve();
    });
    expect(mocks.injected).toContain(
      'window.T3PreviewStream?.command({"type":"text","text":"fresh-paste"}, 5); true;',
    );

    // 5) A queued paste firing after a disconnect message clears the ref but before React commits must not read the clipboard.
    mocks.getClipboard.mockClear();
    mocks.injected.length = 0;
    await act(async () => {
      emit({ type: "status", status: "connecting", accessGeneration: 1 });
      streamRef.current?.paste();
      await Promise.resolve();
    });
    expect(mocks.getClipboard).not.toHaveBeenCalled();
    expect(mocks.injected).toEqual([]);
  } finally {
    cleanup();
  }
});

it("boots with null access instead of stale initial credentials if the WebView remounts during an outage", () => {
  const { rerender, cleanup } = mountView({
    access: {
      httpBase: "https://environment.test/api/preview",
      wsBase: "wss://environment.test/api/preview",
      credentials: false,
      query: { wsTicket: "initial-expired-ticket" },
    },
  });
  try {
    expect(mocks.lastSourceHtml).toContain("initial-expired-ticket");
    act(() => {
      emit({ type: "status", status: "streaming" });
    });

    // Mid-session access drops to null while WebView stays mounted.
    mocks.accessState = {
      ...mocks.accessState,
      access: null,
      error: "Relay unavailable",
    };
    rerender();
    expect(mocks.webViewMounts).toBe(1);

    // WebView process terminates during the outage and recovers by remounting.
    act(() => mocks.onProcessTerminated?.());
    expect(mocks.webViewMounts).toBe(2);
    expect(mocks.lastSourceHtml).toContain('"access":null');
    expect(mocks.lastSourceHtml).not.toContain("initial-expired-ticket");
  } finally {
    cleanup();
  }
});

it("boots with null access if the WebView remounts after authorization refusals are exhausted", () => {
  const { cleanup } = mountView({
    access: {
      httpBase: "https://environment.test/api/preview",
      wsBase: "wss://environment.test/api/preview",
      credentials: false,
      query: { wsTicket: "refused-ticket" },
    },
  });
  try {
    expect(mocks.lastSourceHtml).toContain("refused-ticket");
    act(() => {
      emit({ type: "status", status: "streaming", accessGeneration: 0 });
      emit({ type: "unauthorized", accessGeneration: 0 });
      emit({ type: "unauthorized", accessGeneration: 0 });
      emit({ type: "unauthorized", accessGeneration: 0 });
    });

    act(() => mocks.onProcessTerminated?.());
    expect(mocks.webViewMounts).toBe(2);
    expect(mocks.lastSourceHtml).toContain('"access":null');
    expect(mocks.lastSourceHtml).not.toContain("refused-ticket");
  } finally {
    cleanup();
  }
});
