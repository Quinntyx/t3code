// @effect-diagnostics globalTimers:off - The prefetch deadline runs in web and native clients, outside an Effect runtime.
import type {
  EnvironmentId,
  OrchestrationV2RunStatus,
  RunId,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, type Atom, type AtomRegistry } from "effect/reactivity";

import { scopedThreadKey } from "../environment/scoped.ts";
import type { EnvironmentThreadShell } from "./models.ts";
import { isThreadWorking } from "./threadInbox.ts";
import type { EnvironmentThreadState } from "./threadState.ts";

const PREFETCH_LIMIT = 24;
const PREFETCH_CONCURRENCY = 2;
const PREFETCH_DEADLINE_MS = 60_000;

export type PrefetchThread = Parameters<typeof isThreadWorking>[0] &
  Pick<
    EnvironmentThreadShell,
    | "environmentId"
    | "id"
    | "archivedAt"
    | "deletedAt"
    | "settledOverride"
    | "lineage"
    | "itemCount"
    | "visibleItemCount"
    | "updatedAt"
  >;

export interface ThreadPrefetchCandidate {
  readonly key: string;
  readonly ref: ScopedThreadRef;
  /** Changes whenever the thread's content may have changed since the last prefetch. */
  readonly fingerprint: string;
  /** The run the shell reports last, which the loaded detail must already reflect. */
  readonly latestRun: { readonly runId: RunId; readonly active: boolean } | null;
}

const ACTIVE_RUN_STATUSES: ReadonlySet<OrchestrationV2RunStatus> = new Set([
  "preparing",
  "queued",
  "starting",
  "running",
  "waiting",
]);

/**
 * Idle threads that still want the user: not running and not settled. Their content
 * rarely changes until the user acts, so one prefetch stays good until the shell moves.
 */
export function selectThreadsToPrefetch(
  threads: ReadonlyArray<PrefetchThread>,
  liveEnvironmentIds: ReadonlySet<EnvironmentId>,
): ReadonlyArray<ThreadPrefetchCandidate> {
  return threads
    .filter(
      (thread) =>
        liveEnvironmentIds.has(thread.environmentId) &&
        thread.archivedAt === null &&
        thread.deletedAt === null &&
        thread.settledOverride !== "settled" &&
        thread.lineage.relationshipToParent !== "subagent" &&
        thread.visibleItemCount > 0 &&
        !isThreadWorking(thread),
    )
    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
    .slice(0, PREFETCH_LIMIT)
    .map((thread) => {
      const ref = { environmentId: thread.environmentId, threadId: thread.id };
      return {
        key: scopedThreadKey(ref),
        ref,
        fingerprint: `${thread.updatedAt}\u0000${thread.itemCount}`,
        latestRun:
          thread.latestRun === null
            ? null
            : {
                runId: thread.latestRun.runId,
                active: ACTIVE_RUN_STATUSES.has(thread.latestRun.status),
              },
      };
    });
}

type PrefetchOutcome = "loaded" | "failed" | "pending";

// A thread reopened within its resume window replays its retained state as "live" before
// the new subscription catches up, so "live" counts only once it shows the shell's run.
function prefetchOutcome<E>(
  result: AsyncResult.AsyncResult<EnvironmentThreadState, E>,
  candidate: ThreadPrefetchCandidate,
): PrefetchOutcome {
  if (AsyncResult.isFailure(result)) return "failed";
  if (!AsyncResult.isSuccess(result)) return "pending";
  const { status, error, data } = result.value;
  if (status === "deleted") return "loaded";
  if (Option.isSome(error)) return "failed";
  if (status !== "live" || Option.isNone(data)) return "pending";
  const expected = candidate.latestRun;
  if (expected === null) return "loaded";
  const run = data.value.runs.find((entry) => entry.id === expected.runId);
  return run !== undefined && ACTIVE_RUN_STATUSES.has(run.status) === expected.active
    ? "loaded"
    : "pending";
}

/**
 * Loads attention threads in the background until each is live, then lets it go: the
 * thread's own scope persists it on release, so opening it later reads a warm cache and
 * catches up by sequence. Threads that settle drop their persisted copy instead.
 */
export function startThreadPrefetch<E>(input: {
  readonly registry: AtomRegistry.AtomRegistry;
  readonly threadsAtom: Atom.Atom<ReadonlyArray<PrefetchThread>>;
  readonly liveEnvironmentIdsAtom: Atom.Atom<ReadonlySet<EnvironmentId>>;
  readonly stateAtom: (
    environmentId: EnvironmentId,
    threadId: ThreadId,
  ) => Atom.Atom<AsyncResult.AsyncResult<EnvironmentThreadState, E>>;
  readonly evictCachedThreads: (threads: ReadonlyArray<ScopedThreadRef>) => void;
}): () => void {
  const { registry } = input;
  const prefetched = new Map<string, string>();
  const active = new Map<string, { candidate: ThreadPrefetchCandidate; release: () => void }>();
  let queue: ThreadPrefetchCandidate[] = [];
  let settled: ReadonlySet<string> | null = null;
  let disposed = false;

  // A failed or stalled load stays unrecorded, so the next shell or connection change retries it.
  const finish = (key: string, loaded: boolean) => {
    const entry = active.get(key);
    if (entry === undefined) return;
    active.delete(key);
    entry.release();
    if (loaded) prefetched.set(key, entry.candidate.fingerprint);
    pump();
  };

  const settle = (key: string, result: AsyncResult.AsyncResult<EnvironmentThreadState, E>) => {
    const entry = active.get(key);
    if (entry === undefined) return;
    const outcome = prefetchOutcome(result, entry.candidate);
    if (outcome !== "pending") finish(key, outcome === "loaded");
  };

  const start = (candidate: ThreadPrefetchCandidate) => {
    const atom = input.stateAtom(candidate.ref.environmentId, candidate.ref.threadId);
    const unsubscribe = registry.subscribe(atom, (result) => settle(candidate.key, result));
    // A thread that never goes live (a stalled socket) must not hold a slot forever.
    const deadline = setTimeout(() => finish(candidate.key, false), PREFETCH_DEADLINE_MS);
    active.set(candidate.key, {
      candidate,
      release: () => {
        clearTimeout(deadline);
        unsubscribe();
      },
    });
    // Already caught up, e.g. open in the client right now.
    settle(candidate.key, registry.get(atom));
  };

  function pump() {
    if (disposed) return;
    while (active.size < PREFETCH_CONCURRENCY) {
      const next = queue.shift();
      if (next === undefined) return;
      if (!active.has(next.key)) start(next);
    }
  }

  const update = () => {
    const threads = registry.get(input.threadsAtom);

    const nextSettled = new Set<string>();
    const newlySettled: ScopedThreadRef[] = [];
    for (const thread of threads) {
      if (thread.settledOverride !== "settled") continue;
      const ref = { environmentId: thread.environmentId, threadId: thread.id };
      const key = scopedThreadKey(ref);
      nextSettled.add(key);
      if (settled?.has(key) !== true) {
        newlySettled.push(ref);
        prefetched.delete(key);
      }
    }
    settled = nextSettled;

    const wanted = new Map(
      selectThreadsToPrefetch(threads, registry.get(input.liveEnvironmentIdsAtom)).map(
        (candidate) => [candidate.key, candidate],
      ),
    );
    for (const [key, entry] of active) {
      const candidate = wanted.get(key);
      if (candidate === undefined) {
        active.delete(key);
        entry.release();
      } else {
        entry.candidate = candidate;
      }
    }
    // After releasing, so a prefetch closing on settle usually saves before the removal; a
    // save that still lands later is swept at the next start, like a thread open on settle.
    if (newlySettled.length > 0) input.evictCachedThreads(newlySettled);
    queue = [...wanted.values()].filter(
      (candidate) =>
        !active.has(candidate.key) && prefetched.get(candidate.key) !== candidate.fingerprint,
    );
    pump();
  };

  const unsubscribes = [
    registry.subscribe(input.threadsAtom, update),
    registry.subscribe(input.liveEnvironmentIdsAtom, update),
  ];
  update();
  return () => {
    disposed = true;
    for (const unsubscribe of unsubscribes) unsubscribe();
    for (const entry of active.values()) entry.release();
    active.clear();
  };
}
