import { useEffect, useState } from "react";

import { acquireAssetObjectUrl, peekAssetObjectUrl, readCachedAssetBlob } from "./assetBytesCache";

export interface CachedAssetSource {
  /** Stable identity of the bytes; without one the signed URL passes through. */
  readonly key: string | undefined;
  readonly url: string | null;
}

/**
 * Serves stored bytes through blob URLs so a re-signed URL does not download them again.
 * A miss shows the signed URL (native lazy loading); `cacheLoadedAsset` stores it on load.
 * Immutable keys (attachments) exist before the mint, so stored bytes show without it.
 */
export function useCachedAssetSrcs(
  sources: ReadonlyArray<CachedAssetSource>,
): ReadonlyArray<string | null> {
  const signature = JSON.stringify(sources.map((source) => source.key ?? null));
  const [resolved, setResolved] = useState<ReadonlyMap<string, string | null>>(() => new Map());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds blob URLs that must be released with their consumer
  useEffect(() => {
    let cancelled = false;
    const releases: Array<() => void> = [];
    const settle = (key: string, src: string | null) => {
      if (cancelled) return;
      setResolved((previous) =>
        previous.has(key) && previous.get(key) === src ? previous : new Map(previous).set(key, src),
      );
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Callers build `sources` each render; only a change in its keys looks the bytes up again.
    for (const { key } of sources) {
      if (key === undefined) continue;
      void readCachedAssetBlob(key).then(
        (blob) => {
          if (cancelled) return;
          if (blob === null) return settle(key, null);
          const handle = acquireAssetObjectUrl(key, blob);
          releases.push(handle.release);
          settle(key, handle.url);
        },
        () => settle(key, null),
      );
    }
    return () => {
      cancelled = true;
      for (const release of releases) release();
    };
  }, [signature]);

  return sources.map(({ key, url }) => {
    if (key === undefined) return url;
    const stored = peekAssetObjectUrl(key) ?? resolved.get(key);
    if (stored !== undefined && stored !== null) return stored;
    // Wait for the store lookup, which answers in milliseconds, before using the network.
    return resolved.has(key) ? url : null;
  });
}

export function useCachedAssetSrc(key: string | undefined, url: string | null): string | null {
  return useCachedAssetSrcs([{ key, url }])[0] ?? null;
}
