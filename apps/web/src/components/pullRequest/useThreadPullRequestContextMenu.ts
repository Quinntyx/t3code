import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { settlePromise, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ProjectId, ScopedThreadRef } from "@t3tools/contracts";

import { useNewThreadHandler } from "~/hooks/useHandleNewThread";
import { openChangeRequestInRightPanel } from "~/lib/openPullRequestLink";
import { readLocalApi } from "~/localApi";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { pullRequestEnvironment } from "~/state/pullRequests";

import { stackedThreadToast, toastManager } from "../ui/toast";
import {
  buildThreadPullRequestContextMenuItems,
  type ThreadPullRequestContextMenuAction,
  type ThreadPullRequestContextMenuTarget,
} from "./threadPullRequestContextMenu";
import {
  readPullRequestDefaultMergeMethod,
  resolvePullRequestMergeMethodForDetail,
  usePullRequestActionRunner,
} from "./usePullRequestActions";

/**
 * The menu a thread row's pull request badge opens instead of the thread's own. Merge asks
 * twice: the app's own menu arms the item in place, an OS menu asks in a dialog.
 */
export function useThreadPullRequestContextMenu({
  threadRef,
  projectId,
  target,
  onOpenedInPanel,
}: {
  threadRef: ScopedThreadRef;
  projectId: ProjectId;
  target: ThreadPullRequestContextMenuTarget | null;
  onOpenedInPanel: () => void;
}): (position: { readonly x: number; readonly y: number }) => Promise<void> {
  const newThread = useNewThreadHandler();
  const terminology = (
    (target === null ? null : sourceControlClients.findByChangeRequestUrl(target.url)) ??
    sourceControlClients.get(undefined)
  ).changeRequest;
  const { perform } = usePullRequestActionRunner({
    environmentId: threadRef.environmentId,
    reference: target?.reference ?? null,
    terminology,
    resolveMergeMethod: (detail) =>
      resolvePullRequestMergeMethodForDetail(
        detail,
        readPullRequestDefaultMergeMethod(threadRef.environmentId, projectId),
      ),
  });

  return async (position) => {
    if (target === null) return;
    const api = readLocalApi();
    if (!api) return;
    const canMerge =
      target.state === "open" &&
      !target.isDraft &&
      !target.stacked &&
      appAtomRegistry.get(pullRequestEnvironment.runAction.permissionAtom(threadRef.environmentId));
    let clicked: ThreadPullRequestContextMenuAction | null = null;
    try {
      clicked = await api.contextMenu.show(
        buildThreadPullRequestContextMenuItems({
          terminology,
          headBranch: target.headBranch,
          canMerge,
          confirmMergeInPlace: api.contextMenu.supportsInPlaceConfirm,
        }),
        position,
      );
    } catch {
      return;
    }
    switch (clicked) {
      case "open-in-panel":
        if (openChangeRequestInRightPanel({ threadRef, url: target.url })) onOpenedInPanel();
        return;
      case "merge": {
        const confirmed =
          api.contextMenu.supportsInPlaceConfirm ||
          (await api.dialogs.confirm(`Merge ${terminology.singular} #${target.reference.number}?`));
        if (confirmed) await perform("merge");
        return;
      }
      case "stack": {
        if (target.headBranch === null) return;
        // The head may live only on the host, so the new worktree resolves it from origin.
        const result = await settlePromise(() =>
          newThread(scopeProjectRef(threadRef.environmentId, target.reference.projectId), {
            branch: target.headBranch,
            envMode: "worktree",
            startFromOrigin: true,
          }),
        );
        if (result._tag === "Failure") {
          const failure: unknown = squashAtomCommandFailure(result);
          toastManager.add(
            stackedThreadToast({
              type: "error",
              title: "Could not create thread",
              description: failure instanceof Error ? failure.message : "An error occurred.",
            }),
          );
        }
        return;
      }
      default:
        return;
    }
  };
}
