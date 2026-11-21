import type { GitRestackThreadResult, ThreadId, ThreadPullRequestLink } from "@t3tools/contracts";
import type { StackableThread } from "@t3tools/client-runtime/threadStacks";
import { describe, expect, it } from "vite-plus/test";

import {
  derivePullRequestStack,
  resolvePullRequestStackMerge,
  summarizeRestackOutcomes,
  type StackPullRequest,
} from "./pullRequestStack.logic";

type Thread = StackableThread & { readonly title: string };

let clock = 0;
function thread(id: string, overrides: Partial<Thread> = {}): Thread {
  clock += 1;
  return {
    id,
    title: `Thread ${id}`,
    environmentId: "env",
    projectId: "project",
    branch: id,
    baseBranch: "main",
    worktreePath: `/worktrees/${id}`,
    createdAt: `2026-10-01T00:00:${String(clock).padStart(2, "0")}.000Z`,
    ...overrides,
  };
}

function link(
  number: number,
  head: string,
  base: string,
  state: "open" | "merged" | "closed" = "open",
): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "acme/app",
    number,
    url: `https://github.com/acme/app/pull/${number}`,
    source: "created",
    linkedAt: "2026-10-01T00:00:00.000Z",
    snapshot: {
      state,
      title: `PR ${number}`,
      headBranch: head,
      baseBranch: base,
      isDraft: false,
      updatedAt: "2026-10-01T00:00:00.000Z",
      syncedAt: "2026-10-01T00:00:00.000Z",
    },
    stack: null,
  } as ThreadPullRequestLink;
}

function current(
  number: number,
  head: string,
  base: string,
): StackPullRequest & {
  repository: string;
} {
  return {
    number,
    title: `PR ${number}`,
    state: "open",
    isDraft: false,
    headBranch: head,
    baseBranch: base,
    repository: "Acme/App",
  };
}

// main <- a (#1) <- b (#2) <- c (#3), and b <- d (#4); e has no pull request yet and stacks on c.
const stackThreads = () => [
  thread("a", { pullRequests: [link(1, "a", "main")] }),
  thread("b", { baseBranch: "a", pullRequests: [link(2, "b", "a")] }),
  thread("c", { baseBranch: "b", pullRequests: [link(3, "c", "b")] }),
  thread("d", { baseBranch: "b", pullRequests: [link(4, "d", "b")] }),
  thread("e", { baseBranch: "c" }),
  thread("other", { pullRequests: [link(9, "other", "main")] }),
];

describe("derivePullRequestStack", () => {
  it("lays the whole stack out from its bottom, marking the viewed pull request", () => {
    const stack = derivePullRequestStack(stackThreads(), current(3, "c", "b"));
    expect(stack?.rootBase).toBe("main");
    expect(
      stack?.rows.map((row) => [row.depth, row.pullRequest?.number ?? row.title, row.current]),
    ).toEqual([
      [0, 1, false],
      [1, 2, false],
      [2, 3, true],
      [3, "Thread e", false],
      [2, 4, false],
    ]);
    expect(stack?.openAncestors).toEqual([1, 2]);
    expect(stack?.dependents).toEqual([]);
    expect(stack?.ownerThreadId).toBe("c");
    expect(stack?.stackedThreadCount).toBe(1);
  });

  it("names the open pull requests stacked on this one's head", () => {
    const stack = derivePullRequestStack(stackThreads(), current(2, "b", "a"));
    expect(stack?.openAncestors).toEqual([1]);
    expect(stack?.dependents).toEqual([3, 4]);
    expect(stack?.stackedThreadCount).toBe(2);
  });

  it("stops the open ancestors at a merged one", () => {
    const threads = [
      thread("a", { pullRequests: [link(1, "a", "main", "merged")] }),
      thread("b", { baseBranch: "a", pullRequests: [link(2, "b", "a")] }),
      thread("c", { baseBranch: "b", pullRequests: [link(3, "c", "b")] }),
    ];
    expect(derivePullRequestStack(threads, current(3, "c", "b"))?.openAncestors).toEqual([2]);
  });

  it("places a pull request no thread owns by its branches", () => {
    const threads = [
      thread("a", { pullRequests: [link(1, "a", "main")] }),
      thread("c", { baseBranch: "b", pullRequests: [link(3, "c", "b")] }),
    ];
    const stack = derivePullRequestStack(threads, current(2, "b", "a"));
    expect(stack?.rows.map((row) => [row.depth, row.pullRequest?.number])).toEqual([
      [0, 1],
      [1, 2],
      [2, 3],
    ]);
    expect(stack?.ownerThreadId).toBeNull();
    expect(stack?.dependents).toEqual([3]);
  });

  it("is absent for a pull request with nothing stacked around it", () => {
    expect(derivePullRequestStack(stackThreads(), current(9, "other", "main"))).toBeNull();
  });

  it("ignores another repository's pull requests and host-managed stacks", () => {
    const foreign = { ...link(1, "a", "main"), repository: "acme/other" };
    const native = { ...link(2, "b", "a"), stack: {} } as ThreadPullRequestLink;
    const threads = [
      thread("a", { pullRequests: [foreign] }),
      thread("b", { baseBranch: "a", pullRequests: [native] }),
    ];
    const stack = derivePullRequestStack(threads, current(3, "c", "b"));
    expect(stack?.rows.map((row) => row.pullRequest?.number ?? null)).toEqual([null, null, 3]);
    expect(stack?.openAncestors).toEqual([]);
  });
});

describe("resolvePullRequestStackMerge", () => {
  it("merges the open parent first", () => {
    const choice = resolvePullRequestStackMerge({
      number: 2,
      baseBranch: "a",
      stack: { rootBase: "main", openAncestors: [1], dependents: [] },
    });
    expect(choice.stackMerge).toEqual({
      label: "Merge #1, then #2",
      tooltip: "Merges #1 and #2 into main, bottom first",
    });
    expect(choice.mergeOnly?.label).toBe("Merge only #2");
    expect(choice.mergeOnly?.detail).toBe("into #1's branch");
    expect(choice.dependents).toBeNull();
  });

  it("keeps a deeper stack's label short", () => {
    const choice = resolvePullRequestStackMerge({
      number: 3,
      baseBranch: "b",
      stack: { rootBase: "main", openAncestors: [1, 2], dependents: [] },
    });
    expect(choice.stackMerge?.label).toBe("Merge stack to #3");
    expect(choice.stackMerge?.tooltip).toBe("Merges #1, #2 and #3 into main, bottom first");
    expect(choice.mergeOnly?.detail).toBe("into #2's branch");
  });

  it("merges alone when nothing open is below", () => {
    const choice = resolvePullRequestStackMerge({
      number: 1,
      baseBranch: "dev",
      stack: { rootBase: "dev", openAncestors: [], dependents: [3, 4] },
    });
    expect(choice.stackMerge).toBeNull();
    expect(choice.mergeOnly).toBeNull();
    expect(choice.dependents?.title).toBe("Merge #1 into dev");
    expect(choice.dependents?.moves).toBe("#3 and #4 move to dev");
    expect(choice.dependents?.restack).toBe("Restack #3 and #4");
  });

  it("is a plain merge outside a stack", () => {
    expect(resolvePullRequestStackMerge({ number: 5, baseBranch: "main", stack: null })).toEqual({
      stackMerge: null,
      mergeOnly: null,
      dependents: null,
    });
  });
});

describe("summarizeRestackOutcomes", () => {
  const result = (
    outcome: GitRestackThreadResult["outcome"],
    extra: Partial<GitRestackThreadResult> = {},
  ): GitRestackThreadResult => ({
    threadId: "thread" as ThreadId,
    branch: "b",
    onto: "a",
    outcome,
    ...extra,
  });

  it.each([
    [
      [result("restacked"), result("restacked"), result("agent-asked")],
      "Restacked 2 · asked 1 agent to finish",
    ],
    [[result("agent-asked"), result("agent-asked")], "Asked 2 agents to finish"],
    [[result("restacked", { pushed: false }), result("up-to-date")], "Restacked 1 · 1 not pushed"],
    [[result("up-to-date")], "Already up to date"],
    [[], "Nothing is stacked here"],
  ])("summarizes %j", (results, summary) => {
    expect(summarizeRestackOutcomes(results)).toBe(summary);
  });
});
