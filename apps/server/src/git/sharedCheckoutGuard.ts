import {
  GitCommandError,
  type OrchestrationV2ThreadShell,
  type ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";

type CheckoutThread = Pick<
  OrchestrationV2ThreadShell,
  "id" | "title" | "projectId" | "worktreePath" | "activityRunStatus"
> & {
  readonly activeRunId?: OrchestrationV2ThreadShell["activeRunId"];
  readonly pendingRuntimeRequest?: OrchestrationV2ThreadShell["pendingRuntimeRequest"];
  readonly deletedAt?: OrchestrationV2ThreadShell["deletedAt"];
};

/** Threads with active work whose working directory is one of `checkoutPaths`. */
export function busyThreadsInCheckout<T extends CheckoutThread>(input: {
  readonly checkoutPaths: ReadonlyArray<string>;
  readonly projectIds: ReadonlySet<ProjectId>;
  readonly threads: ReadonlyArray<T>;
  readonly excludeThreadId?: OrchestrationV2ThreadShell["id"];
  readonly includePendingRequests?: boolean;
}): ReadonlyArray<T> {
  return input.threads.filter(
    (thread) =>
      thread.deletedAt == null &&
      thread.id !== input.excludeThreadId &&
      ((thread.activityRunStatus ?? null) !== null ||
        (input.includePendingRequests === true &&
          ((thread.activeRunId ?? null) !== null ||
            (thread.pendingRuntimeRequest ?? null) !== null))) &&
      (thread.worktreePath === null
        ? input.projectIds.has(thread.projectId)
        : input.checkoutPaths.includes(thread.worktreePath)),
  );
}

/** Resolve all checkout paths and project IDs that share `cwd`'s git repository checkout. */
export const resolveSharedCheckoutScope = Effect.fn("sharedCheckoutGuard.resolveScope")(function* (
  cwd: string,
  options?: {
    readonly gitWorkflow?: GitWorkflowService.GitWorkflowService["Service"] | undefined;
    readonly projects?: ReadonlyArray<{ readonly id: ProjectId; readonly workspaceRoot: string }>;
    readonly fallbackProjectIds?: ReadonlyArray<ProjectId>;
  },
) {
  const root = options?.gitWorkflow
    ? yield* options.gitWorkflow.repositoryRoot(cwd).pipe(Effect.orElseSucceed(() => null))
    : null;
  const checkoutPaths = [...new Set([cwd, ...(root === null ? [] : [root])])];
  const projects = options?.projects ?? [];
  const nested =
    options?.gitWorkflow && root !== null
      ? yield* Effect.forEach(
          projects.filter(
            ({ workspaceRoot }) =>
              !checkoutPaths.includes(workspaceRoot) && workspaceRoot.startsWith(`${root}/`),
          ),
          (project) =>
            options.gitWorkflow!.repositoryRoot(project.workspaceRoot).pipe(
              Effect.map((projectRoot) => (projectRoot === root ? [project] : [])),
              Effect.orElseSucceed(() => []),
            ),
          { concurrency: "unbounded" },
        )
      : [];
  const projectIds = new Set<ProjectId>([
    ...(options?.fallbackProjectIds ?? []),
    ...projects
      .filter(({ workspaceRoot }) => checkoutPaths.includes(workspaceRoot))
      .map(({ id }) => id),
    ...nested.flat().map(({ id }) => id),
  ]);
  return { checkoutPaths, projectIds } as const;
});

function describeBusyCheckout(titles: ReadonlyArray<string>): string {
  const quoted = titles.map((title) => `'${title}'`);
  const names =
    quoted.length <= 2
      ? quoted.join(" and ")
      : `${quoted.slice(0, 2).join(", ")} and ${quoted.length - 2} more`;
  return `${names} ${quoted.length === 1 ? "is" : "are"} still working in this checkout. Wait for ${quoted.length === 1 ? "it" : "them"} to finish, or use a worktree for a separate branch.`;
}

/** Switching a shared checkout's ref moves every thread working in it, mid-turn included. */
export const assertCheckoutIdle = Effect.fn("sharedCheckoutGuard.assertCheckoutIdle")(function* (
  operation: string,
  cwd: string,
) {
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const projectService = yield* ProjectService.ProjectService;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* projectService.snapshot.pipe(
    Effect.map((snapshot) => snapshot.projects),
    Effect.orElseSucceed(() => []),
  );
  const { checkoutPaths, projectIds } = yield* resolveSharedCheckoutScope(cwd, {
    gitWorkflow,
    projects,
  });
  // Archiving does not stop a run, so archived threads can still be working. Each lookup fails
  // open on its own, so one failure keeps what the others found.
  const snapshots = yield* Effect.forEach(
    [
      ...checkoutPaths.map((worktreePath) => threadManagement.getShellSnapshot({ worktreePath })),
      ...[...projectIds].map((projectId) => threadManagement.getShellSnapshot({ projectId })),
    ],
    (snapshot) => snapshot.pipe(Effect.orElseSucceed(() => ({ threads: [], archivedThreads: [] }))),
    { concurrency: "unbounded" },
  );
  const busy = busyThreadsInCheckout({
    checkoutPaths,
    projectIds,
    threads: snapshots.flatMap((snapshot) => [...snapshot.threads, ...snapshot.archivedThreads]),
  });
  const titles = [...new Map(busy.map((thread) => [thread.id, thread.title])).values()];
  if (titles.length === 0) return;
  return yield* new GitCommandError({
    operation,
    command: "git checkout",
    cwd,
    detail: describeBusyCheckout(titles),
  });
});
