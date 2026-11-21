import { ProjectId, type ThreadPullRequestLink } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { describe, expect, it } from "vite-plus/test";

import {
  buildThreadPullRequestContextMenuItems,
  resolveThreadPullRequestContextMenuTarget,
} from "./threadPullRequestContextMenu";

const projectId = ProjectId.make("project");
const terminology = sourceControlClients.get("github").changeRequest;

function link(overrides: Partial<ThreadPullRequestLink> = {}): ThreadPullRequestLink {
  return {
    host: "github.com",
    repository: "acme/widgets",
    number: 42,
    url: "https://github.com/acme/widgets/pull/42",
    source: "manual",
    linkedAt: "2026-01-01T00:00:00.000Z",
    snapshot: {
      state: "open",
      title: "Stack the widgets",
      headBranch: "feat/widgets",
      baseBranch: "main",
      isDraft: false,
      updatedAt: null,
      syncedAt: "2026-01-01T00:00:00.000Z",
    },
    stack: null,
    ...overrides,
  };
}

describe("resolveThreadPullRequestContextMenuTarget", () => {
  it("targets the current link through its snapshot", () => {
    expect(
      resolveThreadPullRequestContextMenuTarget({
        projectId,
        links: [link()],
        pr: null,
        branchPullRequest: null,
      }),
    ).toEqual({
      reference: { projectId, host: "github.com", repository: "acme/widgets", number: 42 },
      url: "https://github.com/acme/widgets/pull/42",
      state: "open",
      isDraft: false,
      headBranch: "feat/widgets",
      stacked: false,
    });
  });

  it("falls back to the live status while a link has no snapshot", () => {
    expect(
      resolveThreadPullRequestContextMenuTarget({
        projectId,
        links: [link({ snapshot: null })],
        pr: {
          number: 42,
          url: "https://github.com/acme/widgets/pull/42",
          state: "open",
          isDraft: true,
          headRef: "feat/widgets",
        },
        branchPullRequest: null,
      }),
    ).toMatchObject({ state: "open", isDraft: true, headBranch: "feat/widgets" });
  });

  it("targets a branch pull request that was never linked", () => {
    expect(
      resolveThreadPullRequestContextMenuTarget({
        projectId,
        links: [],
        pr: {
          number: 7,
          url: "https://github.com/acme/widgets/pull/7",
          state: "open",
          headRef: "feat/branch",
        },
        branchPullRequest: {
          projectId,
          repository: "acme/widgets",
          number: 7,
          url: "https://github.com/acme/widgets/pull/7",
        },
      }),
    ).toEqual({
      reference: { projectId, repository: "acme/widgets", number: 7 },
      url: "https://github.com/acme/widgets/pull/7",
      state: "open",
      isDraft: false,
      headBranch: "feat/branch",
      stacked: false,
    });
  });

  it("has nothing to act on without a link or a branch pull request", () => {
    expect(
      resolveThreadPullRequestContextMenuTarget({
        projectId,
        links: [],
        pr: null,
        branchPullRequest: null,
      }),
    ).toBeNull();
  });
});

describe("buildThreadPullRequestContextMenuItems", () => {
  it("offers the viewer, merge, and stacking on the pull request's branch", () => {
    expect(
      buildThreadPullRequestContextMenuItems({
        terminology,
        headBranch: "feat/widgets",
        canMerge: true,
        confirmMergeInPlace: true,
      }).map((item) => [item.id, item.label]),
    ).toEqual([
      ["open-in-panel", "Open in PR viewer"],
      ["merge", "Merge pull request"],
      ["stack", "Stack a new thread on feat/widgets"],
    ]);
  });

  it("asks again in place only where the app draws the menu", () => {
    const mergeItem = (confirmMergeInPlace: boolean) =>
      buildThreadPullRequestContextMenuItems({
        terminology,
        headBranch: null,
        canMerge: true,
        confirmMergeInPlace,
      }).find((item) => item.id === "merge");

    expect(mergeItem(true)).toMatchObject({
      label: "Merge pull request",
      confirmLabel: "Confirm merge?",
    });
    expect(mergeItem(false)).not.toHaveProperty("confirmLabel");
  });

  it("drops merge when the pull request cannot merge", () => {
    expect(
      buildThreadPullRequestContextMenuItems({
        terminology,
        headBranch: "feat/widgets",
        canMerge: false,
        confirmMergeInPlace: true,
      }).map((item) => item.id),
    ).toEqual(["open-in-panel", "stack"]);
  });
});
