import { createLiveShellEnvironmentIdsAtom } from "@t3tools/client-runtime/state/shell";
import { startThreadPrefetch } from "@t3tools/client-runtime/state/threads";

import { environmentCatalog } from "../connection/catalog";
import { appAtomRegistry } from "./atom-registry";
import { environmentShell } from "./shell";
import { environmentThreads, environmentThreadShells } from "./threads";

const liveShellEnvironmentIdsAtom = createLiveShellEnvironmentIdsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  statusAtom: environmentShell.statusAtom,
});

/**
 * Warms threads that want the user so opening one is instant on a slow network, and
 * drops settled threads' cached messages so the cache does not grow forever.
 */
export function installThreadPrefetch(): () => void {
  return startThreadPrefetch({
    registry: appAtomRegistry,
    threadsAtom: environmentThreadShells.quietThreadShellsAtom,
    liveEnvironmentIdsAtom: liveShellEnvironmentIdsAtom,
    stateAtom: environmentThreads.stateAtom,
    evictCachedThreads: (threads) => {
      void environmentThreads.evictCachedThreads.run(appAtomRegistry, threads);
    },
  });
}
