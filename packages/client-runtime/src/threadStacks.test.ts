import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadStackForest,
  ownStackPullRequests,
  partitionThreadStacks,
  rankThreadStacks,
  resolveThreadStackParents,
  threadStackKey,
  type StackableThread,
} from "./threadStacks.ts";

let clock = 0;
function thread(id: string, overrides: Partial<StackableThread> = {}): StackableThread {
  clock += 1;
  return {
    id,
    environmentId: "env",
    projectId: "project",
    branch: id,
    baseBranch: "main",
    worktreePath: `/worktrees/${id}`,
    createdAt: `2026-10-01T00:00:${String(clock).padStart(2, "0")}.000Z`,
    ...overrides,
  };
}

function pr(
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

const parentIds = (threads: ReadonlyArray<StackableThread>) =>
  Object.fromEntries(
    [...resolveThreadStackParents(threads)].map(([key, parent]) => [key.split(":")[1], parent.id]),
  );

describe("resolveThreadStackParents", () => {
  it("stacks a thread on the thread that owns its base branch", () => {
    const a = thread("a");
    const b = thread("b", { baseBranch: "a" });
    const c = thread("c", { baseBranch: "b" });
    expect(parentIds([c, b, a])).toEqual({ b: "a", c: "b" });
  });

  it("prefers the base of the thread's own pull request over its saved base", () => {
    const a = thread("a");
    const b = thread("b");
    // B started on A, then its PR was retargeted to main after A merged.
    const c = thread("c", { baseBranch: "b", pullRequests: [pr(3, "c", "a")] });
    const d = thread("d", { baseBranch: "a", pullRequests: [pr(4, "d", "main")] });
    expect(parentIds([a, b, c, d])).toEqual({ c: "a" });
  });

  it("ignores pull requests linked from other branches", () => {
    const a = thread("a", { pullRequests: [pr(9, "elsewhere", "b")] });
    const b = thread("b");
    expect(parentIds([a, b])).toEqual({});
  });

  it("does not stack threads under a checkout of the default branch", () => {
    const root = thread("root", { branch: "main", worktreePath: null, baseBranch: null });
    const a = thread("a");
    expect(parentIds([root, a])).toEqual({});
  });

  it("gives a shared branch to its oldest owner and drops cycles", () => {
    const a = thread("a");
    const twin = thread("twin", { branch: "a" });
    const b = thread("b", { baseBranch: "a" });
    expect(parentIds([twin, b, a])).toMatchObject({ b: "a" });

    const x = thread("x", { baseBranch: "y" });
    const y = thread("y", { baseBranch: "x" });
    expect(Object.keys(parentIds([x, y]))).toHaveLength(1);
  });
});

describe("buildThreadStackForest", () => {
  it("nests each thread under its parent in the order given", () => {
    const a = thread("a");
    const b = thread("b", { baseBranch: "a" });
    const c = thread("c", { baseBranch: "a" });
    const d = thread("d", { baseBranch: "b" });
    const e = thread("e", { baseBranch: "b" });
    const all = [a, b, c, d, e];
    const forest = buildThreadStackForest(all, resolveThreadStackParents(all));
    const shape = (node: (typeof forest)[number]): unknown => [
      node.thread.id,
      node.children.map(shape),
    ];
    expect(forest.map(shape)).toEqual([
      [
        "a",
        [
          [
            "b",
            [
              ["d", []],
              ["e", []],
            ],
          ],
          ["c", []],
        ],
      ],
    ]);
  });

  it("treats a thread whose parent is not listed as a root", () => {
    const a = thread("a");
    const b = thread("b", { baseBranch: "a" });
    const parents = resolveThreadStackParents([a, b]);
    expect(parents.get(threadStackKey(b))).toBe(a);
    expect(buildThreadStackForest([b], parents).map((n) => n.thread.id)).toEqual(["b"]);
  });
});

describe("partitionThreadStacks", () => {
  it("keeps a stack together, matching only when every listed member matches", () => {
    const a = thread("a");
    const b = thread("b", { baseBranch: "a" });
    const c = thread("c", { baseBranch: "b" });
    const solo = thread("solo");
    const all = [a, b, c, solo];
    const parents = resolveThreadStackParents(all);
    const ids = (list: ReadonlyArray<StackableThread>) => list.map((t) => t.id);

    const oneIdle = partitionThreadStacks(all, parents, (t) => t !== c);
    expect(ids(oneIdle.matching)).toEqual(["solo"]);
    expect(ids(oneIdle.others)).toEqual(["a", "b", "c"]);

    const allWorking = partitionThreadStacks(all, parents, (t) => t !== solo);
    expect(ids(allWorking.matching)).toEqual(["a", "b", "c"]);
    expect(ids(allWorking.others)).toEqual(["solo"]);

    // A member in another section no longer ties its children to it.
    const withoutRoot = partitionThreadStacks([b, c], parents, (t) => t !== b);
    expect(ids(withoutRoot.others)).toEqual(["b", "c"]);
  });
});

describe("rankThreadStacks", () => {
  it("places each stack at its earliest member in the given order", () => {
    const a = thread("a");
    const b = thread("b", { baseBranch: "a" });
    const solo = thread("solo");
    const order = [b, solo, a];
    const parents = resolveThreadStackParents(order);
    const forest = buildThreadStackForest([solo, a, b], parents);
    expect(rankThreadStacks(forest, order).map((node) => node.thread.id)).toEqual(["a", "solo"]);
  });
});

describe("ownStackPullRequests", () => {
  it("drops pull requests opened from a branch another stack member owns", () => {
    const own = pr(1, "a", "main");
    const child = pr(2, "b", "a");
    const pending = { ...pr(3, "c", "a"), snapshot: null };
    expect(ownStackPullRequests([own, child, pending], new Set(["b"]))).toEqual([own, pending]);
    const links = [own, child];
    expect(ownStackPullRequests(links, new Set())).toBe(links);
  });
});
