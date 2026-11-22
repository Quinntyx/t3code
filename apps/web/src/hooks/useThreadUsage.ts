import { useAtomValue } from "@effect/atom-react";
import { threadUsageActive, threadUsageRevision } from "@t3tools/client-runtime/state/usage";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useQuietThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { revisionedQuery } from "../state/revisionedQuery";
import { serverEnvironment } from "../state/server";
import { environmentThreadShells } from "../state/threads";
import { useLiveRefresh } from "./useLiveRefresh";

const threadUsageRevisionAtom = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make((get) =>
    threadUsageRevision(
      ref.threadId,
      get(environmentThreadShells.environmentThreadsAtom(ref.environmentId)),
    ),
  ).pipe(Atom.withLabel(`web-thread-usage-revision:${key}`));
});

const threadUsageActiveAtom = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make((get) =>
    threadUsageActive(
      ref.threadId,
      get(environmentThreadShells.environmentThreadsAtom(ref.environmentId)),
    ),
  ).pipe(Atom.withLabel(`web-thread-usage-active:${key}`));
});

export function useThreadUsage(threadRef: ScopedThreadRef) {
  const shell = useQuietThreadShell(threadRef);
  const key = threadKey(threadRef);
  const revision = useAtomValue(threadUsageRevisionAtom(key));
  const active = useAtomValue(threadUsageActiveAtom(key));
  const query = useEnvironmentQuery(
    revisionedQuery(
      serverEnvironment.threadUsage({
        environmentId: threadRef.environmentId,
        input: { threadId: threadRef.threadId },
      }),
      revision,
    ),
  );
  // Running turns report usage as they go; re-read it while the family works.
  useLiveRefresh(query.refresh, {
    enabled: active,
    key: `thread-usage:${key}`,
    intervalMs: 30_000,
  });
  return { ...query, shell };
}
