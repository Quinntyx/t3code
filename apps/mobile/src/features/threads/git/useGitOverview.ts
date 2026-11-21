import * as Dialog from "../../../components/ui/Dialog";
import { useOpenPullRequest } from "../../../native/useOpenPullRequest";
import {
  type GitActionRequestInput,
  buildMenuItems,
  getGitActionDisabledReason,
  requiresDefaultBranchConfirmation,
  resolveQuickAction,
} from "@t3tools/client-runtime/state/vcs";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { CommonActions, StackActions, useNavigation } from "@react-navigation/native";
import { useGT, useMessages } from "gt-react-native";
import { use, useState } from "react";

import { changeRequestTermKind } from "../../../lib/changeRequestTerm";
import { useEnvironmentQuery } from "../../../state/query";
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
type GitMenuItem = ReturnType<typeof buildMenuItems>[number];

export function useGitOverview(props: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly presentation: "sheet" | "inspector" | "drawer";
  readonly onNavigate?: () => void;
}) {
  const gt = useGT();
  const m = useMessages();
  const navigation = useNavigation();
  const { presentation, onNavigate } = props;
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

  const currentBranchLabel = gitStatus?.refName ?? selectedThread?.branch ?? gt("Detached HEAD");
  const busy = gitState.gitOperationLabel !== null;
  const isRepo = gitStatus?.isRepo ?? true;
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
  const quickAction = !isRepo
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

  const rowStatusDetail = (item: GitMenuItem): string | undefined => {
    if (gitStatus == null) return undefined;
    if (item.dialogAction === "commit" && gitStatus.hasWorkingTreeChanges) {
      const fileCount = gitStatus.workingTree?.files.length ?? 0;
      return gt("{count, plural, one {{count} file changed} other {{count} files changed}}", {
        count: fileCount,
      });
    }
    if (item.dialogAction === "push" && (gitStatus.aheadCount ?? 0) > 0) {
      const ahead = gitStatus.aheadCount ?? 0;
      return gt("{count, plural, one {{count} commit ahead} other {{count} commits ahead}}", {
        count: ahead,
      });
    }
    if (item.kind === "open_pr" && gitStatus.pr?.number != null) {
      return gt(
        "{term, select, mr {MR #{number} {state, select, open {open} closed {closed} merged {merged} other {{state}}}} cr {change request #{number} {state, select, open {open} closed {closed} merged {merged} other {{state}}}} other {PR #{number} {state, select, open {open} closed {closed} merged {merged} other {{state}}}}}",
        {
          term,
          number: gitStatus.pr.number,
          state: gitStatus.pr.state ?? "open",
        },
      );
    }
    return undefined;
  };

  const menuItems = (
    isRepo ? buildMenuItems(gitStatus ?? null, busy, hasPrimaryRemote, m) : []
  ).map((item) => {
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
      statusDetail: rowStatusDetail(item),
    };
  });

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
          confirmAction: confirmableAction,
          branchName,
          includesCommit: String(
            (input.action === "commit_push" || input.action === "commit_push_pr") &&
              !!gitStatus?.hasWorkingTreeChanges,
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

  const onPressMenuItem = async (item: GitMenuItem) => {
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
    currentBranchLabel,
    currentStatusSummary: statusSummary(gitStatus ?? null, m),
    worktreePath: selectedThreadWorktreePath,
    terminology,
    busy,
    isRepo,
    behindCount,
    canWriteSourceControl,
    canChangeThreadBranch,
    menuItems,
    onPressMenuItem,
    quickAction,
    runQuickAction,
    pull: () => void gitActions.onPullSelectedThreadBranch(),
    openReview,
    openBranches,
    openUrl,
    openLinkedPullRequest,
    isRefreshing,
    refresh,
    linkedPrLines,
    linkedPrActions,
  };
}
