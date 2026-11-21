import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const STORAGE_KEY = "t3code:preview-audio-muted:v1";

function createLocalStorage() {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => {
      store.set(key, value);
    },
    removeItem: (key: string) => {
      store.delete(key);
    },
    clear: () => store.clear(),
    key: (index: number) => [...store.keys()][index] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

/**
 * A window that can carry the same-window notification `writeLocalStorageValue` dispatches,
 * which a subscription sees synchronously as part of the write.
 */
function createWindow() {
  const localStorage = createLocalStorage();
  const testWindow = new EventTarget() as Window & typeof globalThis & { localStorage: Storage };
  Object.assign(testWindow, { localStorage });
  vi.stubGlobal("window", testWindow);
  vi.stubGlobal("localStorage", localStorage);
  return { window: testWindow, localStorage };
}

const stored = (localStorage: Storage): ReadonlyArray<string> =>
  JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]") as ReadonlyArray<string>;

const loadStore = async () => {
  vi.resetModules();
  return import("./previewAudioMuteStore");
};

let testWindow: ReturnType<typeof createWindow>;
beforeEach(() => {
  testWindow = createWindow();
});
afterEach(() => {
  vi.resetModules();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("preview audio mute store", () => {
  it("toggles exactly the tab it is given", async () => {
    const { usePreviewAudioMuteStore } = await loadStore();
    const toggle = (tabId: string) => usePreviewAudioMuteStore.getState().toggle(tabId);
    toggle("tab-a");
    toggle("tab-b");
    expect([...usePreviewAudioMuteStore.getState().muted].toSorted()).toEqual(["tab-a", "tab-b"]);

    toggle("tab-a");
    expect([...usePreviewAudioMuteStore.getState().muted]).toEqual(["tab-b"]);
  });

  /*
   * One update path: the write notifies this window synchronously, and that notification is the
   * only thing that changes the store. A second path would notify subscribers twice per toggle.
   */
  it("notifies subscribers once per toggle through the storage path alone", async () => {
    const { usePreviewAudioMuteStore } = await loadStore();
    const seen: Array<ReadonlySet<string>> = [];
    const unsubscribe = usePreviewAudioMuteStore.subscribe((state) => seen.push(state.muted));

    usePreviewAudioMuteStore.getState().toggle("tab-a");
    expect(seen).toHaveLength(1);
    expect([...seen[0]!]).toEqual(["tab-a"]);
    expect(stored(testWindow.localStorage)).toEqual(["tab-a"]);

    usePreviewAudioMuteStore.getState().toggle("tab-a");
    expect(seen).toHaveLength(2);
    expect([...seen[1]!]).toEqual([]);
    expect(stored(testWindow.localStorage)).toEqual([]);
    unsubscribe();
  });

  /*
   * The write notifies this window synchronously, so a store that also updated its own state
   * from the toggle would apply the change twice: once from storage and once from its own
   * guess. Persisted and in-memory state must agree after a single call.
   */
  it("applies one toggle once, even though the write notifies this window", async () => {
    const { usePreviewAudioMuteStore } = await loadStore();
    usePreviewAudioMuteStore.getState().toggle("tab-a");
    expect(stored(testWindow.localStorage)).toEqual(["tab-a"]);
    expect([...usePreviewAudioMuteStore.getState().muted]).toEqual(["tab-a"]);

    usePreviewAudioMuteStore.getState().toggle("tab-a");
    expect(stored(testWindow.localStorage)).toEqual([]);
    expect([...usePreviewAudioMuteStore.getState().muted]).toEqual([]);
  });

  it("treats a repeated value as a no-op", async () => {
    const { usePreviewAudioMuteStore } = await loadStore();
    usePreviewAudioMuteStore.getState().setMuted("tab-a", true);
    const writes = vi.spyOn(testWindow.localStorage, "setItem");
    usePreviewAudioMuteStore.getState().setMuted("tab-a", true);
    expect(writes).not.toHaveBeenCalled();
    expect([...usePreviewAudioMuteStore.getState().muted]).toEqual(["tab-a"]);
  });

  it("keeps a change another window made", async () => {
    const { usePreviewAudioMuteStore } = await loadStore();
    // Another window writes, and only the storage event reaches this one.
    testWindow.localStorage.setItem(STORAGE_KEY, JSON.stringify(["tab-b"]));
    const event = new Event("storage") as Event & { key: string };
    event.key = STORAGE_KEY;
    testWindow.window.dispatchEvent(event);
    expect([...usePreviewAudioMuteStore.getState().muted]).toEqual(["tab-b"]);
  });
});

describe("preview audio ownership", () => {
  it("lets exactly one surface play a tab, with the most recent claim winning", async () => {
    const { claimPreviewAudio, releasePreviewAudio, previewAudioOwner } = await loadStore();
    claimPreviewAudio("tab-a", "panel");
    expect(previewAudioOwner("tab-a")).toBe("panel");
    claimPreviewAudio("tab-a", "mini-player");
    expect(previewAudioOwner("tab-a")).toBe("mini-player");
    // The displaced surface keeps its claim, so closing the newer one hands the tab back.
    releasePreviewAudio("tab-a", "mini-player");
    expect(previewAudioOwner("tab-a")).toBe("panel");
    releasePreviewAudio("tab-a", "panel");
    expect(previewAudioOwner("tab-a")).toBeNull();
  });

  it("leaves a popped-out window owning the tab while it is open", async () => {
    const { claimPreviewAudio, previewAudioOwner } = await loadStore();
    claimPreviewAudio("tab-a", "picture-in-picture", true);
    // A surface mounting later still cannot take the sound from a window the user opened.
    claimPreviewAudio("tab-a", "panel");
    expect(previewAudioOwner("tab-a")).toBe("picture-in-picture");
  });
});
