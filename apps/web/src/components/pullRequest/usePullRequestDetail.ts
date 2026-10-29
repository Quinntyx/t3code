import { resolvePullRequestDetailChecks } from "@t3tools/client-runtime/pull-request-checks";
import {
  AuthSourceControlWriteScope,
  type EnvironmentId,
  type ProjectId,
  type PullRequestListEntry,
  type PullRequestRef,
} from "@t3tools/contracts";
import { RegistryContext } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import { use, useEffect, useState } from "react";

import { usePullRequestChecksRefresh } from "~/hooks/usePullRequestChecksRefresh";
import { useProjects, useServerConfigs } from "~/state/entities";
import { useEnvironmentQuery } from "~/state/query";
import { useEnvironmentScope } from "~/state/session";
import {
  newestPullRequestSummary,
  pullRequestEnvironment,
  pullRequestListEntryToSummary,
  useSharedPullRequestSummary,
} from "~/state/pullRequests";
import {
  readPullRequestDetailSnapshot,
  resolveDisplayedPullRequestDetail,
  resolvePullRequestReference,
} from "./pullRequestDetail.logic";

export function pullRequestRefKey(reference: PullRequestRef) {
  return `${reference.projectId}:${reference.host ?? ""}:${reference.repository}#${reference.number}`;
}

/**
 * Loads what the thread's pull request panel reads once per thread open, so opening the
 * panel shows it at once. The reference resolves exactly as the panel's does. Its own
 * component, so project and config changes do not re-render the chat view.
 */
export function ThreadPullRequestPrefetch(props: {
  readonly environmentId: EnvironmentId | null;
  readonly target: {
    readonly projectId: string;
    readonly host?: string | undefined;
    readonly repository: string;
    readonly number: number;
  } | null;
}) {
  const { environmentId, target } = props;
  const registry = use(RegistryContext);
  const projects = useProjects();
  const serverConfigs = useServerConfigs();
  const reference =
    environmentId === null || target === null
      ? null
      : resolvePullRequestReference(
          {
            projectId: target.projectId as ProjectId,
            ...(target.host ? { host: target.host.toLowerCase() } : {}),
            repository: target.repository,
            number: target.number,
          },
          projects.find(
            (project) => project.id === target.projectId && project.environmentId === environmentId,
          )?.repositoryIdentity,
          serverConfigs.get(environmentId) !== undefined,
        );
  const referenceKey =
    environmentId === null || reference === null
      ? null
      : JSON.stringify([environmentId, reference]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- warms server queries in the shared atom registry, outside React
  useEffect(() => {
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `referenceKey` captures the reference, which is rebuilt every render.
    if (environmentId === null || reference === null) return;
    // Once, not mounted: mounted queries refetch on every source-control refresh.
    const controller = new AbortController();
    const options = { signal: controller.signal, reportFailure: false, reportDefect: false };
    void executeAtomQuery(
      registry,
      pullRequestEnvironment.detail({ environmentId, input: { ...reference, allowStale: false } }),
      options,
    );
    void executeAtomQuery(
      registry,
      pullRequestEnvironment.activity({ environmentId, input: reference }),
      options,
    );
    return () => controller.abort();
  }, [referenceKey, registry]);
  return null;
}

/**
 * Loads a pull request's detail and activity and merges them, with the snapshot cache, the shared
 * summary and the list row, into the detail the panel shows.
 */
export function usePullRequestDetail(
  environmentId: EnvironmentId,
  reference: PullRequestRef,
  listEntry: PullRequestListEntry | null,
) {
  const scopeKey = `${environmentId}:${pullRequestRefKey(reference)}`;
  const canWriteSourceControl = useEnvironmentScope(environmentId, AuthSourceControlWriteScope);
  const detailQuery = useEnvironmentQuery(
    pullRequestEnvironment.detail({ environmentId, input: { ...reference, allowStale: false } }),
  );
  const activityQuery = useEnvironmentQuery(
    pullRequestEnvironment.activity({ environmentId, input: reference }),
  );
  const serverConfigs = useServerConfigs();
  const supportsChecks =
    serverConfigs.get(environmentId)?.environment.capabilities.pullRequestChecks === true;
  const checksQuery = useEnvironmentQuery(
    supportsChecks && detailQuery.data !== null
      ? pullRequestEnvironment.checks({ environmentId, input: reference })
      : null,
  );
  const liveDetail = resolvePullRequestDetailChecks(
    detailQuery.data,
    checksQuery.data,
    checksQuery.dataUpdatedAt >= detailQuery.dataUpdatedAt,
  );
  usePullRequestChecksRefresh({
    refresh: () => {
      if (!checksQuery.isPending && !detailQuery.isPending) checksQuery.refresh();
    },
    enabled:
      liveDetail?.state === "open" &&
      supportsChecks &&
      !(checksQuery.isSuccess && checksQuery.data === null),
    key: `workspace-pr-checks:${environmentId}:${reference.projectId}:${reference.host}:${reference.repository}:${reference.number}`,
    checks: liveDetail?.checks ?? [],
  });
  const [cachedDetail, setCachedDetail] = useState(() =>
    readPullRequestDetailSnapshot(
      typeof window === "undefined" ? undefined : window.localStorage,
      environmentId,
      reference,
    ),
  );
  const [cachedDetailKey, setCachedDetailKey] = useState(scopeKey);
  if (cachedDetailKey !== scopeKey) {
    setCachedDetailKey(scopeKey);
    setCachedDetail(
      detailQuery.data ??
        readPullRequestDetailSnapshot(
          typeof window === "undefined" ? undefined : window.localStorage,
          environmentId,
          reference,
        ),
    );
  } else if (detailQuery.data !== null && detailQuery.data !== cachedDetail) {
    setCachedDetail(detailQuery.data);
  }
  const observedSummary = useSharedPullRequestSummary(environmentId, reference);
  const activity = activityQuery.data;
  const resolvedCoreDetail = resolveDisplayedPullRequestDetail({
    live: liveDetail,
    cached: cachedDetail,
    reference,
  });
  // Every hook runs above this line: a hook between the merge and the panel's plain readers of
  // `detail` would cost it its cache scope.
  const listSummary = listEntry === null ? null : pullRequestListEntryToSummary(listEntry);
  // The row can come from the page's stored snapshot, which no answer has published yet.
  const sharedSummary = newestPullRequestSummary(
    resolvedCoreDetail,
    newestPullRequestSummary(observedSummary, listSummary),
  );
  const coreDetail =
    resolvedCoreDetail === null || sharedSummary === null || sharedSummary === resolvedCoreDetail
      ? resolvedCoreDetail
      : {
          ...resolvedCoreDetail,
          title: sharedSummary.title,
          state: sharedSummary.state,
          headBranch: sharedSummary.headBranch,
          baseBranch: sharedSummary.baseBranch,
          updatedAt: sharedSummary.updatedAt,
          author: sharedSummary.author ?? resolvedCoreDetail.author,
          additions: sharedSummary.additions ?? resolvedCoreDetail.additions,
          deletions: sharedSummary.deletions ?? resolvedCoreDetail.deletions,
          changedFiles: sharedSummary.changedFiles ?? resolvedCoreDetail.changedFiles,
          mergeability: sharedSummary.mergeability ?? resolvedCoreDetail.mergeability,
          closedAt:
            sharedSummary.closedAt === undefined
              ? resolvedCoreDetail.closedAt
              : sharedSummary.closedAt,
          mergedAt:
            sharedSummary.mergedAt === undefined
              ? resolvedCoreDetail.mergedAt
              : sharedSummary.mergedAt,
          isDraft: sharedSummary.isDraft ?? resolvedCoreDetail.isDraft,
        };
  const detail =
    coreDetail === null
      ? null
      : {
          ...coreDetail,
          capabilities: canWriteSourceControl
            ? coreDetail.capabilities
            : {
                ...coreDetail.capabilities,
                reactions: false,
                edit: { changeRequest: false, comment: false },
              },
          viewerPermissions: canWriteSourceControl
            ? coreDetail.viewerPermissions
            : {
                ...coreDetail.viewerPermissions,
                actions: [],
                comment: false,
                resolve: false,
                verdicts: [],
                requestReviewers: false,
                updateMethods: [],
                labels: false,
              },
          author: activity?.author ?? coreDetail.author,
          reviewers: activity?.reviewers ?? coreDetail.reviewers,
          comments: activity?.comments ?? [],
          commentCount: Math.max(
            activity?.commentCount ?? 0,
            new Set([
              ...(activity?.comments.map((comment) => comment.id) ?? []),
              ...(activity?.reviewThreads.flatMap((thread) =>
                thread.comments.map((comment) => comment.id),
              ) ?? []),
            ]).size,
          ),
          commentsTruncated: activity?.commentsTruncated ?? false,
          reviewThreads: activity?.reviewThreads ?? [],
          commits: activity?.commits ?? [],
          reactions: activity?.reactions ?? [],
        };
  return {
    canWriteSourceControl,
    detailQuery,
    activityQuery,
    activity,
    sharedSummary,
    coreDetail,
    detail,
  };
}
