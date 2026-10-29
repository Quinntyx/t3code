import {
  EnvironmentId,
  MessageId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2RunStatus,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { describe, expect, it } from "vite-plus/test";

import { v2Now, v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  type PrefetchThread,
  selectThreadsToPrefetch,
  startThreadPrefetch,
} from "./threadPrefetch.ts";
import { EMPTY_ENVIRONMENT_THREAD_STATE, type EnvironmentThreadState } from "./threadState.ts";

const environmentId = EnvironmentId.make("environment-1");
const offlineEnvironmentId = EnvironmentId.make("environment-2");

function thread(id: string, overrides: Partial<PrefetchThread> = {}): PrefetchThread {
  return {
    environmentId,
    id: ThreadId.make(id),
    archivedAt: null,
    deletedAt: null,
    settledOverride: null,
    lineage: { rootThreadId: ThreadId.make(id), parentThreadId: null, relationshipToParent: null },
    itemCount: 2,
    visibleItemCount: 2,
    updatedAt: "2026-10-01T00:00:00.000Z",
    latestRun: null,
    hasActionableProposedPlan: false,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    interactionMode: "default",
    runtime: null,
    ...overrides,
  };
}

function run(runId: string, status: OrchestrationV2RunStatus) {
  return {
    id: RunId.make(runId),
    threadId: v2Projection.thread.id,
    ordinal: 1,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    modelSelection: v2Projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${runId}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: v2Now,
    startedAt: v2Now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
}

const running = {
  status: "running" as const,
  activeRunId: null,
  providerInstanceId: ProviderInstanceId.make("codex"),
  providerName: "Codex",
  lastError: null,
  updatedAt: "2026-10-01T00:00:00.000Z",
};

describe("selectThreadsToPrefetch", () => {
  it("picks idle, unsettled threads on live environments, newest first", () => {
    const selected = selectThreadsToPrefetch(
      [
        thread("older", { updatedAt: "2026-10-01T00:00:00.000Z" }),
        thread("newer", { updatedAt: "2026-10-02T00:00:00.000Z" }),
        thread("approval", { runtime: running, hasPendingApprovals: true }),
        thread("working", { runtime: running }),
        thread("settled", { settledOverride: "settled" }),
        thread("archived", { archivedAt: "2026-10-01T00:00:00.000Z" }),
        thread("empty", { itemCount: 0, visibleItemCount: 0 }),
        thread("subagent", {
          lineage: {
            rootThreadId: ThreadId.make("newer"),
            parentThreadId: ThreadId.make("newer"),
            relationshipToParent: "subagent",
          },
        }),
        thread("offline", { environmentId: offlineEnvironmentId }),
      ],
      new Set([environmentId]),
    );
    expect(selected.map((candidate) => candidate.ref.threadId)).toEqual([
      "newer",
      "older",
      "approval",
    ]);
  });
});

type FakeThreadState = Pick<EnvironmentThreadState, "status" | "error"> & {
  readonly runs: ReadonlyArray<ReturnType<typeof run>>;
};

function harness(initial: ReadonlyArray<PrefetchThread>) {
  // The registry removes idle nodes in a scheduled task; the test runs those tasks itself.
  const tasks: Array<() => void> = [];
  const registry = AtomRegistry.make({
    scheduleTask: (task) => {
      tasks.push(task);
      return () => {};
    },
  });
  const flush = () => {
    for (let task = tasks.shift(); task !== undefined; task = tasks.shift()) task();
  };
  const threadsAtom = Atom.make<ReadonlyArray<PrefetchThread>>([]);
  const liveAtom = Atom.make<ReadonlySet<EnvironmentId>>(new Set([environmentId]));
  const mounted = new Set<string>();
  const loads: string[] = [];
  const sourceAtom = Atom.family((_threadId: ThreadId) =>
    Atom.make<FakeThreadState>({ status: "synchronizing", error: Option.none(), runs: [] }).pipe(
      Atom.keepAlive,
    ),
  );
  const stateFor = (state: FakeThreadState) =>
    AsyncResult.success({
      ...EMPTY_ENVIRONMENT_THREAD_STATE,
      status: state.status,
      error: state.error,
      data: Option.some({ ...v2Projection, runs: [...state.runs] }),
    });
  // Built once per mount, like a thread stream: source changes update it in place.
  const stateAtom = Atom.family((threadId: ThreadId) =>
    Atom.make((get) => {
      mounted.add(threadId);
      loads.push(threadId);
      get.addFinalizer(() => mounted.delete(threadId));
      get.subscribe(sourceAtom(threadId), (state) => get.setSelf(stateFor(state)));
      return stateFor(get.once(sourceAtom(threadId)));
    }),
  );
  const evicted: ScopedThreadRef[][] = [];
  const setState = (threadId: string, state: Partial<FakeThreadState>) =>
    registry.update(sourceAtom(ThreadId.make(threadId)), (previous) => ({
      ...previous,
      ...state,
    }));
  const start = () => {
    registry.set(threadsAtom, initial);
    return startThreadPrefetch({
      registry,
      threadsAtom,
      liveEnvironmentIdsAtom: liveAtom,
      stateAtom: (_environmentId, threadId) => stateAtom(threadId),
      evictCachedThreads: (threads) => evicted.push([...threads]),
    });
  };
  return {
    registry,
    threadsAtom,
    mounted,
    loads,
    evicted,
    setState,
    goLive: (threadId: string) => {
      setState(threadId, { status: "live" });
      flush();
    },
    flush,
    start,
  };
}

describe("startThreadPrefetch", () => {
  it("loads two threads at a time and lets each go once it is live", () => {
    const { mounted, goLive, start } = harness([
      thread("a", { updatedAt: "2026-10-03T00:00:00.000Z" }),
      thread("b", { updatedAt: "2026-10-02T00:00:00.000Z" }),
      thread("c", { updatedAt: "2026-10-01T00:00:00.000Z" }),
    ]);
    const stop = start();
    try {
      expect([...mounted]).toEqual(["a", "b"]);
      goLive("a");
      expect([...mounted].toSorted()).toEqual(["b", "c"]);
      goLive("b");
      goLive("c");
      expect(mounted.size).toBe(0);
    } finally {
      stop();
    }
  });

  it("holds a retained live copy until it shows the run the shell reports", () => {
    const { mounted, setState, flush, start } = harness([
      thread("a", {
        latestRun: {
          runId: RunId.make("r1"),
          status: "completed",
          requestedAt: null,
          startedAt: null,
          completedAt: null,
          assistantMessageId: null,
        },
      }),
    ]);
    // The previous visit closed while the run was still going.
    setState("a", { status: "live", runs: [run("r1", "running")] });
    const stop = start();
    try {
      expect([...mounted]).toEqual(["a"]);
      setState("a", { runs: [run("r1", "completed")] });
      flush();
      expect(mounted.size).toBe(0);
    } finally {
      stop();
    }
  });

  it("retries a failed load on the next shell change, and drops settled threads' caches", () => {
    const settled = thread("settled", { settledOverride: "settled" });
    const { registry, threadsAtom, mounted, loads, evicted, setState, goLive, flush, start } =
      harness([thread("a"), settled]);
    const stop = start();
    try {
      // Settled threads already on the list are swept once at start.
      expect(evicted).toEqual([[{ environmentId, threadId: "settled" }]]);
      setState("a", { error: Option.some("Could not synchronize the thread.") });
      flush();
      expect(mounted.size).toBe(0);

      setState("a", { error: Option.none() });
      registry.set(threadsAtom, [thread("a"), settled]);
      expect(loads).toEqual(["a", "a"]);
      goLive("a");
      registry.set(threadsAtom, [thread("a"), settled]);
      expect(loads).toEqual(["a", "a"]);

      registry.set(threadsAtom, [
        thread("a", { itemCount: 3, updatedAt: "2026-10-04T00:00:00.000Z" }),
        settled,
      ]);
      expect(loads).toEqual(["a", "a", "a"]);

      registry.set(threadsAtom, [thread("a", { settledOverride: "settled" }), settled]);
      flush();
      expect(mounted.size).toBe(0);
      expect(evicted.at(-1)).toEqual([{ environmentId, threadId: "a" }]);
    } finally {
      stop();
    }
  });
});
