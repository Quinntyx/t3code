import {
  resolveThreadBranchOwners,
  threadOwnPullRequest,
  threadStackBase,
  type StackableThread,
} from "@t3tools/client-runtime/threadStacks";
import type { GitRestackThreadResult, PullRequestState } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";

export interface StackPullRequest {
  readonly number: number;
  readonly title: string;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly headBranch: string;
  readonly baseBranch: string;
}

export interface PullRequestStackRow {
  readonly branch: string;
  readonly depth: number;
  /** Null for a stacked thread that has no pull request yet. */
  readonly pullRequest: StackPullRequest | null;
  readonly title: string;
  readonly current: boolean;
}

export interface DerivedPullRequestStack<ThreadIdType extends string = string> {
  /** Where the bottom of the stack lands, when known. */
  readonly rootBase: string | null;
  /** The stack's tree in depth-first order. */
  readonly rows: ReadonlyArray<PullRequestStackRow>;
  /** Open pull requests this one lands on, bottom first. */
  readonly openAncestors: ReadonlyArray<number>;
  /** Open pull requests based on this one's head branch. */
  readonly dependents: ReadonlyArray<number>;
  /** The thread that owns this pull request's head branch. */
  readonly ownerThreadId: ThreadIdType | null;
  /** Threads whose work lands on this pull request's head branch: what a restack rebases. */
  readonly stackedThreadCount: number;
}

interface StackNode<T> {
  readonly branch: string;
  readonly base: string | null;
  readonly thread: T | null;
  readonly pullRequest: StackPullRequest | null;
}

/**
 * The thread-derived stack around a pull request, as the server's `mergeStack` and restack see
 * it. `threads` are one project's unarchived threads; a member is a thread owning its branch.
 */
export function derivePullRequestStack<T extends StackableThread & { readonly title: string }>(
  threads: ReadonlyArray<T>,
  current: StackPullRequest & { readonly repository: string },
): DerivedPullRequestStack<T["id"]> | null {
  const repository = current.repository.toLowerCase();
  const nodes = new Map<string, StackNode<T>>();
  for (const thread of resolveThreadBranchOwners(threads).values()) {
    const own = threadOwnPullRequest(thread);
    const snapshot =
      own !== null && own.stack === null && own.repository.toLowerCase() === repository
        ? own.snapshot
        : null;
    nodes.set(thread.branch!, {
      branch: thread.branch!,
      base: threadStackBase(thread),
      thread,
      pullRequest:
        own === null || snapshot === null
          ? null
          : {
              number: own.number,
              title: snapshot.title,
              state: snapshot.state,
              isDraft: snapshot.isDraft,
              headBranch: snapshot.headBranch,
              baseBranch: snapshot.baseBranch,
            },
    });
  }
  const owner = nodes.get(current.headBranch)?.thread ?? null;
  const currentNode: StackNode<T> = {
    branch: current.headBranch,
    base: current.baseBranch,
    thread: owner,
    pullRequest: current,
  };
  nodes.set(current.headBranch, currentNode);

  const children = new Map<string, StackNode<T>[]>();
  for (const node of nodes.values()) {
    if (node.base === null || node.base === node.branch) continue;
    const siblings = children.get(node.base) ?? [];
    siblings.push(node);
    children.set(node.base, siblings);
  }

  const ancestors: StackNode<T>[] = [];
  const seen = new Set([current.headBranch]);
  for (
    let cursor = nodes.get(current.baseBranch);
    cursor !== undefined && !seen.has(cursor.branch);
    cursor = cursor.base === null ? undefined : nodes.get(cursor.base)
  ) {
    seen.add(cursor.branch);
    ancestors.unshift(cursor);
  }
  const root = ancestors[0] ?? currentNode;

  const rows: PullRequestStackRow[] = [];
  const visited = new Set<string>();
  const visit = (node: StackNode<T>, depth: number) => {
    if (visited.has(node.branch)) return;
    visited.add(node.branch);
    rows.push({
      branch: node.branch,
      depth,
      pullRequest: node.pullRequest,
      title: node.pullRequest?.title ?? node.thread?.title ?? node.branch,
      current: node === currentNode,
    });
    for (const child of children.get(node.branch) ?? []) visit(child, depth + 1);
  };
  visit(root, 0);

  const openAncestors: number[] = [];
  for (const ancestor of [...ancestors].reverse()) {
    if (ancestor.pullRequest?.state !== "open") break;
    openAncestors.unshift(ancestor.pullRequest.number);
  }
  const dependents = (children.get(current.headBranch) ?? []).flatMap((node) =>
    node.pullRequest?.state === "open" ? [node.pullRequest.number] : [],
  );
  const stackedThreadCount = threads.filter(
    (thread) =>
      thread !== owner &&
      thread.branch !== null &&
      thread.branch !== current.headBranch &&
      threadStackBase(thread) === current.headBranch,
  ).length;
  if (rows.length <= 1 && stackedThreadCount === 0) return null;
  return {
    rootBase: root === currentNode ? current.baseBranch : root.base,
    rows,
    openAncestors,
    dependents,
    ownerThreadId: owner?.id ?? null,
    stackedThreadCount,
  };
}

/** `#1`, `#1 and #2`, `#1, #2 and #3`. */
function formatPullRequestNumbers(numbers: ReadonlyArray<number>): string {
  const labels = numbers.map((number) => `#${number}`);
  if (labels.length <= 1) return labels.join("");
  return m(msg("{head} and {last}", { head: labels.slice(0, -1).join(", "), last: labels.at(-1) }));
}

export interface PullRequestStackMergeChoice {
  /** The primary merge, which merges the open pull requests below first. */
  readonly stackMerge: { readonly label: string; readonly tooltip: string } | null;
  /** Merging this one alone, into its parent's branch. */
  readonly mergeOnly: {
    readonly label: string;
    readonly detail: string;
    readonly info: string;
  } | null;
  /** The confirmation a single merge needs when open pull requests are stacked on it. */
  readonly dependents: {
    readonly title: string;
    readonly moves: string;
    readonly movesInfo: string;
    readonly restack: string;
    readonly restackInfo: string;
  } | null;
}

export function resolvePullRequestStackMerge(input: {
  readonly number: number;
  readonly baseBranch: string;
  readonly stack: Pick<DerivedPullRequestStack, "rootBase" | "openAncestors" | "dependents"> | null;
}): PullRequestStackMergeChoice {
  const { number, baseBranch, stack } = input;
  const ancestors = stack?.openAncestors ?? [];
  const dependents = stack?.dependents ?? [];
  const parent = ancestors.at(-1);
  const rootBase = stack?.rootBase ?? null;
  const merged = formatPullRequestNumbers([...ancestors, number]);
  const dependentNumbers = formatPullRequestNumbers(dependents);
  return {
    stackMerge:
      parent === undefined
        ? null
        : {
            label:
              ancestors.length === 1
                ? m(msg("Merge #{parent}, then #{number}", { parent, number }))
                : m(msg("Merge stack to #{number}", { number })),
            tooltip:
              rootBase === null
                ? m(msg("Merges {merged}, bottom first", { merged }))
                : m(msg("Merges {merged} into {rootBase}, bottom first", { merged, rootBase })),
          },
    mergeOnly:
      parent === undefined
        ? null
        : {
            label: m(msg("Merge only #{number}", { number })),
            detail: m(msg("into #{parent}'s branch", { parent })),
            info:
              rootBase === null
                ? m(
                    msg(
                      "Lands in {baseBranch}, #{parent}'s branch, not the stack's base. It gets there when #{parent} merges.",
                      { baseBranch, parent },
                    ),
                  )
                : m(
                    msg(
                      "Lands in {baseBranch}, #{parent}'s branch, not {rootBase}. It reaches {rootBase} when #{parent} merges.",
                      { baseBranch, parent, rootBase },
                    ),
                  ),
          },
    dependents:
      dependents.length === 0
        ? null
        : {
            title: m(msg("Merge #{number} into {baseBranch}", { number, baseBranch })),
            moves:
              dependents.length === 1
                ? m(
                    msg("{dependents} moves to {baseBranch}", {
                      dependents: dependentNumbers,
                      baseBranch,
                    }),
                  )
                : m(
                    msg("{dependents} move to {baseBranch}", {
                      dependents: dependentNumbers,
                      baseBranch,
                    }),
                  ),
            movesInfo:
              dependents.length === 1
                ? m(
                    msg(
                      "It is retargeted to {baseBranch}, and its thread moves out of this stack.",
                      { baseBranch },
                    ),
                  )
                : m(
                    msg(
                      "They are retargeted to {baseBranch}, and their threads move out of this stack.",
                      { baseBranch },
                    ),
                  ),
            restack: m(msg("Restack {dependents}", { dependents: dependentNumbers })),
            restackInfo: m(
              msg(
                "Rebases each branch onto {baseBranch} in its own worktree, leaving out #{number}'s commits. Conflicts go to that thread's agent.",
                { baseBranch, number },
              ),
            ),
          },
  };
}

/** The toast line for a restack, as in "Restacked 2 · asked 1 agent to finish". */
export function summarizeRestackOutcomes(results: ReadonlyArray<GitRestackThreadResult>): string {
  if (results.length === 0) return m(msg("Nothing is stacked here"));
  const count = (predicate: (result: GitRestackThreadResult) => boolean) =>
    results.filter(predicate).length;
  const restacked = count((result) => result.outcome === "restacked");
  const asked = count((result) => result.outcome === "agent-asked");
  const unpushed = count((result) => result.outcome === "restacked" && result.pushed === false);
  if (restacked === 0 && asked === 0) return m(msg("Already up to date"));
  const parts = [
    restacked > 0 ? m(msg("Restacked {count}", { count: restacked })) : null,
    unpushed > 0 ? m(msg("{count} not pushed", { count: unpushed })) : null,
    asked > 0
      ? restacked === 0 && unpushed === 0
        ? m(
            msg("Asked {count, plural, one {# agent} other {# agents}} to finish", {
              count: asked,
            }),
          )
        : m(
            msg("asked {count, plural, one {# agent} other {# agents}} to finish", {
              count: asked,
            }),
          )
      : null,
  ].filter((part) => part !== null);
  return parts.join(" · ");
}
