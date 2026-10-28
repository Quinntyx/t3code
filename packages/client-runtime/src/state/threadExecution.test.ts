import {
  TurnItemId,
  NodeId,
  MessageId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderSessionId,
  ProviderDriverKind,
  ProviderTurnId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2RunStatus,
  type OrchestrationV2TurnItem,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  resumableContinuationRun,
  usageLimitBlockedRun,
} from "@t3tools/shared/orchestrationV2ThreadError";
import { describe, expect, it } from "vite-plus/test";

import { v2Projection } from "./orchestrationV2TestFixtures.ts";
import {
  backgroundCommandOutputFile,
  deriveBackgroundWorkDetails,
  followOutputFileCommand,
  deriveReportedModelSelection,
  deriveLatestThreadRun,
  deriveProviderSubagentStatus,
  deriveRunlessWorkStartedAt,
  deriveThreadActivityRun,
  deriveThreadRuntime,
  threadRuntimeHasInterruptibleRun,
} from "./threadExecution.ts";

const now = DateTime.makeUnsafe("2026-07-28T10:00:00.000Z");

function run(id: string, ordinal: number, status: OrchestrationV2RunStatus) {
  return {
    id: RunId.make(id),
    threadId: v2Projection.thread.id,
    ordinal,
    providerInstanceId: v2Projection.thread.providerInstanceId,
    modelSelection: v2Projection.thread.modelSelection,
    providerThreadId: null,
    userMessageId: MessageId.make(`message-${id}`),
    rootNodeId: null,
    activeAttemptId: null,
    status,
    requestedAt: now,
    startedAt: status === "queued" ? null : now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
}

describe("thread execution presentation", () => {
  it("resumes the latest executed run after any failure, not only a usage limit", () => {
    const failed = run("run-failed", 1, "failed");
    const interrupted = run("run-interrupted", 1, "interrupted");
    const completed = run("run-completed", 1, "completed");
    const queued = run("run-queued", 2, "queued");

    expect(resumableContinuationRun([failed, queued])?.id).toBe(failed.id);
    expect(resumableContinuationRun([interrupted, queued])?.id).toBe(interrupted.id);
    expect(resumableContinuationRun([completed, queued])).toBeNull();
    expect(resumableContinuationRun([failed, run("run-running", 2, "running")])).toBeNull();
  });

  it("derives the current root failure without inheriting errors from children or previous runs", () => {
    const failed = { ...run("limited", 1, "failed"), rootNodeId: NodeId.make("root") };
    const item = {
      id: TurnItemId.make("limit-error"),
      threadId: v2Projection.thread.id,
      runId: failed.id,
      nodeId: failed.rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "error" as const,
      status: "failed" as const,
      title: "Usage limit reached",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      failure: {
        class: "usage_limit" as const,
        message: "Plan limit reached",
        code: "usageLimitExceeded",
        retryable: null,
      },
    };
    const projection = { ...v2Projection, runs: [failed], turnItems: [item] };
    expect(deriveThreadRuntime(projection)).toMatchObject({
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit",
    });
    expect(
      deriveThreadRuntime({
        ...projection,
        turnItems: [{ ...item, nodeId: NodeId.make("child") }],
      }),
    ).toMatchObject({ lastError: null, lastErrorClass: null });
    expect(
      deriveThreadRuntime({
        ...projection,
        runs: [{ ...failed, rootNodeId: NodeId.make("new-root") }],
      }),
    ).toMatchObject({ lastError: null, lastErrorClass: null });
    expect(
      deriveThreadRuntime({ ...projection, runs: [failed, run("new", 2, "running")] }),
    ).toMatchObject({ status: "running", lastError: null, lastErrorClass: null });
  });

  // regression: #15029 working timers no longer reset on every background wake
  it("counts a wake run's activity from the start of the work it continues", () => {
    const workStartedAt = DateTime.makeUnsafe("2026-07-28T09:20:00.000Z");
    const wake = { ...run("wake", 2, "running"), workStartedAt };
    expect(
      deriveThreadRuntime({ ...v2Projection, runs: [run("prompt", 1, "completed"), wake] })
        ?.activityStartedAt,
    ).toBe("2026-07-28T09:20:00.000Z");
    expect(
      deriveThreadRuntime({ ...v2Projection, runs: [run("prompt", 1, "running")] })
        ?.activityStartedAt,
    ).toBe("2026-07-28T10:00:00.000Z");
  });

  it("keeps a subscription limit visible while later messages stay queued", () => {
    const failed = {
      ...run("limited", 1, "failed"),
      rootNodeId: NodeId.make("root"),
      completedAt: now,
    };
    const queued = run("queued", 2, "queued");
    const item = {
      id: TurnItemId.make("limit-error"),
      threadId: v2Projection.thread.id,
      runId: failed.id,
      nodeId: failed.rootNodeId,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 1,
      type: "error" as const,
      status: "failed" as const,
      title: "Usage limit reached",
      startedAt: now,
      completedAt: now,
      updatedAt: now,
      failure: {
        class: "usage_limit" as const,
        message: "Plan limit reached",
        code: "usageLimitExceeded",
        retryable: null,
      },
    };
    const projection = { ...v2Projection, runs: [failed, queued], turnItems: [item] };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(failed.id);
    expect(deriveThreadActivityRun(projection)?.runId).toBe(failed.id);
    expect(deriveThreadRuntime(projection)).toMatchObject({
      status: "failed",
      lastError: "Plan limit reached",
      lastErrorClass: "usage_limit",
    });
    const cancelledQueued = {
      ...run("cancelled-queued", 3, "cancelled"),
      startedAt: null,
      completedAt: now,
    };
    expect(
      usageLimitBlockedRun([failed, queued, cancelledQueued], projection.turnItems, null)?.id,
    ).toBe(failed.id);
    expect(
      deriveThreadRuntime({ ...projection, runs: [failed, queued, cancelledQueued] }),
    ).toMatchObject({ status: "failed", lastErrorClass: "usage_limit" });
    expect(
      deriveThreadRuntime({
        ...projection,
        turnItems: [{ ...item, failure: { ...item.failure, class: "provider_error" as const } }],
      }),
    ).toMatchObject({ status: "queued", lastErrorClass: null });
  });

  it("keeps live activity attached to an executing run when a newer run is queued", () => {
    const runningRun = run("run-running", 1, "running");
    const queuedRun = run("run-queued", 2, "queued");
    const projection = { ...v2Projection, runs: [queuedRun, runningRun], updatedAt: now };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(queuedRun.id);
    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: runningRun.id,
      status: "running",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "running",
      activeRunId: runningRun.id,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(true);
  });

  it("marks an open run whose provider turn already ended", () => {
    const attemptId = RunAttemptId.make("attempt-open");
    const openRun = { ...run("run-open", 1, "running"), activeAttemptId: attemptId };
    const providerTurn = (status: "running" | "failed") => ({
      id: ProviderTurnId.make("provider-turn-open"),
      providerThreadId: ProviderThreadId.make("provider-thread-open"),
      nodeId: NodeId.make("node-open"),
      runAttemptId: attemptId,
      nativeTurnRef: null,
      ordinal: 1,
      status,
      startedAt: now,
      completedAt: status === "running" ? null : now,
    });
    const projection = (status: "running" | "failed") => ({
      ...v2Projection,
      runs: [openRun],
      providerTurns: [providerTurn(status)],
      updatedAt: now,
    });

    expect(deriveThreadActivityRun(projection("running"))?.turnEnded).toBeUndefined();
    expect(deriveThreadActivityRun(projection("failed"))).toMatchObject({
      status: "running",
      turnEnded: true,
    });
  });

  it("presents a held queue as the stopped run instead of queued work", () => {
    const interrupted = { ...run("run-interrupted", 1, "interrupted"), completedAt: now };
    const held = { ...run("run-held", 2, "queued"), queueHeld: true };
    const projection = { ...v2Projection, runs: [interrupted, held], updatedAt: now };

    expect(deriveLatestThreadRun(projection)?.runId).toBe(interrupted.id);
    expect(deriveThreadActivityRun(projection)?.runId).toBe(interrupted.id);
    expect(deriveThreadRuntime(projection)).toMatchObject({
      status: "interrupted",
      activeRunId: null,
    });

    const resumed = { ...projection, runs: [interrupted, { ...held, queueHeld: false }] };
    expect(deriveThreadRuntime(resumed)).toMatchObject({ status: "queued" });

    const onlyHeld = {
      ...projection,
      runs: [held],
      thread: { ...projection.thread, activeProviderThreadId: null },
    };
    expect(deriveLatestThreadRun(onlyHeld)).toBeNull();
    expect(deriveThreadRuntime(onlyHeld)).toBeNull();
  });

  it("does not expose a queued-only run as interruptible", () => {
    const queuedRun = run("run-queued", 1, "queued");
    const projection = { ...v2Projection, runs: [queuedRun], updatedAt: now };

    expect(deriveThreadActivityRun(projection)).toMatchObject({
      runId: queuedRun.id,
      status: "queued",
    });

    const runtime = deriveThreadRuntime(projection);
    expect(runtime).toMatchObject({
      status: "queued",
      activeRunId: null,
    });
    expect(threadRuntimeHasInterruptibleRun(runtime)).toBe(false);
  });
});

describe("deriveRunlessWorkStartedAt", () => {
  const later = DateTime.makeUnsafe("2026-07-28T10:05:00.000Z");
  const rootTurn = (
    status: OrchestrationV2ExecutionNode["status"],
    startedAt = now,
  ): OrchestrationV2ExecutionNode => ({
    id: NodeId.make("child-root"),
    threadId: v2Projection.thread.id,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make("child-root"),
    kind: "root_turn",
    status,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt,
    completedAt: null,
  });

  const nativeChild = {
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      creationSource: "provider" as const,
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent" as const,
        rootThreadId: ThreadId.make("parent"),
      },
    },
  };

  it("times a provider-native subagent from its runless root turn while it works", () => {
    const projection = { ...nativeChild, nodes: [rootTurn("running", later)] };
    expect(deriveRunlessWorkStartedAt(projection)).toBe("2026-07-28T10:05:00.000Z");
    expect(deriveThreadRuntime(projection)).toBeNull();
  });

  it("ignores root turns that belong to a run, and threads the provider does not run", () => {
    const owned = { ...rootTurn("running"), runId: RunId.make("run-1") };
    expect(deriveRunlessWorkStartedAt({ ...nativeChild, nodes: [owned] })).toBeNull();
    expect(
      deriveRunlessWorkStartedAt({ ...v2Projection, nodes: [rootTurn("running")] }),
    ).toBeNull();
  });
});

describe("deriveProviderSubagentStatus", () => {
  const root = {
    id: NodeId.make("child-root"),
    threadId: v2Projection.thread.id,
    runId: null,
    parentNodeId: null,
    rootNodeId: NodeId.make("child-root"),
    kind: "root_turn" as const,
    status: "completed" as const,
    countsForRun: false,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    runtimeRequestId: null,
    checkpointScopeId: null,
    startedAt: now,
    completedAt: now,
  };
  const child = (creationSource: "provider" | "mcp") => ({
    ...v2Projection,
    thread: {
      ...v2Projection.thread,
      creationSource,
      lineage: {
        parentThreadId: ThreadId.make("parent"),
        relationshipToParent: "subagent" as const,
        rootThreadId: ThreadId.make("parent"),
      },
    },
    nodes: [root],
  });

  it("leaves T3 delegated tasks and ordinary threads alone", () => {
    expect(deriveProviderSubagentStatus(child("mcp"))).toBeNull();
    expect(deriveProviderSubagentStatus({ ...v2Projection, nodes: [root] })).toBeNull();
  });
});

describe("background work details", () => {
  const base = {
    id: TurnItemId.make("command-item"),
    threadId: v2Projection.thread.id,
    runId: null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed" as const,
    title: "Build the smoke corpus",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
  };
  const command = {
    ...base,
    type: "command_execution" as const,
    nativeItemRef: {
      driver: ProviderDriverKind.make("claude"),
      nativeId: "toolu_build",
      strength: "strong" as const,
    },
    input: "  vp run build  ",
    output:
      "Command running in background with ID: bdqirlcyw. Output is being written to: /tmp/claude-1000/session/tasks/bdqirlcyw.output. You will be notified when it completes.",
  } satisfies OrchestrationV2TurnItem;

  it("matches Claude's completed Bash item via nativeItemId and parses its output file", () => {
    const result = deriveBackgroundWorkDetails({
      tasks: [
        {
          taskId: "bdqirlcyw",
          nativeItemId: "toolu_build",
          kind: "command",
          description: "Build the smoke corpus",
          awaited: true,
        },
      ],
      turnItems: [command],
    });

    expect(result?.presentation.waiting).toBe(true);
    expect(result?.details[0]).toMatchObject({
      item: { taskId: "bdqirlcyw", label: "Build the smoke corpus" },
      awaited: true,
      turnItem: command,
      command: "vp run build",
      isRawCommand: false,
      outputFile: "/tmp/claude-1000/session/tasks/bdqirlcyw.output",
      startedAtMs: DateTime.toEpochMillis(now),
      updatedAtMs: DateTime.toEpochMillis(now),
      activity: null,
    });
  });

  it("distinguishes the exact command label from a prose description and takes the newest match", () => {
    const result = deriveBackgroundWorkDetails({
      tasks: [{ taskId: "toolu_build", kind: "command", description: " vp run build " }],
      turnItems: [{ ...command, input: "old command" }, command],
    });
    expect(result?.details[0]).toMatchObject({
      command: "vp run build",
      isRawCommand: true,
      awaited: false,
    });
    expect(result?.details[0]?.turnItem).toBe(command);
  });

  it("collapses subagent progress and resolves its child thread in presentation order", () => {
    const childThreadId = ThreadId.make("child");
    const subagent = {
      ...base,
      id: TurnItemId.make("subagent-item"),
      type: "subagent" as const,
      subagentId: NodeId.make("subagent"),
      origin: "provider_native" as const,
      driver: ProviderDriverKind.make("claude"),
      providerInstanceId: v2Projection.thread.providerInstanceId,
      childThreadId,
      prompt: "Review the build",
      progress: "  Checking\n the\t build  ",
      result: null,
    } satisfies OrchestrationV2TurnItem;
    const result = deriveBackgroundWorkDetails({
      tasks: [
        { taskId: "toolu_build", kind: "command" },
        { taskId: "subagent-item", kind: "subagent", description: "Review the build" },
      ],
      turnItems: [command, subagent],
    });

    expect(result?.details.map((detail) => detail.item.kind)).toEqual(["subagent", "command"]);
    expect(result?.details[0]).toMatchObject({
      activity: "Checking the build",
      childThreadId,
      command: null,
      outputFile: null,
      updatedAtMs: DateTime.toEpochMillis(now),
    });
    const explicitChild = ThreadId.make("explicit-child");
    expect(
      deriveBackgroundWorkDetails({
        tasks: [{ taskId: "subagent-item", kind: "subagent", childThreadId: explicitChild }],
        turnItems: [subagent],
      })?.details[0]?.childThreadId,
    ).toBe(explicitChild);
  });

  it("links a PR-watch monitor to its pull request without a turn item", () => {
    const pullRequest: ThreadPullRequestLink = {
      host: "github.com",
      repository: "acme/app",
      number: 42,
      url: "https://github.com/acme/app/pull/42",
      source: "agent",
      linkedAt: "2026-07-28T10:00:00.000Z",
      snapshot: null,
      stack: null,
      watch: {
        startedAt: "2026-07-28T10:00:00.000Z",
        headSha: null,
        failedChecks: [],
        passed: false,
        passedChecks: [],
        remarksThrough: "2026-07-28T10:00:00.000Z",
        remarkIds: [],
        conflicting: false,
        wakes: 0,
      },
    };
    const result = deriveBackgroundWorkDetails({
      tasks: [
        { taskId: "pull-request-watch:github.com/acme/app#42", kind: "monitor", awaited: true },
      ],
      turnItems: [],
      pullRequests: [pullRequest],
    });
    expect(result?.details[0]?.pullRequest).toBe(pullRequest);
    expect(result?.details[0]?.turnItem).toBeUndefined();
  });

  it("keeps unmatched tasks inspectable and returns null only for an empty roster", () => {
    expect(deriveBackgroundWorkDetails({ tasks: [], turnItems: [command] })).toBeNull();
    expect(
      deriveBackgroundWorkDetails({
        tasks: [{ taskId: "unknown", kind: "background_task" }],
        turnItems: [command],
      })?.details[0],
    ).toEqual({
      item: {
        taskId: "unknown",
        kind: "background_task",
        label: "background task",
        named: false,
        childThreadId: undefined,
      },
      awaited: false,
      turnItem: undefined,
      command: null,
      isRawCommand: false,
      outputFile: null,
      startedAtMs: null,
      updatedAtMs: 0,
      activity: null,
      childThreadId: undefined,
      pullRequest: undefined,
    });
  });

  it("retains monitor output and dynamic tool input for inspection", () => {
    const monitor = {
      ...command,
      monitor: true,
      output: "Monitor started (task watch, expires in 30s)",
    };
    const tool = {
      ...base,
      id: TurnItemId.make("dynamic"),
      type: "dynamic_tool" as const,
      toolName: "background_build",
      input: { target: "app" },
    } satisfies OrchestrationV2TurnItem;
    const result = deriveBackgroundWorkDetails({
      tasks: [
        { taskId: "toolu_build", kind: "monitor" },
        { taskId: "dynamic", kind: "background_task" },
      ],
      turnItems: [monitor, tool],
    });
    expect(result?.details[0]).toMatchObject({
      turnItem: monitor,
      command: "vp run build",
      outputFile: null,
    });
    expect(result?.details[1]).toMatchObject({ turnItem: tool, command: null });
  });
});

describe("background command output files", () => {
  it("parses paths with and without the notification sentence or trailing period", () => {
    expect(backgroundCommandOutputFile("Output is being written to: /tmp/build.output.")).toBe(
      "/tmp/build.output",
    );
    expect(backgroundCommandOutputFile("Output is being written to: /tmp/build.output")).toBe(
      "/tmp/build.output",
    );
    expect(backgroundCommandOutputFile(undefined)).toBeNull();
    expect(backgroundCommandOutputFile("Monitor started (task watch, expires in 30s)")).toBeNull();
    expect(backgroundCommandOutputFile("Output is being written to: ")).toBeNull();
    expect(
      backgroundCommandOutputFile("Output is being written to: /tmp/build output."),
    ).toBeNull();
  });

  it("quotes output paths as literal POSIX shell arguments", () => {
    expect(followOutputFileCommand("/tmp/build.output")).toBe("tail -n +1 -F '/tmp/build.output'");
    expect(followOutputFileCommand("/tmp/a b'$(echo nope).output")).toBe(
      "tail -n +1 -F '/tmp/a b'\\''$(echo nope).output'",
    );
  });
});

describe("provider-reported model selection", () => {
  const selected = v2Projection.thread.modelSelection;
  const reported = { ...selected, options: [{ id: "reasoningEffort", value: "default" }] };
  const providerThread = {
    id: ProviderThreadId.make("active"),
    driver: ProviderDriverKind.make("codex"),
    providerInstanceId: selected.instanceId,
    providerSessionId: ProviderSessionId.make("session"),
    appThreadId: v2Projection.thread.id,
    ownerNodeId: null,
    nativeThreadRef: null,
    nativeConversationHeadRef: null,
    status: "idle" as const,
    firstRunOrdinal: null,
    lastRunOrdinal: null,
    handoffIds: [],
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    nativeMetadata: { modelSelection: reported },
  };
  const projection = {
    ...v2Projection,
    thread: { ...v2Projection.thread, activeProviderThreadId: providerThread.id },
    providerThreads: [providerThread],
  };

  it("reads only the active provider thread's reported selection", () => {
    expect(deriveReportedModelSelection(projection)).toBe(reported);
    expect(
      deriveReportedModelSelection({
        ...projection,
        thread: { ...projection.thread, activeProviderThreadId: null },
      }),
    ).toBeNull();
    expect(
      deriveReportedModelSelection({
        ...projection,
        providerThreads: [
          { ...providerThread, providerInstanceId: ProviderInstanceId.make("other") },
        ],
      }),
    ).toBeNull();
  });
});
