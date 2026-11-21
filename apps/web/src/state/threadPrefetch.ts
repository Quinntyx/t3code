import { startThreadPrefetch } from "@t3tools/client-runtime/state/threads";
import type { AtomRegistry } from "effect/reactivity";

import { evictAssetCacheForThreads } from "../assets/assetBytesCache";
import { liveShellEnvironmentIdsAtom } from "./shell";
import { environmentThreads, environmentThreadShells } from "./threads";

/**
 * Warms threads that want the user so opening one is instant on a slow network, and
 * drops settled threads' cached messages and media so the caches do not grow forever.
 */
export function startWebThreadPrefetch(registry: AtomRegistry.AtomRegistry): () => void {
  return startThreadPrefetch({
    registry,
    threadsAtom: environmentThreadShells.quietThreadShellsAtom,
    liveEnvironmentIdsAtom: liveShellEnvironmentIdsAtom,
    stateAtom: environmentThreads.stateAtom,
    evictCachedThreads: (threads) => {
      void environmentThreads.evictCachedThreads.run(registry, threads);
      void evictAssetCacheForThreads(threads);
    },
  });
}
