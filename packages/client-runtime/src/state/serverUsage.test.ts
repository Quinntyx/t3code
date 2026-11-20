import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageDay,
  UsageReadError,
  USAGE_CONTRACT_VERSION,
  WS_METHODS,
  type ServerConfig,
  type ServerConfigStreamEvent,
  ServerSettings,
  ThreadId,
  type ThreadUsage,
  type UsageSource,
  type UsageSummary,
  type UsageSummaryInput,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";

import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
  type SupervisorConnectionState,
} from "../connection/model.ts";
import * as EnvironmentRegistry from "../connection/registry.ts";
import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import * as Persistence from "../platform/persistence.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import { createServerEnvironmentAtoms } from "./server.ts";

const TARGET = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("usage-environment"),
  label: "Usage environment",
  httpBaseUrl: "https://environment.example.test",
  wsBaseUrl: "wss://environment.example.test",
});

const INPUT: UsageSummaryInput = {
  sinceDay: UsageDay.make("2026-09-01"),
  untilDay: UsageDay.make("2026-09-04"),
  timeZone: "UTC",
};

const CONFIG = {
  settings: DEFAULT_SERVER_SETTINGS,
  environment: { serverVersion: "0.0.1", capabilities: {} },
} as ServerConfig;

const PRICING = { status: "unavailable" as const, source: "test", fetchedAt: null, knownModels: 0 };

const cursorSource = (refreshing: boolean): UsageSource => ({
  fingerprint: {
    hostId: "cursor.com",
    provider: "cursor",
    resolvedHomePath: "cursor-account:abc",
    volumeId: "abc",
  },
  status: "ok",
  scannedFiles: 1,
  skippedFiles: 0,
  malformedRecords: 0,
  distinctSessions: 1,
  message: null,
  ...(refreshing ? { refreshing: true as const } : {}),
});

const sameServerSettings = Schema.toEquivalence(ServerSettings);

const makeHarness = Effect.fn("ServerUsageTest.makeHarness")(function* (
  beforeRead: (
    request: number,
    input: UsageSummaryInput,
  ) => Effect.Effect<void, UsageReadError> = () => Effect.void,
  sources: (input: UsageSummaryInput) => readonly UsageSource[] = () => [],
  defaultIdleTTL?: number,
) {
  const events = yield* Queue.unbounded<ServerConfigStreamEvent>();
  const threadUsageRequested = yield* Queue.unbounded<ThreadId>();
  let settings = DEFAULT_SERVER_SETTINGS;
  let requests = 0;
  let threadUsageRequests = 0;
  const threadUsageRequestIds: ThreadId[] = [];
  const inputs: UsageSummaryInput[] = [];
  const client = {
    [WS_METHODS.serverRefreshUsageRates]: () => Effect.succeed(PRICING),
    [WS_METHODS.subscribeServerConfig]: () =>
      Stream.concat(
        Stream.make({
          version: 1 as const,
          type: "snapshot" as const,
          config: { ...CONFIG, settings },
        }),
        Stream.fromQueue(events),
      ),
    [WS_METHODS.serverGetUsageSummary]: (input: UsageSummaryInput) =>
      Effect.gen(function* () {
        requests += 1;
        inputs.push(input);
        const price = settings.usagePriceOverrides["custom-model"]?.inputCostPerMillionTokens ?? 0;
        yield* beforeRead(requests, input);
        return {
          contractVersion: USAGE_CONTRACT_VERSION,
          readAt: "2026-09-04T12:00:00Z",
          ...input,
          buckets: [
            {
              day: input.sinceDay,
              provider: "codex",
              model: "custom-model",
              totals: {
                uncachedInputTokens: 1_000_000,
                cachedInputTokens: 0,
                cacheCreationTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
              },
              costUsd: price,
              cacheSavingsUsd: 0,
              costSource: price === 0 ? "unpriced" : "modelPriced",
              records: 1,
              unpricedRecords: price === 0 ? 1 : 0,
              sessions: 1,
            },
          ],
          sources: sources(input),
          pricing: PRICING,
          scanDurationMs: 0,
        } satisfies UsageSummary;
      }),
    [WS_METHODS.serverGetThreadUsage]: (input: { readonly threadId: ThreadId }) =>
      Effect.gen(function* () {
        threadUsageRequests += 1;
        threadUsageRequestIds.push(input.threadId);
        yield* Queue.offer(threadUsageRequested, input.threadId);
        const price =
          settings.usagePriceOverrides["custom-model"]?.inputCostPerMillionTokens ?? null;
        return {
          startedAt: "2026-09-04T12:00:00Z",
          bucketMs: 60_000,
          models: [
            {
              providerInstanceId: ProviderInstanceId.make("codex"),
              driver: ProviderDriverKind.make("codex"),
              model: "custom-model",
              group: "main" as const,
              threads: 1,
              tokens: {
                uncachedInputTokens: 1_000_000,
                cachedInputTokens: 0,
                cacheCreationTokens: 0,
                outputTokens: 0,
                reasoningTokens: 0,
              },
              totalTokens: 1_000_000,
              costUsd: price,
            },
          ],
          series: [],
          compactedAt: [],
        } satisfies ThreadUsage;
      }),
  } as unknown as WsRpcProtocolClient;
  const makeSession = (): RpcSession => ({
    client,
    initialConfig: Effect.succeed(CONFIG),
    subscribeServerConfig: (input = {}) => client.subscribeServerConfig(input),
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  });
  let generation = 1;
  const supervisorState = yield* SubscriptionRef.make<SupervisorConnectionState>({
    ...AVAILABLE_CONNECTION_STATE,
    phase: "connected",
    generation,
  });
  const supervisorSession = yield* SubscriptionRef.make(Option.some(makeSession()));
  const supervisor = EnvironmentSupervisor.EnvironmentSupervisor.of({
    target: TARGET,
    state: supervisorState,
    session: supervisorSession,
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  const environments = EnvironmentRegistry.EnvironmentRegistry.of({
    run: (_environmentId, effect) =>
      Effect.provideService(effect, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
    followStream: (_environmentId, stream) =>
      Stream.provideService(stream, EnvironmentSupervisor.EnvironmentSupervisor, supervisor),
  } as EnvironmentRegistry.EnvironmentRegistry["Service"]);
  const cache = Persistence.EnvironmentCacheStore.of({
    loadShell: () => Effect.succeedNone,
    saveShell: () => Effect.void,
    loadThread: () => Effect.succeedNone,
    saveThread: () => Effect.void,
    removeThread: () => Effect.void,
    loadServerConfig: () => Effect.succeedNone,
    saveServerConfig: () => Effect.void,
    loadVcsRefs: () => Effect.succeedNone,
    saveVcsRefs: () => Effect.void,
    removeVcsRefs: () => Effect.void,
    clearVcsRefs: () => Effect.void,
    clear: () => Effect.void,
  });
  const runtime = Atom.runtime(
    Layer.merge(
      Layer.succeed(EnvironmentRegistry.EnvironmentRegistry, environments),
      Layer.succeed(Persistence.EnvironmentCacheStore, cache),
    ),
  );
  const initialConfigValueAtom = Atom.make(CONFIG);
  const atoms = createServerEnvironmentAtoms(runtime, {
    initialConfigValueAtom: () => initialConfigValueAtom,
  });
  const registry = yield* Effect.acquireRelease(
    Effect.sync(() =>
      AtomRegistry.make(defaultIdleTTL === undefined ? undefined : { defaultIdleTTL }),
    ),
    (registry) => Effect.sync(() => registry.dispose()),
  );
  const updateSettings = Effect.fn("ServerUsageTest.updateSettings")(function* (
    next: ServerSettings,
  ) {
    settings = next;
    yield* Queue.offer(events, {
      version: 1,
      type: "settingsUpdated",
      payload: { settings },
    });
    // An equal settings document keeps the previous object, so match on content.
    yield* AtomRegistry.toStream(registry, atoms.settingsValueAtom(TARGET.environmentId)).pipe(
      Stream.filter((current) => current !== null && sameServerSettings(current, next)),
      Stream.runHead,
    );
  });
  const reconnect = Effect.fn("ServerUsageTest.reconnect")(function* () {
    yield* SubscriptionRef.set(supervisorState, {
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connecting" as const,
      generation,
    });
    yield* SubscriptionRef.set(supervisorSession, Option.none());
    generation += 1;
    yield* SubscriptionRef.set(supervisorSession, Option.some(makeSession()));
    yield* SubscriptionRef.set(supervisorState, {
      ...AVAILABLE_CONNECTION_STATE,
      phase: "connected" as const,
      generation,
    });
  });
  return {
    registry,
    atoms,
    requests: () => requests,
    inputs: () => inputs,
    updateSettings,
    reconnect,
    summary: (input = INPUT) => atoms.usageSummary({ environmentId: TARGET.environmentId, input }),
    threadUsage: (threadId: ThreadId) =>
      atoms.threadUsage({ environmentId: TARGET.environmentId, input: { threadId } }),
    threadUsageRequests: () => threadUsageRequests,
    threadUsageRequestIds: () => threadUsageRequestIds,
    threadUsageRequested,
  };
});

function settledSummary<E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<UsageSummary, E>>,
) {
  return AtomRegistry.toStream(registry, atom).pipe(
    Stream.filterMap((result) =>
      AsyncResult.isSuccess(result) && !result.waiting
        ? Result.succeed(result.value)
        : Result.failVoid,
    ),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
}

function waitForThreadCost<E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<ThreadUsage, E>>,
  cost: number | null,
) {
  return AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter(
      (result) =>
        AsyncResult.isSuccess(result) &&
        !result.waiting &&
        result.value.models[0]?.costUsd === cost,
    ),
    Stream.runHead,
  );
}

const makeRefreshingHarness = Effect.fn("ServerUsageTest.makeRefreshingHarness")(function* (
  followUp: Effect.Effect<void, UsageReadError>,
) {
  const followUpStarted = yield* Deferred.make<void>();
  const harness = yield* makeHarness(
    (_request, input) =>
      input.awaitRefresh === true
        ? Deferred.succeed(followUpStarted, undefined).pipe(Effect.andThen(followUp))
        : Effect.void,
    (input) => [cursorSource(input.awaitRefresh !== true)],
  );
  return { ...harness, followUpStarted };
});

function waitForCost<E>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<AsyncResult.AsyncResult<UsageSummary, E>>,
  cost: number,
) {
  return AtomRegistry.toStream(registry, atom).pipe(
    Stream.filter(
      (result) =>
        AsyncResult.isSuccess(result) &&
        !result.waiting &&
        result.value.buckets[0]?.costUsd === cost,
    ),
    Stream.runHead,
  );
}

it.effect("restarts a pending usage read after a price change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const started = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();
      const harness = yield* makeHarness((request) =>
        request === 1
          ? Deferred.succeed(started, undefined).pipe(
              Effect.andThen(Effect.never),
              Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
            )
          : Effect.void,
      );
      const summary = harness.summary();
      const unmount = harness.registry.mount(summary);
      yield* Deferred.await(started);
      yield* harness.updateSettings({
        ...DEFAULT_SERVER_SETTINGS,
        usagePriceOverrides: {
          "custom-model": { inputCostPerMillionTokens: 5, outputCostPerMillionTokens: 10 },
        },
      });
      yield* waitForCost(harness.registry, summary, 5);
      yield* Deferred.await(interrupted);
      expect(harness.requests()).toBe(2);
      unmount();
    }),
  ),
);

it.effect("refetches thread usage after a price change", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const threadUsage = harness.threadUsage(ThreadId.make("usage-thread"));
      const unmount = harness.registry.mount(threadUsage);
      yield* waitForThreadCost(harness.registry, threadUsage, null);
      yield* harness.updateSettings({
        ...DEFAULT_SERVER_SETTINGS,
        usagePriceOverrides: {
          "custom-model": { inputCostPerMillionTokens: 5, outputCostPerMillionTokens: 10 },
        },
      });
      yield* waitForThreadCost(harness.registry, threadUsage, 5);
      expect(harness.threadUsageRequests()).toBe(2);
      unmount();
    }),
  ),
);

it.effect("drops unmounted thread usage so reconnects only refetch the open thread", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeHarness(undefined, undefined, 60_000);
      const closedId = ThreadId.make("closed-thread");
      const openId = ThreadId.make("open-thread");
      const closedUsage = harness.threadUsage(closedId);
      const openUsage = harness.threadUsage(openId);

      const unmountOpen = harness.registry.mount(openUsage);
      yield* waitForThreadCost(harness.registry, openUsage, null);
      const baselineNodes = harness.registry.getNodes().size;

      const unmountClosed = harness.registry.mount(closedUsage);
      yield* waitForThreadCost(harness.registry, closedUsage, null);
      expect(harness.registry.getNodes().size).toBeGreaterThan(baselineNodes);

      const closedEvicted = yield* Deferred.make<void>();
      harness.registry.onNodeRemoved = () => {
        if (harness.registry.getNodes().size <= baselineNodes) {
          Deferred.doneUnsafe(closedEvicted, Exit.void);
        }
      };
      unmountClosed();
      yield* Deferred.await(closedEvicted);
      expect(harness.registry.getNodes().has(closedUsage)).toBe(false);
      expect(harness.registry.getNodes().size).toBe(baselineNodes);

      yield* harness.updateSettings({
        ...DEFAULT_SERVER_SETTINGS,
        usagePriceOverrides: {
          "custom-model": { inputCostPerMillionTokens: 5, outputCostPerMillionTokens: 10 },
        },
      });
      yield* waitForThreadCost(harness.registry, openUsage, 5);
      yield* Queue.clear(harness.threadUsageRequested);

      yield* harness.reconnect();
      expect(yield* Queue.take(harness.threadUsageRequested)).toBe(openId);
      expect(harness.threadUsageRequestIds().filter((id) => id === closedId)).toHaveLength(1);

      // Re-mounting the evicted thread after price changes fetches once, not twice.
      const remountClosed = harness.registry.mount(closedUsage);
      yield* waitForThreadCost(harness.registry, closedUsage, 5);
      expect(harness.threadUsageRequestIds().filter((id) => id === closedId)).toHaveLength(2);
      expect(harness.threadUsageRequestIds().filter((id) => id === openId)).toHaveLength(3);
      remountClosed();
      unmountOpen();
    }),
  ),
);

it.effect("keeps the cached usage summary when the awaited refresh fails", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const harness = yield* makeRefreshingHarness(
        Effect.fail(new UsageReadError({ reason: "scanFailed", detail: "Cursor is down" })),
      );
      const summary = harness.summary();
      const unmount = harness.registry.mount(summary);
      expect((yield* settledSummary(harness.registry, summary)).sources).toEqual([
        cursorSource(true),
      ]);
      expect(AsyncResult.isSuccess(harness.registry.get(summary))).toBe(true);
      expect(harness.requests()).toBe(2);
      unmount();
    }),
  ),
);
