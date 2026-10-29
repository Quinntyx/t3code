const CACHE_NAME = "t3-model-bytes-v1";
const MEMORY_ENTRY_LIMIT = 4;
const CACHE_ORIGIN = "https://t3-model-cache.invalid";

const memoryCache = new Map<string, ArrayBuffer>();

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
}

/**
 * Signed asset URLs change on every mint, so model bytes are cached under a
 * stable file-revision key instead of the URL the browser would otherwise see.
 */
export async function loadModelBytes(
  key: string,
  url: string,
  signal: AbortSignal,
): Promise<ArrayBuffer> {
  const memory = memoryCache.get(key);
  if (memory !== undefined) {
    remember(key, memory);
    return memory;
  }

  const cache = await openCache();
  if (cache !== null) {
    try {
      const hit = await cache.match(cacheRequest(key));
      if (hit !== undefined) {
        const bytes = await hit.arrayBuffer();
        remember(key, bytes);
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
  remember(key, bytes);
  if (cache !== null && copy !== null) {
    void cache.put(cacheRequest(key), copy).catch(() => {
      // A full or evicting cache must not fail the preview that already loaded.
    });
  }
  return bytes;
}
