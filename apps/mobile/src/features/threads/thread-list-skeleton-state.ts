import type { NetworkStatus } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

export function filterFreshThreads<T extends { readonly environmentId: EnvironmentId }>(
  threads: ReadonlyArray<T>,
  freshEnvironmentIds: ReadonlySet<EnvironmentId>,
): ReadonlyArray<T> {
  if (threads.length === 0) return threads;
  let allFresh = true;
  for (const thread of threads) {
    if (!freshEnvironmentIds.has(thread.environmentId)) {
      allFresh = false;
      break;
    }
  }
  return allFresh
    ? threads
    : threads.filter((thread) => freshEnvironmentIds.has(thread.environmentId));
}

export function shouldShowThreadListSkeleton(input: {
  readonly isLoadingConnections: boolean;
  readonly hasConnections: boolean;
  readonly networkStatus: NetworkStatus;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly syncingEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly hasVisibleRows: boolean;
}): boolean {
  if (input.hasVisibleRows) return false;
  if (input.isLoadingConnections) return true;
  if (!input.hasConnections || input.networkStatus === "offline") return false;
  if (input.selectedEnvironmentId !== null) {
    return input.syncingEnvironmentIds.has(input.selectedEnvironmentId);
  }
  return input.syncingEnvironmentIds.size > 0;
}
