import {
  EnvironmentId,
  type OrchestrationV2LinkOrigin,
  type OrchestrationV2ThreadShell,
  type ProviderInteractionMode,
  ProviderInstanceId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PullRequestStackService from "../../../pullRequest/PullRequestStackService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as WorktreeHandlers from "./handlers.ts";
import { WorktreeToolkit } from "./tools.ts";

const CALLER_ID = ThreadId.make("thread-caller");
const SIBLING_ID = ThreadId.make("thread-sibling");
const PROVIDER_INSTANCE_ID = ProviderInstanceId.make("codex");

const invocation = (): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment-1"),
  requestNamespace: "provider-session-1",
  thread: {
    threadId: CALLER_ID,
    providerSessionId: "provider-session-1",
    providerInstanceId: PROVIDER_INSTANCE_ID,
  },
  client: undefined,
  capabilities: new Set(["worktree"]),
  issuedAt: 1,
});

interface ShellOptions {
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly linkOrigin?: OrchestrationV2LinkOrigin;
}

const shell = (id: ThreadId, options: ShellOptions = {}): OrchestrationV2ThreadShell => {
  const base = liveThreadShell(id, {
    ...(options.runtimeMode === undefined ? {} : { runtimeMode: options.runtimeMode }),
    ...(options.interactionMode === undefined ? {} : { interactionMode: options.interactionMode }),
  });
  return options.linkOrigin === undefined ? base : { ...base, linkOrigin: options.linkOrigin };
};

interface HarnessOptions {
  readonly caller?: ShellOptions;
  readonly siblings?: ReadonlyArray<OrchestrationV2ThreadShell>;
}

const makeHarness = Effect.fn("makeWorktreeToolkitHarness")(function* (
  options: HarnessOptions = {},
) {
  const invocations = yield* Ref.make<
    ReadonlyArray<PullRequestStackService.RestackDependentsInput>
  >([]);
  const caller = shell(CALLER_ID, options.caller);
  const siblings = options.siblings ?? [];
  const shells = new Map<string, OrchestrationV2ThreadShell>([
    [caller.id, caller],
    ...siblings.map((sibling) => [sibling.id, sibling] as const),
  ]);
  const threadsLayer = Layer.mock(ThreadManagement.ThreadManagementService)({
    getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
  });
  const stacksLayer = Layer.mock(PullRequestStackService.PullRequestStackService)({
    restackDependents: (input) =>
      Effect.gen(function* () {
        yield* Ref.update(invocations, (recorded) => [...recorded, input]);
        if (input.authorizeTarget !== undefined) {
          yield* Effect.forEach(siblings, input.authorizeTarget, { concurrency: 1 });
        }
        return { threads: [] };
      }),
  });
  const dependencies = Layer.mergeAll(threadsLayer, stacksLayer);
  const toolkit = yield* WorktreeToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(WorktreeHandlers.layer).pipe(Layer.provide(dependencies)),
    ),
  );
  const call = () =>
    toolkit.handle("t3_worktree_restack", {}).pipe(
      Stream.unwrap,
      Stream.runCollect,
      Effect.map((chunk) => chunk.at(-1)!.result as unknown),
      Effect.provideService(McpInvocationContext.McpInvocationContext, invocation()),
      Effect.provide(dependencies),
    );
  return { call, invocations };
});

describe("t3_worktree_restack", () => {
  it.effect("rejects a plan-mode caller before restacking anything", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        caller: { interactionMode: "plan" },
        siblings: [shell(SIBLING_ID)],
      });
      const result = yield* harness.call();
      expect(result).toMatchObject({ _tag: "WorktreeMcpFailure", code: "capability_denied" });
      expect(yield* Ref.get(harness.invocations)).toEqual([]);
    }),
  );

  it.effect("refuses a sibling above the caller's runtime mode", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        caller: { runtimeMode: "approval-required" },
        siblings: [shell(SIBLING_ID, { runtimeMode: "full-access" })],
      });
      const result = yield* harness.call();
      expect(result).toMatchObject({ _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(result).toMatchObject({ message: expect.stringContaining("above this caller's") });
      expect(yield* Ref.get(harness.invocations)).toHaveLength(1);
    }),
  );

  it.effect("refuses a sibling that a fenced linked caller did not start", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        caller: {
          runtimeMode: "full-access",
          linkOrigin: { sessionId: "link-1", label: "Laptop", access: "auto" },
        },
        siblings: [shell(SIBLING_ID)],
      });
      const result = yield* harness.call();
      expect(result).toMatchObject({ _tag: "WorktreeMcpFailure", code: "operation_failed" });
      expect(result).toMatchObject({
        message: expect.stringContaining("only threads that link started"),
      });
      expect(yield* Ref.get(harness.invocations)).toHaveLength(1);
    }),
  );

  it.effect("restacks siblings when the caller may change them", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness({
        caller: { runtimeMode: "full-access" },
        siblings: [shell(SIBLING_ID, { runtimeMode: "full-access" })],
      });
      expect(yield* harness.call()).toEqual({ threads: [] });
      expect(yield* Ref.get(harness.invocations)).toHaveLength(1);
    }),
  );
});
