import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { AtomRegistry } from "effect/reactivity";

import { evictModelCacheForThreads } from "../components/chat/modelCache";
import { environmentThreadShells } from "./threads";

/**
 * Settled threads are not expected back soon, so their model bytes leave the
 * client cache. A later visit loads a model once; settling again evicts again.
 */
export function startModelCacheEviction(registry: AtomRegistry.AtomRegistry): () => void {
  let settled = new Set<string>();
  return registry.subscribe(
    environmentThreadShells.threadShellsAtom,
    (threads) => {
      const next = new Set<string>();
      const newlySettled: Array<{ environmentId: string; threadId: string }> = [];
      for (const thread of threads) {
        if (thread.settledOverride !== "settled") continue;
        const key = scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));
        next.add(key);
        if (!settled.has(key)) {
          newlySettled.push({ environmentId: thread.environmentId, threadId: thread.id });
        }
      }
      settled = next;
      if (newlySettled.length > 0) void evictModelCacheForThreads(newlySettled);
    },
    { immediate: true },
  );
}
