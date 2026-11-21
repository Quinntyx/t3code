import { RegistryContext, useAtomValue } from "@effect/atom-react";
import { executeAtomQuery } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { use, useEffect } from "react";

import { nativePullRequestDestination } from "../../lib/pullRequestNavigation";
import { useProjects } from "../../state/entities";
import { composerPullRequests } from "../../state/pull-requests";
import { environmentServerConfigsAtom } from "../../state/server";
import { resolveThreadPrSource } from "../../state/thread-pr-presentation";
import { pullRequestTarget } from "./usePullRequestDiff";

/**
 * Loads what the pull request screen reads once per thread open, so opening it shows the
 * pull request at once. The target resolves exactly as the thread's PR badge opens it.
 * Its own component, so project and config changes do not re-render the thread route.
 */
export function ThreadPullRequestPrefetch(props: { readonly thread: EnvironmentThreadShell }) {
  const { thread } = props;
  const registry = use(RegistryContext);
  const projects = useProjects();
  const serverConfigs = useAtomValue(environmentServerConfigsAtom);
  const { linkedPresentation, pullRequestRef } = resolveThreadPrSource(
    {
      pullRequests: thread.pullRequests,
      linkedPullRequest: thread.linkedPullRequest,
      branchPullRequest: thread.branchPullRequest,
    },
    serverConfigs.has(thread.environmentId),
  );
  const url = linkedPresentation?.url ?? pullRequestRef?.url ?? null;
  const params =
    url === null
      ? null
      : nativePullRequestDestination(
          url,
          { environmentId: String(thread.environmentId), projectId: String(thread.projectId) },
          projects,
          (environmentId) => serverConfigs.has(environmentId),
        );
  const paramsKey = params === null ? null : JSON.stringify(params);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- warms server queries in the shared atom registry, outside React
  useEffect(() => {
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- `paramsKey` captures the params, which are rebuilt every render.
    if (params === null) return;
    // Once, not mounted: mounted queries refetch on every source-control refresh.
    const target = pullRequestTarget(params);
    const controller = new AbortController();
    const options = { signal: controller.signal, reportFailure: false, reportDefect: false };
    void executeAtomQuery(registry, composerPullRequests.detail(target), options);
    void executeAtomQuery(registry, composerPullRequests.activity(target), options);
    return () => controller.abort();
  }, [paramsKey, registry]);
  return null;
}
