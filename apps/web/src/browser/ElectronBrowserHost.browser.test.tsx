import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  ThreadId,
  type ClientSettings,
  type DesktopPreviewBridge,
  type PreviewEvent,
  type PreviewListResult,
  type PreviewSessionSnapshot,
} from "@t3tools/contracts";
import { AsyncResult, Atom } from "effect/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, fakeTimers, render } from "../../test/render";

type ListResult = AsyncResult.AsyncResult<PreviewListResult, never>;
type EventResult = AsyncResult.AsyncResult<PreviewEvent, never>;

const mocks = vi.hoisted(() => ({
  getClientSettings: vi.fn<() => Promise<ClientSettings | null>>(),
  setClientSettings: vi.fn<(settings: ClientSettings) => Promise<void>>(),
  createTab: vi.fn<DesktopPreviewBridge["createTab"]>(),
  closeTab: vi.fn<DesktopPreviewBridge["closeTab"]>(),
  registerWebview: vi.fn<DesktopPreviewBridge["registerWebview"]>(),
  getPreviewConfig: vi.fn<DesktopPreviewBridge["getPreviewConfig"]>(),
  previewLists: new Map<string, Atom.Writable<ListResult>>(),
  previewEvents: new Map<string, Atom.Writable<EventResult>>(),
  primaryEnvironmentId: null as Atom.Writable<EnvironmentId | null> | null,
}));

vi.mock(import("~/env"), async (original) => ({ ...(await original()), isElectron: true }));

vi.mock(import("~/state/primaryEnvironment"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const primaryEnvironmentIdAtom = Atom.make<EnvironmentId | null>(null);
  mocks.primaryEnvironmentId = primaryEnvironmentIdAtom;
  return { ...actual, primaryEnvironmentIdAtom };
});

vi.mock("~/state/preview", async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return {
    previewEnvironment: {
      list: (target: { environmentId: string; input: { threadId: string } }) => {
        const key = `${target.environmentId}:${target.input.threadId}`;
        let atom = mocks.previewLists.get(key);
        if (!atom) {
          atom = Atom.make<ListResult>(AsyncResult.initial());
          mocks.previewLists.set(key, atom);
        }
        return atom;
      },
      events: (target: { environmentId: string }) => {
        let atom = mocks.previewEvents.get(target.environmentId);
        if (!atom) {
          atom = Atom.make<EventResult>(AsyncResult.initial());
          mocks.previewEvents.set(target.environmentId, atom);
        }
        return atom;
      },
    },
  };
});

vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  useEnvironmentScope: () => true,
}));

vi.mock(import("~/localApi"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    ensureLocalApi: () => ({ ...actual.ensureLocalApi(), persistence: mocks as never }),
  };
});

// The Electron desktop bridge; a browser has none.
vi.mock(import("~/components/preview/previewBridge"), async (original) => ({
  ...(await original()),
  previewBridge: {
    createTab: mocks.createTab,
    closeTab: mocks.closeTab,
    registerWebview: mocks.registerWebview,
    getPreviewConfig: mocks.getPreviewConfig,
  } as never,
}));

vi.mock(import("~/components/preview/usePreviewBridge"), async (original) => ({
  ...(await original()),
  usePreviewBridge: () => undefined,
}));

import {
  __resetClientSettingsPersistenceForTests,
  ensureClientSettingsHydrated,
} from "~/hooks/useSettings";
import { reconcilePreviewServerSessions, resetPreviewStateForTests } from "~/previewStateStore";
import { AppAtomRegistryProvider, appAtomRegistry } from "~/rpc/atomRegistry";
import { previewEnvironment } from "~/state/preview";
import { ElectronBrowserHost } from "./ElectronBrowserHost";

const threadRef = scopeThreadRef(
  EnvironmentId.make("host-webview-order"),
  ThreadId.make("thread-webview-order"),
);

const snapshot = (tabId: string, updatedAt: string): PreviewSessionSnapshot => ({
  threadId: threadRef.threadId,
  tabId,
  navStatus: { _tag: "Success", url: `https://example.com/${tabId}`, title: tabId },
  canGoBack: false,
  canGoForward: false,
  updatedAt,
});

function setup(): Disposable {
  __resetClientSettingsPersistenceForTests();
  mocks.previewLists.clear();
  mocks.previewEvents.clear();
  mocks.getClientSettings.mockReset().mockResolvedValue(DEFAULT_CLIENT_SETTINGS);
  mocks.setClientSettings.mockReset().mockResolvedValue(undefined);
  mocks.createTab.mockReset().mockResolvedValue(undefined);
  mocks.closeTab.mockReset().mockResolvedValue(undefined);
  mocks.registerWebview.mockReset().mockResolvedValue(undefined);
  mocks.getPreviewConfig.mockReset().mockResolvedValue({
    partition: "persist:t3-preview-default",
    webPreferences: "contextIsolation=yes",
    preloadUrl: null,
  });
  return {
    [Symbol.dispose]() {
      resetPreviewStateForTests();
      __resetClientSettingsPersistenceForTests();
      if (mocks.primaryEnvironmentId) appAtomRegistry.set(mocks.primaryEnvironmentId, null);
      mocks.previewLists.clear();
      mocks.previewEvents.clear();
    },
  };
}

async function renderHost() {
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <AppAtomRegistryProvider>
        <ElectronBrowserHost />
      </AppAtomRegistryProvider>,
    ),
  );
  // Unmounting releases each tab on a close timer; run it now so it never fires in a later test.
  stack.defer(async () => {
    using _timers = fakeTimers();
    await screen.unmount();
    await vi.advanceTimersByTimeAsync(0);
  });
  await act(() => ensureClientSettingsHydrated());
  const environment = stack.move();
  return { container: screen.container, [Symbol.asyncDispose]: () => environment.disposeAsync() };
}

describe("ElectronBrowserHost", () => {
  it("never moves a tab's webview when the server reorders tabs by last update", async () => {
    using _state = setup();
    reconcilePreviewServerSessions(threadRef, {
      sessions: [
        snapshot("tab_7", "2026-01-01T00:00:01.000Z"),
        snapshot("tab_8", "2026-01-01T00:00:02.000Z"),
      ],
      serverEpoch: "server-a",
      revision: 1,
    });
    await using screen = await renderHost();

    const host = screen.container.querySelector("[data-electron-browser-host]")!;
    const webviews = () => [...host.querySelectorAll("webview")];
    const before = webviews();
    expect(before.map((node) => node.getAttribute("data-preview-server-tab")).toSorted()).toEqual([
      "tab_7",
      "tab_8",
    ]);

    // Electron destroys a webview's guest when its element leaves the DOM, so a reorder that
    // detaches and re-inserts the element blanks the tab.
    const detached: Node[] = [];
    const observer = new MutationObserver((records) => {
      for (const record of records) detached.push(...record.removedNodes);
    });
    observer.observe(host, { childList: true, subtree: true });

    await act(async () => {
      reconcilePreviewServerSessions(threadRef, {
        sessions: [
          snapshot("tab_8", "2026-01-01T00:00:02.000Z"),
          snapshot("tab_7", "2026-01-01T00:00:03.000Z"),
        ],
        serverEpoch: "server-a",
        revision: 2,
      });
    });
    observer.takeRecords().forEach((record) => detached.push(...record.removedNodes));
    observer.disconnect();

    expect(detached).toEqual([]);
    const after = webviews();
    expect(after).toHaveLength(2);
    expect(after.every((node, index) => node.isSameNode(before[index]!))).toBe(true);
  });

  it("unmounts a hosted webview on a linked environment when the remote server closes its session", async () => {
    using _state = setup();
    const linkedRef = scopeThreadRef(
      EnvironmentId.make("linked-env"),
      ThreadId.make("linked-thread"),
    );
    appAtomRegistry.set(mocks.primaryEnvironmentId!, EnvironmentId.make("primary-env"));
    reconcilePreviewServerSessions(linkedRef, {
      sessions: [
        {
          threadId: linkedRef.threadId,
          tabId: "tab_linked",
          navStatus: { _tag: "Success", url: "https://example.com/linked", title: "Linked" },
          canGoBack: false,
          canGoForward: false,
          updatedAt: "2026-01-01T00:00:01.000Z",
        },
      ],
      serverEpoch: "linked-epoch",
      revision: 1,
    });
    await using screen = await renderHost();

    const host = screen.container.querySelector("[data-electron-browser-host]")!;
    expect(host.querySelectorAll("webview")).toHaveLength(1);

    const eventsAtom = previewEnvironment.events({
      environmentId: linkedRef.environmentId,
      input: {},
    });
    await act(async () => {
      appAtomRegistry.set(
        eventsAtom as Atom.Writable<EventResult>,
        AsyncResult.success({
          type: "closed",
          threadId: linkedRef.threadId,
          tabId: "tab_linked",
          serverEpoch: "linked-epoch",
          revision: 2,
          createdAt: "2026-01-01T00:05:01.000Z",
        }),
      );
    });

    expect(host.querySelectorAll("webview")).toHaveLength(0);
  });
});
