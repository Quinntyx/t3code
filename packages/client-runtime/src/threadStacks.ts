import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { visibleThreadPullRequests } from "@t3tools/shared/threadPullRequests";

export interface StackableThread {
  readonly id: string;
  readonly environmentId: string;
  readonly projectId: string;
  readonly branch: string | null;
  readonly baseBranch?: string | null | undefined;
  readonly worktreePath: string | null;
  readonly pullRequests?: ReadonlyArray<ThreadPullRequestLink> | undefined;
  readonly createdAt: string;
}

export interface ThreadStackNode<T> {
  readonly thread: T;
  readonly children: ReadonlyArray<ThreadStackNode<T>>;
}

export const threadStackKey = (thread: Pick<StackableThread, "environmentId" | "id">) =>
  `${thread.environmentId}:${thread.id}`;

/** The pull request opened from the thread's own branch: an open one, else the newest. */
export function threadOwnPullRequest(
  thread: Pick<StackableThread, "branch" | "pullRequests">,
): ThreadPullRequestLink | null {
  if (thread.branch === null) return null;
  let own: ThreadPullRequestLink | null = null;
  for (const link of visibleThreadPullRequests(thread.pullRequests ?? [])) {
    if (link.snapshot?.headBranch !== thread.branch) continue;
    if (own === null) {
      own = link;
      continue;
    }
    const linkOpen = link.snapshot.state === "open";
    const ownOpen = own.snapshot?.state === "open";
    if (linkOpen !== ownOpen) {
      if (linkOpen) own = link;
      continue;
    }
    if ((link.snapshot.updatedAt ?? link.linkedAt) > (own.snapshot?.updatedAt ?? own.linkedAt)) {
      own = link;
    }
  }
  return own;
}

/** Where the thread's work lands: its pull request's base, else the branch its worktree started from. */
export function threadStackBase(
  thread: Pick<StackableThread, "branch" | "baseBranch" | "pullRequests">,
): string | null {
  return threadOwnPullRequest(thread)?.snapshot?.baseBranch ?? thread.baseBranch ?? null;
}

export const threadBranchKey = (environmentId: string, projectId: string, branch: string) =>
  `${environmentId}:${projectId}:${branch}`;

/**
 * Each branch's owner, by `threadBranchKey`. A branch's owner has its own worktree or pull
 * request, so a thread on the default branch owns nothing. The oldest owner wins a shared branch.
 */
export function resolveThreadBranchOwners<T extends StackableThread>(
  threads: ReadonlyArray<T>,
): ReadonlyMap<string, T> {
  const owners = new Map<string, T>();
  const byAge = [...threads].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  for (const thread of byAge) {
    if (thread.branch === null) continue;
    if (thread.worktreePath === null && threadOwnPullRequest(thread) === null) continue;
    const key = threadBranchKey(thread.environmentId, thread.projectId, thread.branch);
    if (!owners.has(key)) owners.set(key, thread);
  }
  return owners;
}

/**
 * Each stacked thread's parent: the thread that owns the branch its work lands on, as
 * `resolveThreadBranchOwners` decides. An edge that would close a cycle is dropped.
 */
export function resolveThreadStackParents<T extends StackableThread>(
  threads: ReadonlyArray<T>,
): ReadonlyMap<string, T> {
  const owners = resolveThreadBranchOwners(threads);
  const byAge = [...threads].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const parents = new Map<string, T>();
  for (const thread of byAge) {
    const base = threadStackBase(thread);
    if (base === null || base === thread.branch) continue;
    const parent = owners.get(threadBranchKey(thread.environmentId, thread.projectId, base));
    if (parent === undefined || parent === thread) continue;
    let ancestor: T | undefined = parent;
    while (ancestor !== undefined && ancestor !== thread) {
      ancestor = parents.get(threadStackKey(ancestor));
    }
    if (ancestor === thread) continue;
    parents.set(threadStackKey(thread), parent);
  }
  return parents;
}

/**
 * Splits `threads` by whole stacks: a stack, as far as `threads` holds it, lands in `matching`
 * only when every member there passes `predicate`. Both lists keep `threads` order.
 */
export function partitionThreadStacks<T extends StackableThread>(
  threads: ReadonlyArray<T>,
  parents: ReadonlyMap<string, T>,
  predicate: (thread: T) => boolean,
): { readonly matching: ReadonlyArray<T>; readonly others: ReadonlyArray<T> } {
  const present = new Set(threads.map(threadStackKey));
  const rootKeyOf = (thread: T) => {
    let root = thread;
    for (;;) {
      const parent = parents.get(threadStackKey(root));
      if (parent === undefined || !present.has(threadStackKey(parent))) return threadStackKey(root);
      root = parent;
    }
  };
  const failingRoots = new Set<string>();
  for (const thread of threads) {
    if (!predicate(thread)) failingRoots.add(rootKeyOf(thread));
  }
  const matching: T[] = [];
  const others: T[] = [];
  for (const thread of threads) {
    (failingRoots.has(rootKeyOf(thread)) ? others : matching).push(thread);
  }
  return { matching, others };
}

/**
 * Stack trees in `threads` order. A thread whose parent is absent from `threads` is a root.
 * Siblings that need the user, or hold a descendant that does, come first.
 */
export function buildThreadStackForest<T extends StackableThread>(
  threads: ReadonlyArray<T>,
  parents: ReadonlyMap<string, T>,
): ReadonlyArray<ThreadStackNode<T>> {
  const present = new Set(threads.map(threadStackKey));
  const children = new Map<string, T[]>();
  const roots: T[] = [];
  for (const thread of threads) {
    const parent = parents.get(threadStackKey(thread));
    if (parent === undefined || !present.has(threadStackKey(parent))) {
      roots.push(thread);
      continue;
    }
    const key = threadStackKey(parent);
    const siblings = children.get(key) ?? [];
    siblings.push(thread);
    children.set(key, siblings);
  }
  const build = (thread: T): ThreadStackNode<T> => ({
    thread,
    children: (children.get(threadStackKey(thread)) ?? []).map(build),
  });
  return roots.map(build);
}

export function flattenThreadStack<T>(node: ThreadStackNode<T>): ReadonlyArray<T> {
  return [node.thread, ...node.children.flatMap(flattenThreadStack)];
}

/** Orders stacks by their earliest member in `order`, so a stack sits where its newest work does. */
export function rankThreadStacks<T>(
  forest: ReadonlyArray<ThreadStackNode<T>>,
  order: ReadonlyArray<T>,
): ReadonlyArray<ThreadStackNode<T>> {
  const index = new Map(order.map((thread, position) => [thread, position]));
  const rank = (node: ThreadStackNode<T>) =>
    Math.min(...flattenThreadStack(node).map((thread) => index.get(thread) ?? Infinity));
  const ranks = new Map(forest.map((node) => [node, rank(node)]));
  return [...forest].sort((left, right) => ranks.get(left)! - ranks.get(right)!);
}

/**
 * A stack member's own pull requests: links whose head branch another member of its stack
 * owns belong on that member's card instead.
 */
export function ownStackPullRequests(
  links: ReadonlyArray<ThreadPullRequestLink>,
  foreignBranches: ReadonlySet<string>,
): ReadonlyArray<ThreadPullRequestLink> {
  if (foreignBranches.size === 0) return links;
  const own = links.filter(
    (link) => link.snapshot === null || !foreignBranches.has(link.snapshot.headBranch),
  );
  return own.length === links.length ? links : own;
}
