import type { NetworkStatus } from "@t3tools/client-runtime/connection";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

const EMPTY_THREADS: ReadonlyArray<never> = [];

export interface ScopedThreadListProjectRef {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
}

export function filterFreshThreads<T extends { readonly environmentId: EnvironmentId }>(
  threads: ReadonlyArray<T>,
  freshEnvironmentIds: ReadonlySet<EnvironmentId>,
): ReadonlyArray<T> {
  if (threads.length === 0) return threads;
  if (freshEnvironmentIds.size === 0) return EMPTY_THREADS;
  let allFresh = true;
  for (const thread of threads) {
    if (!freshEnvironmentIds.has(thread.environmentId)) {
      allFresh = false;
      break;
    }
  }
  if (allFresh) return threads;
  const filtered = threads.filter((thread) => freshEnvironmentIds.has(thread.environmentId));
  return filtered.length === 0 ? EMPTY_THREADS : filtered;
}

export function resolveSingleScopedEnvironmentId(input: {
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly projectRefs: ReadonlyArray<ScopedThreadListProjectRef> | null;
}): EnvironmentId | null {
  if (input.selectedEnvironmentId !== null) return input.selectedEnvironmentId;
  if (input.projectRefs === null || input.projectRefs.length === 0) return null;
  const firstEnvironmentId = input.projectRefs[0]!.environmentId;
  return input.projectRefs.every((ref) => ref.environmentId === firstEnvironmentId)
    ? firstEnvironmentId
    : null;
}

export function shouldShowThreadListSkeleton(input: {
  readonly isLoadingConnections: boolean;
  readonly hasConnections: boolean;
  readonly networkStatus: NetworkStatus;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly projectRefs?: ReadonlyArray<ScopedThreadListProjectRef> | null;
  readonly syncingEnvironmentIds: ReadonlySet<EnvironmentId>;
  readonly hasVisibleRows: boolean;
}): boolean {
  if (input.hasVisibleRows) return false;
  if (input.isLoadingConnections) return true;
  if (!input.hasConnections || input.networkStatus === "offline") return false;
  if (input.projectRefs != null && input.projectRefs.length > 0) {
    return input.projectRefs.some(
      (ref) =>
        (input.selectedEnvironmentId === null ||
          ref.environmentId === input.selectedEnvironmentId) &&
        input.syncingEnvironmentIds.has(ref.environmentId),
    );
  }
  if (input.selectedEnvironmentId !== null) {
    return input.syncingEnvironmentIds.has(input.selectedEnvironmentId);
  }
  return input.syncingEnvironmentIds.size > 0;
}
