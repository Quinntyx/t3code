const CACHE_NAME = "t3-asset-bytes-v1";
const LEGACY_CACHE_NAME = "t3-model-bytes-v1";
const MEMORY_BYTE_LIMIT = 64 * 1024 * 1024;
const CACHE_ORIGIN = "https://t3-asset-cache.invalid";

const memoryCache = new Map<string, Blob>();
let memoryBytes = 0;
let legacyCacheDropped = false;
const threadGenerations = new Map<string, number>();
const evictingTargets = new Set<string>();
const pendingWrites = new Map<string, Set<Promise<void>>>();

type PendingLoad = {
  readonly promise: Promise<Blob>;
  readonly controller: AbortController;
  consumers: number;
};

const pendingLoads = new Map<string, PendingLoad>();

function cacheRequest(key: string): Request {
  return new Request(`${CACHE_ORIGIN}/${encodeURIComponent(key)}`);
}

async function openCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  if (!legacyCacheDropped) {
    legacyCacheDropped = true;
    void Promise.resolve()
      .then(() => caches.delete(LEGACY_CACHE_NAME))
      .catch(() => false);
  }
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

const OBJECT_URL_RELEASE_GRACE_MS = 1_000;
const objectUrls = new Map<string, { readonly url: string; holders: number }>();

// A blob URL outlives its last holder while its bytes stay in memory, so an element that
// copied it (an expanded preview) keeps working until the bytes themselves are dropped.
function revokeUnusedObjectUrl(key: string): void {
  const entry = objectUrls.get(key);
  if (entry === undefined || entry.holders > 0 || memoryCache.has(key)) return;
  objectUrls.delete(key);
  URL.revokeObjectURL(entry.url);
}

function dropFromMemory(key: string): boolean {
  const blob = memoryCache.get(key);
  if (blob === undefined) return false;
  memoryCache.delete(key);
  memoryBytes -= blob.size;
  return true;
}

function forget(key: string): void {
  if (dropFromMemory(key)) revokeUnusedObjectUrl(key);
}

function remember(key: string, blob: Blob): void {
  dropFromMemory(key);
  if (blob.size > MEMORY_BYTE_LIMIT) return;
  memoryCache.set(key, blob);
  memoryBytes += blob.size;
  for (const oldest of memoryCache.keys()) {
    if (memoryBytes <= MEMORY_BYTE_LIMIT) break;
    forget(oldest);
  }
}

export function createAssetCacheKey(input: {
  readonly environmentId?: string | null | undefined;
  readonly threadId?: string | null | undefined;
  readonly resource: unknown;
  readonly revision?: string | number | null | undefined;
}): string {
  return JSON.stringify([
    input.environmentId ?? null,
    input.threadId ?? null,
    input.resource,
    input.revision ?? null,
  ]);
}

export interface AssetCacheThread {
  readonly environmentId: string;
  readonly threadId: string;
}

function threadTargetKey(environmentId: string, threadId: string): string {
  return `${environmentId}\u0000${threadId}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cacheEntryThreadTarget(key: string): string | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 3) return null;
  const [environmentId, threadId, resourceCandidate] = parsed;
  if (typeof environmentId !== "string") return null;
  const resource = isRecord(threadId) ? threadId : resourceCandidate;
  const resolvedThreadId =
    typeof threadId === "string"
      ? threadId
      : isRecord(resource) && typeof resource.threadId === "string"
        ? resource.threadId
        : null;
  return resolvedThreadId === null ? null : threadTargetKey(environmentId, resolvedThreadId);
}

function cacheRequestKey(request: Request): string | null {
  const prefix = `${CACHE_ORIGIN}/`;
  if (!request.url.startsWith(prefix)) return null;
  try {
    return decodeURIComponent(request.url.slice(prefix.length));
  } catch {
    return null;
  }
}

function generationFor(key: string): number {
  const target = cacheEntryThreadTarget(key);
  return target === null ? 0 : (threadGenerations.get(target) ?? 0);
}

function isCurrentGeneration(key: string, generation: number): boolean {
  const target = cacheEntryThreadTarget(key);
  return target === null || (threadGenerations.get(target) ?? 0) === generation;
}

function trackWrite(key: string, write: Promise<void>): void {
  const target = cacheEntryThreadTarget(key);
  if (target === null) return;
  let writes = pendingWrites.get(target);
  if (writes === undefined) {
    writes = new Set();
    pendingWrites.set(target, writes);
  }
  writes.add(write);
  const settle = () => {
    writes.delete(write);
    if (writes.size === 0) pendingWrites.delete(target);
  };
  void write.then(settle, settle);
}

function abortError(): Error {
  return new DOMException("The asset load was cancelled.", "AbortError");
}

function awaitWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError());
  return new Promise<T>((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(abortError());
    };
    signal.addEventListener("abort", abort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", abort);
        resolve(value);
      },
      (cause: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(cause);
      },
    );
  });
}

/** Drops a settled thread's asset bytes from memory and Cache Storage. */
export async function evictAssetCacheForThreads(
  threads: ReadonlyArray<AssetCacheThread>,
): Promise<void> {
  if (threads.length === 0) return;
  const targets = new Set(
    threads.map(({ environmentId, threadId }) => threadTargetKey(environmentId, threadId)),
  );
  const belongsToTarget = (key: string) => {
    const target = cacheEntryThreadTarget(key);
    return target !== null && targets.has(target);
  };

  // Invalidate before waiting so loads that were already running cannot cache
  // their bytes after this eviction finishes.
  for (const target of targets) {
    threadGenerations.set(target, (threadGenerations.get(target) ?? 0) + 1);
    evictingTargets.add(target);
  }
  try {
    const writes = [...targets].flatMap((target) => [...(pendingWrites.get(target) ?? [])]);
    if (writes.length > 0) await Promise.allSettled(writes);

    for (const key of memoryCache.keys()) {
      if (belongsToTarget(key)) forget(key);
    }

    const cache = await openCache();
    if (cache === null) return;
    try {
      const requests = await cache.keys();
      await Promise.all(
        requests.map(async (request) => {
          const key = cacheRequestKey(request);
          if (key !== null && belongsToTarget(key)) await cache.delete(request);
        }),
      );
    } catch {
      // Cache Storage is best effort; eviction must not fail the settle action.
    }
  } finally {
    for (const target of targets) evictingTargets.delete(target);
  }
}

async function readStored(
  key: string,
  cache: Cache | null,
  generation: number,
): Promise<Blob | null> {
  const target = cacheEntryThreadTarget(key);
  if (target !== null && evictingTargets.has(target)) return null;
  const memory = memoryCache.get(key);
  if (memory !== undefined) {
    remember(key, memory);
    return memory;
  }
  if (cache === null) return null;
  try {
    const hit = await cache.match(cacheRequest(key));
    if (hit === undefined) return null;
    const blob = await hit.blob();
    if (isCurrentGeneration(key, generation)) remember(key, blob);
    return blob;
  } catch {
    // Cache Storage is a best-effort fast path; fall through to the network.
    return null;
  }
}

async function loadUncached(key: string, url: string, signal: AbortSignal): Promise<Blob> {
  const generation = generationFor(key);
  const cache = await openCache();
  const stored = await readStored(key, cache, generation);
  if (stored !== null) return stored;

  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`The asset could not be loaded (${response.status}).`);
  const copy = cache === null ? null : response.clone();
  const bytes = await response.blob();
  if (isCurrentGeneration(key, generation)) {
    remember(key, bytes);
    if (cache !== null && copy !== null) {
      const write = cache.put(cacheRequest(key), copy).catch(() => {
        // A full or evicting cache must not fail the preview that already loaded.
      });
      trackWrite(key, write);
    }
  }
  return bytes;
}

function consumePendingLoad(key: string, pending: PendingLoad, signal: AbortSignal) {
  pending.consumers += 1;
  return awaitWithSignal(pending.promise, signal).finally(() => {
    pending.consumers -= 1;
    if (pending.consumers === 0 && pendingLoads.get(key) === pending) pending.controller.abort();
  });
}

/** The blob URL for bytes already in memory, so a remount can paint it on the first frame. */
export function peekAssetObjectUrl(key: string): string | null {
  const existing = objectUrls.get(key);
  if (existing !== undefined) return existing.url;
  const blob = memoryCache.get(key);
  if (blob === undefined) return null;
  // Owned by the memory entry until a holder takes it; forgetting the bytes revokes it.
  const entry = { url: URL.createObjectURL(blob), holders: 0 };
  objectUrls.set(key, entry);
  return entry.url;
}

/**
 * Copies an asset an element just loaded from its signed URL into the byte cache. The
 * request is answered from the HTTP cache, so the first view keeps native lazy loading.
 */
export function cacheLoadedAsset(key: string, src: string): void {
  if (src.startsWith("blob:")) return;
  void loadAssetBlob(key, src.split("#", 1)[0] ?? src, new AbortController().signal).catch(() => {
    // Caching is best effort; the element already shows the image.
  });
}

/**
 * Shares one blob URL per key. Revocation waits a moment after the last holder lets go,
 * so a consumer that re-subscribes to the same key keeps the URL its element shows.
 */
export function acquireAssetObjectUrl(
  key: string,
  blob: Blob,
): { readonly url: string; readonly release: () => void } {
  let entry = objectUrls.get(key);
  if (entry === undefined) {
    entry = { url: URL.createObjectURL(blob), holders: 0 };
    objectUrls.set(key, entry);
  }
  const held = entry;
  held.holders += 1;
  let released = false;
  return {
    url: held.url,
    release: () => {
      if (released) return;
      released = true;
      held.holders -= 1;
      setTimeout(() => revokeUnusedObjectUrl(key), OBJECT_URL_RELEASE_GRACE_MS);
    },
  };
}

/** Stored bytes for `key`, without a network request; null when nothing is stored. */
export async function readCachedAssetBlob(key: string): Promise<Blob | null> {
  const memory = memoryCache.get(key);
  if (memory !== undefined) return memory;
  const pending = pendingLoads.get(key);
  if (pending !== undefined) return pending.promise.catch(() => null);
  const generation = generationFor(key);
  return readStored(key, await openCache(), generation);
}

/**
 * Signed asset URLs change on every mint, so asset bytes are cached under a
 * stable file-revision key instead of the URL the browser would otherwise see.
 */
export function loadAssetBlob(key: string, url: string, signal: AbortSignal): Promise<Blob> {
  const memory = memoryCache.get(key);
  if (memory !== undefined) {
    remember(key, memory);
    return Promise.resolve(memory);
  }

  const pending = pendingLoads.get(key);
  if (pending !== undefined) return consumePendingLoad(key, pending, signal);

  const controller = new AbortController();
  let entry: PendingLoad;
  const promise = loadUncached(key, url, controller.signal).finally(() => {
    if (pendingLoads.get(key) === entry) pendingLoads.delete(key);
  });
  entry = { promise, controller, consumers: 0 };
  pendingLoads.set(key, entry);
  void promise.catch(() => {
    // Consumers observe the rejection; this keeps an abandoned load from
    // surfacing as an unhandled rejection.
  });
  return consumePendingLoad(key, entry, signal);
}
