import type { ScopedThreadRef } from "@t3tools/contracts";

import { useQuietThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { revisionedQuery } from "../state/revisionedQuery";
import { serverEnvironment } from "../state/server";

export function useThreadUsage(threadRef: ScopedThreadRef) {
  const shell = useQuietThreadShell(threadRef);
  // Delegates report back through the parent's runs, so its run state is enough to refetch on.
  const revision =
    shell === null
      ? undefined
      : [
          shell.latestRun?.runId,
          shell.latestRun?.status,
          shell.latestRun?.completedAt,
          shell.runtime?.status,
        ].join(":");
  const query = useEnvironmentQuery(
    revisionedQuery(
      serverEnvironment.threadUsage({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      }),
      revision,
    ),
  );
  return { ...query, shell };
}
