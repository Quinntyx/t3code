import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const MODEL_BYTES = new Uint8Array([0x67, 0x6c, 0x54, 0x46]).buffer;

function stubCacheStorage(): Map<string, Response> {
  const store = new Map<string, Response>();
  vi.stubGlobal("caches", {
    open: async () => ({
      match: async (request: Request) => store.get(request.url)?.clone(),
      put: async (request: Request, response: Response) => {
        store.set(request.url, response.clone());
      },
      keys: async () => [...store.keys()].map((url) => new Request(url)),
      delete: async (request: Request) => store.delete(request.url),
    }),
  });
  return store;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("loadAssetBlob", () => {
  it("reuses bytes already loaded for a key", async () => {
    const fetchMock = vi.fn(async () => new Response(MODEL_BYTES));
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("caches", undefined);
    const { loadAssetBlob } = await import("./assetBytesCache");
    const signal = new AbortController().signal;

    const first = await loadAssetBlob("memory-key", "https://example.test/a.glb", signal);
    const second = await loadAssetBlob("memory-key", "https://example.test/a.glb", signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(
      new Uint8Array(await first.arrayBuffer()),
    );
  });

  it("reads persisted bytes without a network request", async () => {
    const store = stubCacheStorage();
    const fetchMock = vi.fn(async () => new Response(MODEL_BYTES));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;

    await (
      await import("./assetBytesCache")
    ).loadAssetBlob("persisted-key", "https://example.test/b.glb", signal);
    await vi.waitFor(() => expect(store.size).toBe(1));

    vi.resetModules();
    const { loadAssetBlob, readCachedAssetBlob } = await import("./assetBytesCache");
    // Before a URL is minted, only stored bytes can answer.
    const unminted = await readCachedAssetBlob("persisted-key");
    expect(await readCachedAssetBlob("missing-key")).toBeNull();
    const second = await loadAssetBlob("persisted-key", "https://example.test/b.glb", signal);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(new Uint8Array(await unminted!.arrayBuffer())).toEqual(new Uint8Array(MODEL_BYTES));
    expect(new Uint8Array(await second.arrayBuffer())).toEqual(new Uint8Array(MODEL_BYTES));
  });

  it("evicts memory and persisted bytes for settled threads", async () => {
    vi.resetModules();
    const store = stubCacheStorage();
    const fetchMock = vi.fn(async () => new Response(MODEL_BYTES));
    vi.stubGlobal("fetch", fetchMock);
    const signal = new AbortController().signal;
    const { createAssetCacheKey, evictAssetCacheForThreads, loadAssetBlob } =
      await import("./assetBytesCache");
    const key = (threadId: string, path: string) =>
      createAssetCacheKey({
        environmentId: "env-1",
        threadId,
        resource: { _tag: "media-file", threadId, path },
        revision: "rev-1",
      });
    const settledKey = key("thread-a", "/a.glb");
    const otherKey = key("thread-b", "/b.glb");

    await loadAssetBlob(settledKey, "https://example.test/a.glb", signal);
    await loadAssetBlob(otherKey, "https://example.test/b.glb", signal);
    await vi.waitFor(() => expect(store.size).toBe(2));

    await evictAssetCacheForThreads([{ environmentId: "env-1", threadId: "thread-a" }]);
    expect(store.size).toBe(1);

    await loadAssetBlob(otherKey, "https://example.test/b.glb", signal);
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await loadAssetBlob(settledKey, "https://example.test/a.glb", signal);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("shares one network request between concurrent loads of the same key", async () => {
    vi.stubGlobal("caches", undefined);
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { loadAssetBlob } = await import("./assetBytesCache");
    const firstSignal = new AbortController().signal;
    const secondSignal = new AbortController().signal;

    const first = loadAssetBlob("coalesced-key", "https://example.test/coalesced.glb", firstSignal);
    const second = loadAssetBlob(
      "coalesced-key",
      "https://example.test/coalesced.glb",
      secondSignal,
    );
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    resolveFetch?.(new Response(MODEL_BYTES));

    const [firstBytes, secondBytes] = await Promise.all([first, second]);
    expect(new Uint8Array(await firstBytes.arrayBuffer())).toEqual(new Uint8Array(MODEL_BYTES));
    expect(new Uint8Array(await secondBytes.arrayBuffer())).toEqual(new Uint8Array(MODEL_BYTES));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not cache bytes whose fetch finishes after eviction", async () => {
    vi.resetModules();
    const store = stubCacheStorage();
    let resolveFetch: ((response: Response) => void) | undefined;
    const fetchMock = vi.fn(
      () =>
        new Promise<Response>((resolve) => {
          resolveFetch = resolve;
        }),
    );
    vi.stubGlobal("fetch", fetchMock);
    const { createAssetCacheKey, evictAssetCacheForThreads, loadAssetBlob } =
      await import("./assetBytesCache");
    const key = createAssetCacheKey({
      environmentId: "env-1",
      threadId: "thread-a",
      resource: { _tag: "media-file", threadId: "thread-a", path: "/late.glb" },
      revision: "rev-1",
    });
    const signal = new AbortController().signal;

    const loading = loadAssetBlob(key, "https://example.test/late.glb", signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await evictAssetCacheForThreads([{ environmentId: "env-1", threadId: "thread-a" }]);
    resolveFetch?.(new Response(MODEL_BYTES));
    await loading;

    expect(store.size).toBe(0);
    const reloading = loadAssetBlob(key, "https://example.test/late.glb", signal);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    resolveFetch?.(new Response(MODEL_BYTES));
    await reloading;
  });

  it("deletes a pending cache write instead of letting it repopulate after eviction", async () => {
    vi.resetModules();
    const store = new Map<string, Response>();
    let releasePut: (() => void) | undefined;
    let markPutStarted: (() => void) | undefined;
    const putStarted = new Promise<void>((resolve) => {
      markPutStarted = resolve;
    });
    const putGate = new Promise<void>((resolve) => {
      releasePut = resolve;
    });
    vi.stubGlobal("caches", {
      open: async () => ({
        match: async () => undefined,
        put: async (request: Request, response: Response) => {
          markPutStarted?.();
          await putGate;
          store.set(request.url, response.clone());
        },
        keys: async () => [...store.keys()].map((url) => new Request(url)),
        delete: async (request: Request) => store.delete(request.url),
      }),
    });
    const fetchMock = vi.fn(async () => new Response(MODEL_BYTES));
    vi.stubGlobal("fetch", fetchMock);
    const { createAssetCacheKey, evictAssetCacheForThreads, loadAssetBlob } =
      await import("./assetBytesCache");
    const key = createAssetCacheKey({
      environmentId: "env-1",
      threadId: "thread-a",
      resource: { _tag: "media-file", threadId: "thread-a", path: "/pending.glb" },
      revision: "rev-1",
    });

    const loading = loadAssetBlob(
      key,
      "https://example.test/pending.glb",
      new AbortController().signal,
    );
    await putStarted;
    const eviction = evictAssetCacheForThreads([{ environmentId: "env-1", threadId: "thread-a" }]);
    releasePut?.();
    await eviction;
    await loading;

    expect(store.size).toBe(0);
  });
});
