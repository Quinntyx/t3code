import { type ThreadId, type ThreadUsage, ThreadUsageError } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { buildThreadUsage, delegateThreadIds, threadUsageTurns } from "./threadUsage.ts";
import * as UsageService from "./UsageService.ts";

const USAGE_FIELDS = ["runs", "attempts", "providerThreads", "providerTurns"] as const;

export class ThreadUsageService extends Context.Service<
  ThreadUsageService,
  {
    readonly read: (threadId: ThreadId) => Effect.Effect<ThreadUsage, ThreadUsageError>;
  }
>()("t3/usage/ThreadUsageService") {}

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const usage = yield* UsageService.UsageService;

  const read = Effect.fn("ThreadUsageService.read")(
    function* (threadId: ThreadId) {
      const decodeFamily = yield* threads.readShellSnapshot({
        location: "active",
        familyOf: threadId,
      });
      const family = (yield* decodeFamily).threads;
      const delegates = delegateThreadIds(threadId, family);
      const [main, children, pricing] = yield* Effect.all(
        [
          threads.getThreadRecords(threadId, [...USAGE_FIELDS, "turnItems"], {
            turnItemTypes: ["compaction"],
          }),
          Effect.forEach(delegates, (id) => threads.getThreadRecords(id, USAGE_FIELDS), {
            concurrency: 4,
          }),
          usage.pricingTables,
        ],
        { concurrency: "unbounded" },
      );
      const nowMs = yield* Clock.currentTimeMillis;
      const counted = new Set([threadId, ...delegates]);
      return buildThreadUsage({
        turns: [
          ...threadUsageTurns("main", main, nowMs),
          ...children.flatMap((records) => threadUsageTurns("delegates", records, nowMs)),
        ],
        compactedAtMs: main.turnItems.flatMap((item) => {
          const at = item.completedAt ?? item.startedAt;
          return at === null ? [] : [DateTime.toEpochMillis(at)];
        }),
        pricing,
        nowMs,
        active: family.some((thread) => counted.has(thread.id) && thread.activeRunId !== null),
      });
    },
    (effect, threadId) =>
      effect.pipe(Effect.mapError((cause) => new ThreadUsageError({ threadId, cause }))),
  );

  return { read } as const;
});

export const layer = Layer.effect(ThreadUsageService, make);
