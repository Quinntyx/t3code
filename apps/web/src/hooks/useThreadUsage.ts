import { useAtomValue } from "@effect/atom-react";
import { threadUsageRevision } from "@t3tools/client-runtime/state/usage";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { useQuietThreadShell } from "../state/entities";
import { useEnvironmentQuery } from "../state/query";
import { revisionedQuery } from "../state/revisionedQuery";
import { serverEnvironment } from "../state/server";
import { environmentThreadShells } from "../state/threads";

export function useThreadUsage(threadRef: ScopedThreadRef) {
  const shell = useQuietThreadShell(threadRef);
  const revisionAtom = Atom.make((get) =>
    threadUsageRevision(
      threadRef.threadId,
      get(environmentThreadShells.environmentThreadsAtom(threadRef.environmentId)),
    ),
  );
  const revision = useAtomValue(revisionAtom);
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
