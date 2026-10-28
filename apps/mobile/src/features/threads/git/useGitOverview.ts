import * as Dialog from "../../../components/ui/Dialog";
import { useOpenPullRequest } from "../../../native/useOpenPullRequest";
import {
  type GitActionRequestInput,
  buildMenuItems,
  getGitActionDisabledReason,
  requiresDefaultBranchConfirmation,
} from "@t3tools/client-runtime/state/vcs";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { CommonActions, StackActions, useNavigation } from "@react-navigation/native";
import { useState } from "react";

import { useEnvironmentQuery } from "../../../state/query";
import { useThreadSelection } from "../../../state/use-thread-selection";
import { useSelectedThreadGitActions } from "../../../state/use-selected-thread-git-actions";
import { useSelectedThreadGitState } from "../../../state/use-selected-thread-git-state";
import { useSelectedThreadWorktree } from "../../../state/use-selected-thread-worktree";
import { vcsEnvironment } from "../../../state/vcs";
import { resolveGitOverviewReviewNavigationAction } from "./git-overview-navigation";
import { statusSummary } from "./gitSheetComponents";
import { useLinkedPullRequestLines } from "../LinkedPullRequestList";
import { useLinkedPullRequestActions } from "../useLinkedPullRequestActions";

export type GitOverview = ReturnType<typeof useGitOverview>;
type GitMenuItem = ReturnType<typeof buildMenuItems>[number];

export function useGitOverview(props: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly presentation: "sheet" | "inspector" | "drawer";
  readonly onNavigate?: () => void;
}) {
  const navigation = useNavigation();
  const { presentation, onNavigate } = props;
  const environmentId = EnvironmentId.make(props.environmentId);
  const threadId = ThreadId.make(props.threadId);
  const { selectedThread, selectedThreadProject, selectedEnvironmentRuntime } =
    useThreadSelection();
  const openPullRequest = useOpenPullRequest({
    replace: presentation === "sheet",
    context: selectedThread ?? undefined,
  });
  const { selectedThreadCwd, selectedThreadWorktreePath } = useSelectedThreadWorktree();
  const linkedPrLines = useLinkedPullRequestLines(selectedThread, selectedEnvironmentRuntime);
  const linkedPrActions = useLinkedPullRequestActions({
    thread: selectedThread,
    project: selectedThreadProject,
    runtime: selectedEnvironmentRuntime,
  });
  const gitState = useSelectedThreadGitState();
  const gitActions = useSelectedThreadGitActions();
  const { canWriteSourceControl, canChangeThreadBranch } = gitActions;

  const gitStatus = useEnvironmentQuery(
    selectedThread !== null && selectedThreadCwd !== null
      ? vcsEnvironment.status({
          environmentId: selectedThread.environmentId,
          input: { cwd: selectedThreadCwd },
        })
      : null,
  ).data;

  const currentBranchLabel = gitStatus?.refName ?? selectedThread?.branch ?? "Detached HEAD";
  const busy = gitState.gitOperationLabel !== null;
  const isRepo = gitStatus?.isRepo ?? true;
  const hasPrimaryRemote = gitStatus?.hasPrimaryRemote ?? false;
  const isDefaultRef = gitStatus?.isDefaultRef ?? false;
  const behindCount = gitStatus?.behindCount ?? 0;
  const terminology = sourceControlClients.get(
    gitStatus?.sourceControlProvider?.kind,
  ).changeRequest;
  const { shortLabel, singular } = terminology;

  const rowStatusDetail = (item: GitMenuItem): string | undefined => {
    if (gitStatus == null) return undefined;
    if (item.dialogAction === "commit" && gitStatus.hasWorkingTreeChanges) {
      const fileCount = gitStatus.workingTree?.files.length ?? 0;
      return `${fileCount} file${fileCount === 1 ? "" : "s"} changed`;
    }
    if (item.dialogAction === "push" && (gitStatus.aheadCount ?? 0) > 0) {
      const ahead = gitStatus.aheadCount ?? 0;
      return `${ahead} commit${ahead === 1 ? "" : "s"} ahead`;
    }
    if (item.kind === "open_pr" && gitStatus.pr?.number != null) {
      return `${shortLabel} #${gitStatus.pr.number} ${gitStatus.pr.state ?? "open"}`;
    }
    return undefined;
  };

  const menuItems = (isRepo ? buildMenuItems(gitStatus ?? null, busy, hasPrimaryRemote) : []).map(
    (item) => {
      const writeBlocked = !canWriteSourceControl && item.kind !== "open_pr";
      return {
        item: { ...item, disabled: item.disabled || writeBlocked },
        disabledReason: writeBlocked
          ? "This connection cannot change source control."
          : getGitActionDisabledReason({
              item,
              gitStatus: gitStatus ?? null,
              isBusy: busy,
              hasOriginRemote: hasPrimaryRemote,
            }),
        statusDetail: rowStatusDetail(item),
      };
    },
  );

  const openLinkedPullRequest = async (url: string) => {
    onNavigate?.();
    return openPullRequest(url);
  };

  const openUrl = async (url: string) => {
    if (!(await openLinkedPullRequest(url))) {
      Dialog.alert(`Unable to open ${shortLabel}`, `The ${singular} could not be opened.`);
    }
  };

  const openExistingPr = async () => {
    const prUrl = gitStatus?.pr?.state === "open" ? gitStatus.pr.url : null;
    if (!prUrl) {
      Dialog.alert(`No open ${shortLabel}`, `This branch does not have an open ${singular}.`);
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
      onNavigate?.();
      navigation.navigate("GitConfirm", {
        environmentId: String(environmentId),
        threadId: String(threadId),
        confirmAction: confirmableAction,
        branchName,
        includesCommit: String(input.action === "commit_push" || input.action === "commit_push_pr"),
      });
      return;
    }

    if (presentation === "sheet") {
      navigation.goBack();
    }
    await gitActions.onRunSelectedThreadGitAction(input);
  };

  const onPressMenuItem = async (item: GitMenuItem) => {
    if (item.disabled) return;
    if (item.kind === "open_pr") {
      await openExistingPr();
      return;
    }
    if (!canWriteSourceControl) return;
    if (item.dialogAction === "commit") {
      onNavigate?.();
      navigation.navigate("GitCommit", {
        environmentId: String(environmentId),
        threadId: String(threadId),
      });
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

  const openReview = () => {
    onNavigate?.();
    const params = { environmentId, threadId };
    navigation.dispatch(
      resolveGitOverviewReviewNavigationAction(
        presentation === "drawer" ? "inspector" : presentation,
      ) === "replace"
        ? StackActions.replace("ThreadReview", params)
        : CommonActions.navigate("ThreadReview", params),
    );
  };

  // Background refreshes also report pending; using that query flag would stick the RefreshControl spinner.
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refresh = async () => {
    setIsRefreshing(true);
    await gitActions.refreshSelectedThreadGitStatus();
    setIsRefreshing(false);
  };

  return {
    gitStatus: gitStatus ?? null,
    currentBranchLabel,
    currentStatusSummary: statusSummary(gitStatus ?? null),
    worktreePath: selectedThreadWorktreePath,
    terminology,
    busy,
    isRepo,
    behindCount,
    canWriteSourceControl,
    canChangeThreadBranch,
    menuItems,
    onPressMenuItem,
    pull: () => void gitActions.onPullSelectedThreadBranch(),
    openReview,
    openUrl,
    openLinkedPullRequest,
    isRefreshing,
    refresh,
    linkedPrLines,
    linkedPrActions,
  };
}
