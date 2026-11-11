import { useAtomValue } from "@effect/atom-react";
import { threadUsageRevision } from "@t3tools/client-runtime/state/usage";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useQuietThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { revisionedQuery } from "../state/revisionedQuery";
import { serverEnvironment } from "../state/server";
import { environmentThreadShells } from "../state/threads";

const threadUsageRevisionAtom = Atom.family((key: string) => {
  const ref = parseThreadKey(key);
  return Atom.make((get) =>
    threadUsageRevision(
      ref.threadId,
      get(environmentThreadShells.environmentThreadsAtom(ref.environmentId)),
    ),
  ).pipe(Atom.withLabel(`web-thread-usage-revision:${key}`));
});

export function useThreadUsage(threadRef: ScopedThreadRef) {
  const shell = useQuietThreadShell(threadRef);
  const revision = useAtomValue(threadUsageRevisionAtom(threadKey(threadRef)));
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
