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

function matchesProjectRefs(
  environmentId: EnvironmentId,
  projectId: ProjectId,
  projectRefs: ReadonlyArray<ScopedThreadListProjectRef> | null,
): boolean {
  if (projectRefs === null) return true;
  return projectRefs.some(
    (ref) => ref.environmentId === environmentId && ref.projectId === projectId,
  );
}

export function hasScopedFreshThreadListRows(input: {
  readonly threads: ReadonlyArray<{
    readonly archivedAt: string | null;
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }>;
  readonly pendingTasks: ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectId: ProjectId;
  }>;
  readonly selectedEnvironmentId: EnvironmentId | null;
  readonly projectRefs: ReadonlyArray<ScopedThreadListProjectRef> | null;
  readonly settledCount?: number;
}): boolean {
  if ((input.settledCount ?? 0) > 0) return true;
  if (
    input.threads.some(
      (thread) =>
        thread.archivedAt === null &&
        (input.selectedEnvironmentId === null ||
          thread.environmentId === input.selectedEnvironmentId) &&
        matchesProjectRefs(thread.environmentId, thread.projectId, input.projectRefs),
    )
  ) {
    return true;
  }
  return input.pendingTasks.some(
    (task) =>
      (input.selectedEnvironmentId === null ||
        task.environmentId === input.selectedEnvironmentId) &&
      matchesProjectRefs(task.environmentId, task.projectId, input.projectRefs),
  );
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
