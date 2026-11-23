import * as Dialog from "../../../components/ui/Dialog";
import { useOpenPullRequest } from "../../../native/useOpenPullRequest";
import {
  type GitActionMenuItem,
  type GitActionRequestInput,
  type GitQuickAction,
  buildMenuItems,
  getGitActionDisabledReason,
  requiresDefaultBranchConfirmation,
  resolveQuickAction,
} from "@t3tools/client-runtime/state/vcs";
import type { ThreadRepositorySection } from "@t3tools/client-runtime/state/thread-repositories";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { CommonActions, StackActions, useNavigation } from "@react-navigation/native";
import { useGT, useMessages } from "gt-react-native";
import { use, useState } from "react";

import { changeRequestTermKind } from "../../../lib/changeRequestTerm";
import { filesystemEnvironment } from "../../../state/filesystem";
import { useEnvironmentQuery } from "../../../state/query";
import {
  gitRepositoryRouteParams,
  type GitRepositoryTarget,
} from "../../../state/thread-git-target";
import {
  unpinRepositoryFromThread,
  useThreadRepositoryPins,
} from "../../../state/thread-repository-pins";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { InspectorSheetContext } from "../../layout/workspace-inspector-sheet";
import { statusSummary } from "./gitSheetComponents";
import { useLinkedPullRequestLines } from "../LinkedPullRequestList";
import { useLinkedPullRequestActions } from "../useLinkedPullRequestActions";

export type GitOverview = ReturnType<typeof useGitOverview>;
type GitOverviewMenuItem = {
  readonly item: GitActionMenuItem;
  readonly disabledReason: string | null;
};

/**
 * Everything the Git overview surfaces read: the sheet route, the thread details pane and drawer.
 * `repository` names a tracked repository instead of the thread's own folder.
 */
export function useGitOverview(props: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly presentation: "sheet" | "inspector" | "drawer";
  readonly repository?: GitRepositoryTarget | undefined;
  readonly onNavigate?: (() => void) | undefined;
}) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const { presentation, onNavigate, repository } = props;
  const environmentId = EnvironmentId.make(props.environmentId);
  const threadId = ThreadId.make(props.threadId);
  const closeInspectorSheet = use(InspectorSheetContext);
  const presentRoute = (present: () => void) => {
    onNavigate?.();
    if (closeInspectorSheet) closeInspectorSheet(present);
    else present();
  };
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const openPullRequest = useOpenPullRequest({
    replace: presentation === "sheet",
    context: selectedThread ?? undefined,
  });
  const repositoryParams = gitRepositoryRouteParams(repository);
  const threadWorktree = useSelectedThreadWorktree();
  const { selectedThreadWorktreePath } = threadWorktree;
  const selectedThreadCwd = repository?.cwd ?? threadWorktree.selectedThreadCwd;
  const threadRef = { environmentId, threadId };
  const pinnedRepositories = useThreadRepositoryPins(threadRef);
  const isPinnedRepository =
    repository !== undefined &&
    pinnedRepositories.some((pin) => pin.repositoryPath === repository.key);
  const linkedPrLines = useLinkedPullRequestLines(selectedThread, selectedEnvironmentRuntime);
  const linkedPrActions = useLinkedPullRequestActions({
    thread: selectedThread,
    project: selectedThreadProject,
    runtime: selectedEnvironmentRuntime,
  });
  const gitState = useSelectedThreadGitState(repository);
  const gitActions = useSelectedThreadGitActions(repository);
  const { canWriteSourceControl, canChangeThreadBranch } = gitActions;

  const gitStatusQuery = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  );
  const gitStatus = gitStatusQuery.data;

  const isRepo = gitStatus?.isRepo ?? true;
  // A plain folder that tracks repositories has no branch of its own; its turns still have diffs.
  const projectRepositoryCount = selectedThreadProject?.trackedFolders?.length ?? 0;
  const trackedRepositoryCount = isRepo || repository !== undefined ? 0 : projectRepositoryCount;
  // A worktree thread reaches tracked repositories only through its own task folder.
  const taskFolderQuery = useEnvironmentQuery(
    selectedThread !== null && selectedThreadWorktreePath !== null && projectRepositoryCount > 0
      ? filesystemEnvironment.taskFolder({
          environmentId: selectedThread.environmentId,
          input: { worktreePath: selectedThreadWorktreePath },
        })
      : null,
  );
  const taskFolder = taskFolderQuery.data?.taskFolder ?? null;
  // Also for a project that tracks nothing: a thread can change a submodule.
  const listsRepositories = repository === undefined && selectedThreadProject !== null;
  const reachesTracked =
    projectRepositoryCount > 0 && (selectedThreadWorktreePath === null || taskFolder !== null);
  const currentBranchLabel =
    repository !== undefined
      ? repository.name
      : trackedRepositoryCount > 0
        ? // A task folder's plain project folder has no branch; its repositories are on the thread's.
          ((taskFolder === null ? null : selectedThread?.branch) ??
          selectedThreadProject?.title ??
          gt("Repositories"))
        : (gitStatus?.refName ?? selectedThread?.branch ?? gt("Detached HEAD"));
  const currentStatusSummary =
    repository !== undefined
      ? gitStatus?.isRepo
        ? `${gitStatus.refName ?? gt("Detached HEAD")} · ${statusSummary(gitStatus, m)}`
        : statusSummary(gitStatus, m)
      : taskFolder !== null && trackedRepositoryCount > 0
        ? gt(
            "{count, plural, one {{count} repository worktree} other {{count} repository worktrees}}",
            { count: taskFolder.repositories.length },
          )
        : trackedRepositoryCount > 0
          ? gt("{count, plural, one {{count} repository} other {{count} repositories}}", {
              count: trackedRepositoryCount,
            })
          : statusSummary(gitStatus, m);
  const worktreePath = repository === undefined ? selectedThreadWorktreePath : null;
  const busy = gitState.gitOperationLabel !== null;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const isDefaultRef = gitStatus?.isDefaultRef ?? false;
  const behindCount = gitStatus?.behindCount ?? 0;
  const terminology = sourceControlClients.get(
    gitStatus?.sourceControlProvider?.kind,
  ).changeRequest;
  const term = changeRequestTermKind(terminology);

  const resolvedQuickAction = resolveQuickAction(
    gitStatus ?? null,
    busy,
    isDefaultRef,
    hasPrimaryRemote,
    m,
  );
  const writeBlocked =
    !canWriteSourceControl &&
    (resolvedQuickAction.kind === "run_action" || resolvedQuickAction.kind === "run_pull");
  const quickAction: GitQuickAction = !isRepo
    ? {
        ...resolvedQuickAction,
        disabled: true,
        hint: gt("This workspace is not a git repository."),
      }
    : writeBlocked
      ? {
          ...resolvedQuickAction,
          disabled: true,
          hint: gt("This connection cannot change source control."),
        }
      : resolvedQuickAction;

  const menuItems = isRepo ? buildMenuItems(gitStatus ?? null, busy, hasPrimaryRemote, m) : [];

  const sheetMenuItems: GitOverviewMenuItem[] = menuItems.map((item) => {
    const itemWriteBlocked = !canWriteSourceControl && item.kind !== "open_pr";
    return {
      item: { ...item, disabled: item.disabled || itemWriteBlocked },
      disabledReason: itemWriteBlocked
        ? gt("This connection cannot change source control.")
        : getGitActionDisabledReason(
            {
              item,
              gitStatus: gitStatus ?? null,
              isBusy: busy,
              hasOriginRemote: hasPrimaryRemote,
            },
            m,
          ),
    };
  });

  const rowStatusDetail = (item: GitActionMenuItem): string | undefined => {
    const status = gitStatus ?? null;
    if (status == null) {
      return undefined;
    }
    if (item.dialogAction === "commit" && status.hasWorkingTreeChanges) {
      const fileCount = status.workingTree?.files.length ?? 0;
      return gt("{count, plural, one {{count} file changed} other {{count} files changed}}", {
        count: fileCount,
      });
    }
    if (item.dialogAction === "push" && (status.aheadCount ?? 0) > 0) {
      const ahead = status.aheadCount ?? 0;
      return gt("{count, plural, one {{count} commit ahead} other {{count} commits ahead}}", {
        count: ahead,
      });
    }
    if (item.kind === "open_pr" && status.pr?.number != null) {
      return gt(
        "{term, select, mr {MR #{number} {state, select, open {open} closed {closed} merged {merged} other {{state}}}} cr {change request #{number} {state, select, open {open} closed {closed} merged {merged} other {{state}}}} other {PR #{number} {state, select, open {open} closed {closed} merged {merged} other {{state}}}}}",
        {
          term,
          number: status.pr.number,
          state: status.pr.state ?? "open",
        },
      );
    }
    return undefined;
  };

  const openLinkedPullRequest = async (url: string) => {
    onNavigate?.();
    return openPullRequest(url);
  };

  const openUrl = async (url: string) => {
    if (!(await openLinkedPullRequest(url))) {
      Dialog.alert(
        gt(
          "{term, select, mr {Unable to open MR} cr {Unable to open change request} other {Unable to open PR}}",
          { term },
        ),
        gt(
          "{term, select, mr {The merge request could not be opened.} cr {The change request could not be opened.} other {The pull request could not be opened.}}",
          { term },
        ),
      );
    }
  };

  const openExistingPr = async () => {
    const prUrl = gitStatus?.pr?.state === "open" ? gitStatus.pr.url : null;
    if (!prUrl) {
      Dialog.alert(
        gt("{term, select, mr {No open MR} cr {No open change request} other {No open PR}}", {
          term,
        }),
        gt(
          "{term, select, mr {This branch does not have an open merge request.} cr {This branch does not have an open change request.} other {This branch does not have an open pull request.}}",
          { term },
        ),
      );
      return;
    }
    await openUrl(prUrl);
  };

  const runActionWithPrompt = async (input: GitActionRequestInput) => {
    if (!canWriteSourceControl) return;
    const confirmableAction =
      input.action === "push" ||
      input.action === "create_pr" ||
      input.action === "commit_push" ||
      input.action === "commit_push_pr"
        ? input.action
        : null;
    const branchName = gitStatus?.refName;
    if (
      branchName &&
      confirmableAction &&
      !input.featureBranch &&
      requiresDefaultBranchConfirmation(input.action, isDefaultRef)
    ) {
      presentRoute(() =>
        navigation.navigate("GitConfirm", {
          environmentId: String(environmentId),
          threadId: String(threadId),
          ...repositoryParams,
          confirmAction: confirmableAction,
          branchName,
          includesCommit: String(
            input.action === "commit_push" || input.action === "commit_push_pr",
          ),
        }),
      );
      return;
    }

    // Close a sheet so the thread shows the action's progress.
    if (presentation === "sheet") navigation.goBack();
    else closeInspectorSheet?.();
    await gitActions.onRunSelectedThreadGitAction(input);
  };

  const runQuickAction = async () => {
    if (quickAction.disabled) return;
    if (quickAction.kind === "open_pr") {
      await openExistingPr();
    } else if (quickAction.kind === "run_pull") {
      await gitActions.onPullSelectedThreadBranch();
    } else if (quickAction.kind === "run_action" && quickAction.action) {
      await runActionWithPrompt({ action: quickAction.action });
    }
  };

  const onPressMenuItem = async (item: GitActionMenuItem) => {
    if (item.disabled) return;
    if (item.kind === "open_pr") {
      await openExistingPr();
      return;
    }
    if (!canWriteSourceControl) return;
    if (item.dialogAction === "commit") {
      presentRoute(() =>
        navigation.navigate("GitCommit", {
          environmentId: String(environmentId),
          threadId: String(threadId),
          ...repositoryParams,
        }),
      );
      return;
    }
    if (item.dialogAction === "push") {
      await runActionWithPrompt({ action: "push" });
      return;
    }
    if (item.dialogAction === "create_pr") {
      await runActionWithPrompt({ action: "create_pr" });
    }
  };

  const openRepository = (section: ThreadRepositorySection) => {
    const params = {
      environmentId: String(environmentId),
      threadId: String(threadId),
      repositoryCwd: section.cwd,
      repositoryName: section.name,
    };
    // A sheet swaps in place, so closing the repository or running an action lands on the thread.
    if (presentation === "sheet") {
      navigation.dispatch(StackActions.replace("GitOverview", params));
    } else {
      presentRoute(() => navigation.dispatch(StackActions.push("GitOverview", params)));
    }
  };

  const unpinRepository = () => {
    if (repository === undefined) return;
    unpinRepositoryFromThread(threadRef, repository.key);
    navigation.goBack();
  };

  const openReview = () => {
    const params = { environmentId, threadId };
    if (presentation === "sheet") {
      onNavigate?.();
      navigation.dispatch(StackActions.replace("ThreadReview", params));
    } else {
      presentRoute(() => navigation.dispatch(CommonActions.navigate("ThreadReview", params)));
    }
  };

  const openBranches = () =>
    presentRoute(() =>
      navigation.navigate("GitBranches", {
        environmentId: String(environmentId),
        threadId: String(threadId),
      }),
    );

  // Background refreshes also report pending; using that query flag would stick the RefreshControl spinner.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refresh = async () => {
    setIsRefreshing(true);
    await gitActions.refreshSelectedThreadGitStatus();
    setIsRefreshing(false);
  };

  return {
    gitStatus: gitStatus ?? null,
    isRepo,
    trackedRepositoryCount,
    taskFolder,
    refreshTaskFolder: taskFolderQuery.refresh,
    listsRepositories,
    reachesTracked,
    projectId: selectedThreadProject?.id ?? null,
    selectedThreadCwd,
    worktreePath,
    threadRef,
    repository,
    isPinnedRepository,
    unpinRepository,
    currentBranchLabel,
    currentStatusSummary,
    busy,
    behindCount,
    canWriteSourceControl,
    canChangeThreadBranch,
    sheetMenuItems,
    rowStatusDetail,
    onPressMenuItem,
    quickAction,
    runQuickAction,
    pull: () => void gitActions.onPullSelectedThreadBranch(),
    refreshSelectedThreadGitStatus: gitActions.refreshSelectedThreadGitStatus,
    openRepository,
    openReview,
    openBranches,
    openLinkedPullRequest,
    openPullRequest,
    isRefreshing,
    refresh,
    linkedPrLines,
    linkedPrActions,
  };
}
