import type { ChangeRequestTerminology } from "@t3tools/client-runtime/source-control-clients";
import { resolveThreadCurrentPullRequestLink } from "@t3tools/client-runtime/thread-pull-requests";
import type {
  ContextMenuItem,
  ProjectId,
  PullRequestRef,
  PullRequestState,
  ThreadLinkedPullRequest,
  ThreadPullRequestLink,
} from "@t3tools/contracts";

export type ThreadPullRequestContextMenuAction = "open-in-panel" | "merge" | "stack";

/** The pull request a thread row's badge stands for, as its own menu needs it. */
export interface ThreadPullRequestContextMenuTarget {
  readonly reference: PullRequestRef;
  readonly url: string;
  /** Null while a fresh link has no snapshot and no live status yet. */
  readonly state: PullRequestState | null;
  readonly isDraft: boolean;
  readonly headBranch: string | null;
  readonly stacked: boolean;
}

export function resolveThreadPullRequestContextMenuTarget(input: {
  readonly projectId: ProjectId;
  readonly links: ReadonlyArray<ThreadPullRequestLink>;
  readonly pr: {
    readonly number: number;
    readonly url: string;
    readonly state: PullRequestState;
    readonly isDraft?: boolean | undefined;
    readonly headRef: string;
  } | null;
  readonly branchPullRequest: ThreadLinkedPullRequest | null | undefined;
}): ThreadPullRequestContextMenuTarget | null {
  const link = resolveThreadCurrentPullRequestLink(input.links);
  if (link !== null) {
    return {
      reference: {
        projectId: input.projectId,
        host: link.host,
        repository: link.repository,
        number: link.number,
      },
      url: link.url,
      state: link.snapshot?.state ?? input.pr?.state ?? null,
      isDraft: link.snapshot?.isDraft ?? input.pr?.isDraft ?? false,
      headBranch: link.snapshot?.headBranch ?? input.pr?.headRef ?? null,
      stacked: link.stack !== null,
    };
  }
  const branch = input.branchPullRequest;
  // A branch's pull request is only reachable through the live status that found it.
  if (input.pr === null || branch == null) return null;
  return {
    reference: { projectId: input.projectId, repository: branch.repository, number: branch.number },
    url: input.pr.url,
    state: input.pr.state,
    isDraft: input.pr.isDraft ?? false,
    headBranch: input.pr.headRef,
    stacked: false,
  };
}

export function buildThreadPullRequestContextMenuItems(input: {
  readonly terminology: ChangeRequestTerminology;
  readonly headBranch: string | null;
  readonly canMerge: boolean;
  /** The app draws this menu, so the merge item can ask again in place. */
  readonly confirmMergeInPlace: boolean;
}): ReadonlyArray<ContextMenuItem<ThreadPullRequestContextMenuAction>> {
  return [
    {
      id: "open-in-panel",
      label: `Open in ${input.terminology.shortLabel} viewer`,
      icon: "folder-tree",
    },
    ...(input.canMerge
      ? [
          {
            id: "merge" as const,
            label: `Merge ${input.terminology.singular}`,
            icon: "circle-check",
            separatorBefore: true,
            ...(input.confirmMergeInPlace ? { confirmLabel: "Confirm merge?" } : {}),
          },
        ]
      : []),
    ...(input.headBranch === null
      ? []
      : [
          {
            id: "stack" as const,
            label: `Stack a new thread on ${input.headBranch}`,
            icon: "git-branch",
            separatorBefore: !input.canMerge,
          },
        ]),
  ];
}
