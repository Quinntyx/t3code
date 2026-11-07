import { EnvironmentId, ProjectId, ThreadId, type ContextMenuItem } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { ThreadPullRequestContextMenuAction } from "./threadPullRequestContextMenu";

const state = vi.hoisted(() => ({
  effects: [] as string[],
  supportsInPlaceConfirm: true,
  show: vi.fn<
    (
      items: ReadonlyArray<ContextMenuItem<ThreadPullRequestContextMenuAction>>,
      position: { x: number; y: number },
    ) => Promise<ThreadPullRequestContextMenuAction | null>
  >(),
  confirm: vi.fn<(message: string) => Promise<boolean>>(),
  newThread: vi.fn<(projectRef: unknown, options: unknown) => Promise<unknown>>(),
}));

function recordEffect(action: string) {
  state.effects.push(action);
}

vi.mock("~/localApi", () => ({
  readLocalApi: () => ({
    contextMenu: {
      supportsInPlaceConfirm: state.supportsInPlaceConfirm,
      show: state.show,
      close: () => {},
    },
    dialogs: { confirm: state.confirm },
  }),
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: { get: () => true } }));
vi.mock("~/state/pullRequests", () => ({
  pullRequestEnvironment: { runAction: { permissionAtom: () => "run-action-permission" } },
}));
vi.mock("~/hooks/useHandleNewThread", () => ({
  useNewThreadHandler: () => state.newThread,
}));
vi.mock("~/lib/openPullRequestLink", () => ({
  openChangeRequestInRightPanel: () => {
    recordEffect("open-in-panel");
    return true;
  },
}));
vi.mock("../ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: () => undefined },
}));
vi.mock("./usePullRequestActions", () => ({
  usePullRequestActionRunner: () => ({
    actionPending: false,
    perform: async (action: string) => recordEffect(action),
  }),
  readPullRequestDefaultMergeMethod: () => undefined,
  resolvePullRequestMergeMethodForDetail: () => "squash",
}));

import { useThreadPullRequestContextMenu } from "./useThreadPullRequestContextMenu";

const threadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const projectId = ProjectId.make("project");
const position = { x: 10, y: 20 };
const target = {
  reference: {
    projectId,
    host: "github.com",
    repository: "acme/widgets",
    number: 42,
  },
  url: "https://github.com/acme/widgets/pull/42",
  state: "open" as const,
  isDraft: false,
  headBranch: "feat/widgets",
  stacked: false,
};

const openMenu = () =>
  useThreadPullRequestContextMenu({
    threadRef,
    projectId,
    target,
    onOpenedInPanel: () => recordEffect("activated"),
  })(position);

beforeEach(() => {
  state.effects = [];
  state.supportsInPlaceConfirm = true;
  state.show.mockReset().mockResolvedValue(null);
  state.confirm.mockReset().mockResolvedValue(true);
  state.newThread.mockReset().mockImplementation(async () => {
    recordEffect("draft");
    return { draftId: "draft", threadId: "thread" };
  });
});

describe("thread pull request context menu", () => {
  it("lets the app's own menu confirm the merge in place", async () => {
    state.show.mockResolvedValueOnce("merge");
    await openMenu();
    expect(state.show.mock.calls[0]?.[0]).toContainEqual(
      expect.objectContaining({ id: "merge", confirmLabel: "Confirm merge?" }),
    );
    expect(state.confirm).not.toHaveBeenCalled();
    expect(state.effects).toEqual(["merge"]);
  });

  it("asks in a dialog where the OS draws the menu", async () => {
    state.supportsInPlaceConfirm = false;
    state.show.mockResolvedValueOnce("merge");
    await openMenu();
    const mergeItem = state.show.mock.calls[0]?.[0].find((item) => item.id === "merge");
    expect(mergeItem).not.toHaveProperty("confirmLabel");
    expect(state.confirm).toHaveBeenCalledWith("Merge pull request #42?");
    expect(state.effects).toEqual(["merge"]);
  });

  it("drops a merge the dialog does not confirm", async () => {
    state.supportsInPlaceConfirm = false;
    state.show.mockResolvedValueOnce("merge");
    state.confirm.mockResolvedValueOnce(false);
    await openMenu();
    expect(state.effects).toEqual([]);
  });

  it("stacks a new thread on the pull request's branch", async () => {
    state.show.mockResolvedValueOnce("stack");
    await openMenu();
    expect(state.effects).toEqual(["draft"]);
    expect(state.newThread).toHaveBeenCalledWith(
      { environmentId: threadRef.environmentId, projectId },
      { branch: "feat/widgets", envMode: "worktree", startFromOrigin: true },
    );
  });

  it("opens the pull request in the right panel and activates its thread", async () => {
    state.show.mockResolvedValueOnce("open-in-panel");
    await openMenu();
    expect(state.effects).toEqual(["open-in-panel", "activated"]);
  });
});
