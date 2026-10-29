import type { AssetResource, EnvironmentId } from "@t3tools/contracts";
import { Image } from "expo-image";
import { useEffect, useState } from "react";

import { assetImageCacheKey } from "../lib/assetImageSource";

const MAX_KNOWN_CACHE_PATHS = 500;
// Synchronous answers for remounts, so a scrolled-back row does not flash its spinner.
const knownCachePaths = new Map<string, string>();

function rememberCachePath(cacheKey: string, uri: string): void {
  knownCachePaths.delete(cacheKey);
  knownCachePaths.set(cacheKey, uri);
  for (const oldest of knownCachePaths.keys()) {
    if (knownCachePaths.size <= MAX_KNOWN_CACHE_PATHS) break;
    knownCachePaths.delete(oldest);
  }
}

function fileUri(path: string): string {
  return path.includes("://") ? path : `file://${path}`;
}

/**
 * The URI to show for an asset image. Until its signed URL is minted, an image whose bytes
 * cannot change (attachments, tool output) shows from the disk cache when it is there.
 */
export function useCachedAssetImageUri(
  environmentId: EnvironmentId | null,
  resource: AssetResource | null,
  signedUri: string | null,
): string | null {
  const cacheKey =
    environmentId === null || resource === null
      ? undefined
      : assetImageCacheKey(environmentId, resource);
  const known = cacheKey === undefined ? undefined : knownCachePaths.get(cacheKey);
  const [found, setFound] = useState<{ readonly cacheKey: string; readonly uri: string } | null>(
    null,
  );
  const lookUp = signedUri === null && known === undefined ? cacheKey : undefined;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads expo-image's native disk cache, which React cannot derive
  useEffect(() => {
    if (lookUp === undefined) return;
    let cancelled = false;
    Image.getCachePathAsync(lookUp).then(
      (path) => {
        if (path === null) return;
        const uri = fileUri(path);
        rememberCachePath(lookUp, uri);
        if (!cancelled) setFound({ cacheKey: lookUp, uri });
      },
      () => {
        // A missing native cache only means waiting for the signed URL.
      },
    );
    return () => {
      cancelled = true;
    };
  }, [lookUp]);

  if (signedUri !== null) return signedUri;
  if (known !== undefined) return known;
  return found !== null && found.cacheKey === cacheKey ? found.uri : null;
}
