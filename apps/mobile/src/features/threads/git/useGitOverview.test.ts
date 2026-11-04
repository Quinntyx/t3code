import type { VcsStatusResult } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  status: null as VcsStatusResult | null,
  canWrite: true,
  busy: false,
  navigate: vi.fn(),
  runAction: vi.fn(),
  pull: vi.fn(),
  openPr: vi.fn(async () => true),
}));

vi.mock("react", () => ({ useState: (value: unknown) => [value, () => {}] }));
vi.mock("@react-navigation/native", () => ({
  useNavigation: () => ({ navigate: state.navigate }),
}));
vi.mock("../../../components/ui/Dialog", () => ({ alert: vi.fn() }));
vi.mock("../../../native/useOpenPullRequest", () => ({ useOpenPullRequest: () => state.openPr }));
vi.mock("../../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: { id: "thread", environmentId: "environment", branch: "feature" },
    selectedThreadProject: null,
    selectedEnvironmentRuntime: null,
  }),
}));
vi.mock("../../../state/use-selected-thread-worktree", () => ({
  useSelectedThreadWorktree: () => ({
    selectedThreadCwd: "/repo",
    selectedThreadWorktreePath: null,
  }),
}));
vi.mock("../../../state/use-selected-thread-git-state", () => ({
  useSelectedThreadGitState: () => ({ gitOperationLabel: state.busy ? "Committing" : null }),
}));
vi.mock("../../../state/use-selected-thread-git-actions", () => ({
  useSelectedThreadGitActions: () => ({
    canWriteSourceControl: state.canWrite,
    canChangeThreadBranch: state.canWrite,
    onRunSelectedThreadGitAction: state.runAction,
    onPullSelectedThreadBranch: state.pull,
  }),
}));
vi.mock("../../../state/query", () => ({ useEnvironmentQuery: () => ({ data: state.status }) }));
vi.mock("../../../state/vcs", () => ({ vcsEnvironment: { status: () => null } }));
vi.mock("./gitSheetComponents", () => ({ statusSummary: () => "" }));
vi.mock("../LinkedPullRequestList", () => ({ useLinkedPullRequestLines: () => [] }));
vi.mock("../useLinkedPullRequestActions", () => ({ useLinkedPullRequestActions: () => ({}) }));

import { useGitOverview } from "./useGitOverview";

function overview() {
  return useGitOverview({
    environmentId: "environment",
    threadId: "thread",
    presentation: "drawer",
  });
}

describe("drawer Git quick action", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    state.canWrite = true;
    state.busy = false;
    state.status = {
      isRepo: true,
      hasPrimaryRemote: true,
      isDefaultRef: false,
      refName: "feature",
      hasWorkingTreeChanges: true,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      pr: null,
    };
  });

  it.each([
    {
      hasWorkingTreeChanges: true,
      aheadCount: 0,
      label: "Commit, push & PR",
      action: "commit_push_pr",
    },
    { hasWorkingTreeChanges: false, aheadCount: 1, label: "Push & create PR", action: "create_pr" },
  ])(
    "runs $label as one stacked action",
    async ({ hasWorkingTreeChanges, aheadCount, label, action }) => {
      state.status = { ...state.status!, hasWorkingTreeChanges, aheadCount };
      const git = overview();
      expect(git.quickAction).toMatchObject({ label, disabled: false });
      await git.runQuickAction();
      expect(state.runAction).toHaveBeenCalledExactlyOnceWith({ action });
      expect(state.navigate).not.toHaveBeenCalled();
    },
  );

  it.each([
    { hasWorkingTreeChanges: true, aheadCount: 0, includesCommit: "true" },
    { hasWorkingTreeChanges: false, aheadCount: 1, includesCommit: "false" },
  ])(
    "keeps accurate default-branch confirmation with includesCommit=$includesCommit",
    async ({ hasWorkingTreeChanges, aheadCount, includesCommit }) => {
      state.status = {
        ...state.status!,
        isDefaultRef: true,
        refName: "main",
        hasWorkingTreeChanges,
        aheadCount,
      };
      await overview().runQuickAction();
      expect(state.runAction).not.toHaveBeenCalled();
      expect(state.navigate).toHaveBeenCalledExactlyOnceWith("GitConfirm", {
        environmentId: "environment",
        threadId: "thread",
        confirmAction: "commit_push",
        branchName: "main",
        includesCommit,
      });
    },
  );

  it.each(["read-only", "busy", "missing status", "not a repo", "clean"] as const)(
    "does not run a disabled action: %s",
    async (reason) => {
      if (reason === "read-only") state.canWrite = false;
      if (reason === "busy") state.busy = true;
      if (reason === "missing status") state.status = null;
      if (reason === "not a repo") state.status = { ...state.status!, isRepo: false };
      if (reason === "clean") state.status = { ...state.status!, hasWorkingTreeChanges: false };
      const git = overview();
      expect(git.quickAction.disabled).toBe(true);
      await git.runQuickAction();
      expect(state.runAction).not.toHaveBeenCalled();
      expect(state.pull).not.toHaveBeenCalled();
    },
  );

  it("pulls when behind and still opens the branch PR on a read-only connection", async () => {
    state.status = { ...state.status!, hasWorkingTreeChanges: false, behindCount: 1 };
    await overview().runQuickAction();
    expect(state.pull).toHaveBeenCalledOnce();
    state.canWrite = false;
    state.status = {
      ...state.status,
      behindCount: 0,
      pr: {
        number: 1,
        title: "Feature",
        url: "https://example.com/pr/1",
        state: "open",
        baseRef: "main",
        headRef: "feature",
      },
    };
    const git = overview();
    expect(git.quickAction).toMatchObject({ label: "View PR", disabled: false });
    await git.runQuickAction();
    expect(state.openPr).toHaveBeenCalledExactlyOnceWith("https://example.com/pr/1");
    expect(state.runAction).not.toHaveBeenCalled();
  });
});
