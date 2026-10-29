const CACHE_NAME = "t3-model-bytes-v1";
const MEMORY_ENTRY_LIMIT = 4;
const CACHE_ORIGIN = "https://t3-model-cache.invalid";

const memoryCache = new Map<string, ArrayBuffer>();
const threadGenerations = new Map<string, number>();
const evictingTargets = new Set<string>();
const pendingWrites = new Map<string, Set<Promise<void>>>();

type PendingLoad = {
  readonly promise: Promise<ArrayBuffer>;
  readonly controller: AbortController;
  consumers: number;
};

const pendingLoads = new Map<string, PendingLoad>();

function cacheRequest(key: string): Request {
  return new Request(`${CACHE_ORIGIN}/${encodeURIComponent(key)}`);
}

async function openCache(): Promise<Cache | null> {
  if (typeof caches === "undefined") return null;
  try {
    return await caches.open(CACHE_NAME);
  } catch {
    return null;
  }
}

function remember(key: string, bytes: ArrayBuffer): void {
  memoryCache.delete(key);
  memoryCache.set(key, bytes);
  while (memoryCache.size > MEMORY_ENTRY_LIMIT) {
    const oldest = memoryCache.keys().next().value;
    if (oldest === undefined) break;
    memoryCache.delete(oldest);
  }
}

export function createModelCacheKey(input: {
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

export interface ModelCacheThread {
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
  return new DOMException("The model load was cancelled.", "AbortError");
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

/** Drops a settled thread's model bytes from memory and Cache Storage. */
export async function evictModelCacheForThreads(
  threads: ReadonlyArray<ModelCacheThread>,
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
      if (belongsToTarget(key)) memoryCache.delete(key);
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

async function loadUncached(key: string, url: string, signal: AbortSignal): Promise<ArrayBuffer> {
  const generation = generationFor(key);
  const target = cacheEntryThreadTarget(key);
  const evicting = target !== null && evictingTargets.has(target);
  const memory = memoryCache.get(key);
  if (memory !== undefined && !evicting) {
    remember(key, memory);
    return memory;
  }

  const cache = await openCache();
  if (cache !== null && !evicting) {
    try {
      const hit = await cache.match(cacheRequest(key));
      if (hit !== undefined) {
        const bytes = await hit.arrayBuffer();
        if (isCurrentGeneration(key, generation)) remember(key, bytes);
        return bytes;
      }
    } catch {
      // Cache Storage is a best-effort fast path; fall through to the network.
    }
  }

  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`The model could not be loaded (${response.status}).`);
  const copy = cache === null ? null : response.clone();
  const bytes = await response.arrayBuffer();
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

/**
 * Signed asset URLs change on every mint, so model bytes are cached under a
 * stable file-revision key instead of the URL the browser would otherwise see.
 */
export function loadModelBytes(
  key: string,
  url: string,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
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
