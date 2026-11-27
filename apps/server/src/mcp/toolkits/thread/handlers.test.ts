import {
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ThreadHandlers from "./handlers.ts";
import { ThreadToolkit } from "./tools.ts";

const GOAL_THREAD_ID = ThreadId.make("thread-goal");
const HELPER_THREAD_ID = ThreadId.make("thread-helper");
const REVIEW_THREAD_ID = ThreadId.make("thread-goal-review");
const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("codex");

const testCrypto = SecureRandom.make((size) => new Uint8Array(size).fill(7));

const review = (childThreadId: ThreadId): OrchestrationV2Subagent =>
  ({ purpose: "goal_review", childThreadId }) as never;

interface HarnessOptions {
  readonly callerId?: ThreadId;
  readonly subagents?: ReadonlyArray<OrchestrationV2Subagent>;
}

const makeHarness = Effect.fn("makeThreadToolkitHarness")(function* (options: HarnessOptions = {}) {
  const callerId = options.callerId ?? GOAL_THREAD_ID;
  const dispatched = yield* Ref.make<ReadonlyArray<unknown>>([]);
  const base = idleThreadProjection(liveThreadShell(GOAL_THREAD_ID));
  const projection = {
    ...base,
    thread: { ...base.thread, goal: { objective: "Ship it", status: "active" as const } },
    subagents: options.subagents ?? [],
  };
  const threadsLayer = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
    getProjectThreadRecords: () => Effect.succeed(projection as never),
    dispatch: (command) =>
      Ref.update(dispatched, (recorded) => [...recorded, command]).pipe(
        Effect.as({ sequence: 1 } as never),
      ),
  });
  const dependencies = Layer.mergeAll(
    threadsLayer,
    Layer.succeed(SecureRandom.SecureRandom, testCrypto),
  );
  const toolkit = yield* ThreadToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(ThreadHandlers.layer).pipe(Layer.provide(dependencies)),
    ),
  );
  const call = (params: {
    readonly action: "complete" | "blocked";
    readonly threadId?: ThreadId;
  }) =>
    toolkit.handle("t3_goal", params).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!.result as unknown),
      Effect.provideService(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment-1"),
        requestNamespace: "provider-session-1",
        thread: {
          threadId: callerId,
          providerSessionId: "provider-session-1",
          providerInstanceId: PROVIDER_INSTANCE_ID,
        },
        client: undefined,
        capabilities: new Set(["orchestration"] as const),
        issuedAt: 1,
      }),
      Effect.provide(dependencies),
    );
  return { call, dispatched };
});

describe("t3_goal", () => {
  it.effect("refuses a goal the working agent tries to close itself", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      const result = yield* harness.call({ action: "complete" });
      expect(result).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "invalid_request" });
      expect(yield* Ref.get(harness.dispatched)).toEqual([]);
    }),
  );

  it.effect("refuses an unrelated agent, even when a review exists", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        callerId: HELPER_THREAD_ID,
        subagents: [review(REVIEW_THREAD_ID)],
      });
      const result = yield* harness.call({ action: "complete", threadId: GOAL_THREAD_ID });
      expect(result).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "invalid_request" });
      expect(yield* Ref.get(harness.dispatched)).toEqual([]);
    }),
  );

  it.effect("lets the goal review delegate close the goal", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        callerId: REVIEW_THREAD_ID,
        subagents: [review(REVIEW_THREAD_ID)],
      });
      expect(yield* harness.call({ action: "complete", threadId: GOAL_THREAD_ID })).toEqual({
        sequence: 1,
      });
      expect(yield* Ref.get(harness.dispatched)).toHaveLength(1);
    }),
  );

  it.effect("still lets any agent report the goal blocked", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness();
      expect(yield* harness.call({ action: "blocked" })).toEqual({ sequence: 1 });
      expect(yield* Ref.get(harness.dispatched)).toHaveLength(1);
    }),
  );
});
