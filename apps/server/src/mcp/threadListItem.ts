import type { OrchestrationV2ThreadShell, OrchestratorMcpThreadListItem } from "@t3tools/contracts";
import { backgroundWorkHoldsCompletion } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { threadPullRequestUpdatedAtMs } from "@t3tools/shared/threadPullRequests";
import * as DateTime from "effect/DateTime";

import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import {
  normalizeThreadPullRequestKey,
  visibleThreadPullRequests,
} from "../sourceControl/threadPullRequests.ts";
import { type McpInvocationScope, threadLinkFor } from "./McpInvocationContext.ts";

const THREAD_PULL_REQUEST_PREVIEW_LIMIT = 5;

/**
 * The status an agent reads. A stalled thread's failed run is retried by the server, so it
 * reports the work it is still doing instead of an ending that never happened.
 */
export function agentVisibleThreadStatus(input: {
  readonly status: OrchestratorMcpThreadListItem["status"];
  readonly stalled: OrchestrationV2ThreadShell["stalled"];
}): OrchestratorMcpThreadListItem["status"] {
  return input.stalled === true ? "running" : input.status;
}

export function threadSettlement(
  thread: Pick<OrchestrationV2ThreadShell, "settledOverride" | "settledAt">,
): Pick<OrchestratorMcpThreadListItem, "settled" | "settledAt"> {
  const settled = thread.settledOverride === "settled";
  return {
    settled,
    settledAt: settled && thread.settledAt !== null ? DateTime.formatIso(thread.settledAt) : null,
  };
}

export function threadSnooze(
  thread: Parameters<typeof isSnoozed>[0],
  nowMs: number,
): Pick<OrchestratorMcpThreadListItem, "snoozed" | "snoozedUntil"> {
  const snoozed = isSnoozed(thread, nowMs);
  return {
    snoozed,
    snoozedUntil:
      snoozed && thread.snoozedUntil != null ? DateTime.formatIso(thread.snoozedUntil) : null,
  };
}

// Provider-internal links (parentTaskId, providerInstanceId) stay out of agent results.
export function threadBackgroundWork(
  thread: Pick<OrchestrationV2ThreadShell, "blockedOnThreadWait" | "pendingBackgroundTasks">,
): Required<Pick<OrchestratorMcpThreadListItem, "blockedOnThreadWait" | "pendingBackgroundTasks">> {
  return {
    blockedOnThreadWait: thread.blockedOnThreadWait === true,
    pendingBackgroundTasks: (thread.pendingBackgroundTasks ?? []).map((task) => ({
      taskId: task.taskId,
      kind: task.kind,
      ...(task.description === undefined ? {} : { description: task.description }),
      ...(task.awaited === undefined ? {} : { awaited: task.awaited }),
      ...(task.kind === "subagent" && task.childThreadId !== undefined
        ? { childThreadId: task.childThreadId }
        : {}),
    })),
  };
}

export function threadPullRequests(
  links: OrchestrationV2ThreadShell["pullRequests"],
  includeLinks = true,
): Pick<
  OrchestratorMcpThreadListItem,
  "pullRequests" | "pullRequestCount" | "openPullRequestCount"
> {
  const visible = visibleThreadPullRequests(links ?? []);
  if (!includeLinks) return { pullRequestCount: visible.length };
  const open = visible.filter(
    (link) => link.snapshot?.state !== "merged" && link.snapshot?.state !== "closed",
  );
  return {
    pullRequests: open
      .toSorted(
        (left, right) =>
          Number(right.watch !== undefined) - Number(left.watch !== undefined) ||
          threadPullRequestUpdatedAtMs(right) - threadPullRequestUpdatedAtMs(left),
      )
      .slice(0, THREAD_PULL_REQUEST_PREVIEW_LIMIT)
      .map((link) => ({
        host: normalizeThreadPullRequestKey(link).host,
        repository: link.repository,
        number: link.number,
        url: link.url,
        source: link.source,
        state: link.snapshot?.state ?? null,
        watching: link.watch !== undefined,
        watchStartedAt: link.watch?.startedAt ?? null,
      })),
    pullRequestCount: visible.length,
    openPullRequestCount: open.length,
  };
}

// Awaited background work keeps a thread live after its turn ends, as auto-settle and the sidebar treat it.
export function threadStatus(
  activeStatus: OrchestratorMcpThreadListItem["status"] | null | undefined,
  settledStatus: OrchestratorMcpThreadListItem["status"],
  pendingBackgroundTasks: OrchestrationV2ThreadShell["pendingBackgroundTasks"],
) {
  if (activeStatus != null) return activeStatus;
  if (settledStatus === "failed") return settledStatus;
  return backgroundWorkHoldsCompletion(pendingBackgroundTasks ?? []) ? "waiting" : settledStatus;
}

export function listedThreadStatus(shell: OrchestrationV2ThreadShell) {
  return agentVisibleThreadStatus({
    status: threadStatus(shell.activityRunStatus, shell.status, shell.pendingBackgroundTasks),
    stalled: shell.stalled,
  });
}

export function threadListItemFromShell(
  scope: McpInvocationScope,
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
): OrchestratorMcpThreadListItem {
  return {
    threadId: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    link: threadLinkFor(scope, shell.id, shell.title),
    createdBy: shell.createdBy,
    creationSource: shell.creationSource,
    status: listedThreadStatus(shell),
    latestRunId: shell.latestRunId,
    providerInstanceId: shell.modelSelection.instanceId,
    model: shell.modelSelection.model,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    linkedPullRequest: shell.linkedPullRequest ?? null,
    ...threadPullRequests(shell.pullRequests),
    ...threadSettlement(shell),
    ...threadSnooze(shell, nowMs),
    pinned: shell.pinnedAt != null,
    ...threadBackgroundWork(shell),
    parentThreadId: shell.lineage.parentThreadId,
    relationshipToParent: shell.lineage.relationshipToParent,
    ...(shell.delegatedFrom == null ? {} : { delegatedFrom: shell.delegatedFrom }),
    itemCount: shell.visibleItemCount,
    createdAt: DateTime.formatIso(shell.createdAt),
    updatedAt: DateTime.formatIso(shell.updatedAt),
  };
}
