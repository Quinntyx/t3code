import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DeusConversation,
  RunId,
  EventId,
  NodeId,
  MessageId,
  ProviderTurnId,
  DeusInputId,
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as GitWorkflow from "../git/GitWorkflowService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as ThreadEvents from "../orchestration-v2/EventStore.ts";
import * as ProviderAdapters from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderSessions from "../orchestration-v2/ProviderSessionManager.ts";
import * as Stream from "effect/Stream";
import * as Replay from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as McpSessions from "@t3tools/provider-core/server/McpProviderSessions";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Projects from "../project/ProjectService.ts";
import * as ManagedFolders from "../project/ManagedProjectFolders.ts";
import * as Setup from "../project/ProjectSetupScriptRunner.ts";
import * as SetupTracker from "../project/WorktreeSetupTracker.ts";
import * as CloneTracker from "../project/ProjectCloneTracker.ts";
import * as Terminal from "../terminal/Manager.ts";
import * as ProviderRegistryMock from "../provider/testUtils/providerRegistryMock.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Settings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as Repository from "./DeusRepository.ts";
import * as Sessions from "./DeusSessionService.ts";
import * as Authority from "./DeusAuthority.ts";
import * as Bridge from "./DeusThreadBridge.ts";
import * as Sink from "../orchestration-v2/EventSink.ts";
import * as DateTime from "effect/DateTime";
import * as Documents from "../provider/DocumentText.ts";

const environmentId = EnvironmentId.make("deus-bridge-environment");
const projectId = ProjectId.make("deus-bridge-project");
const model = { instanceId: ProviderInstanceId.make("codex"), model: "fixture-model" };
const provider: ServerProvider = {
  instanceId: model.instanceId,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: "fixture",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-01-01T00:00:00.000Z",
  models: [{ slug: model.model, name: model.model, isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};
const project = {
  id: projectId,
  title: "Fixture",
  workspaceRoot: "/fixture",
  repositoryIdentity: null,
  faviconPath: null,
  defaultModelSelection: model,
  defaultThreadEnvMode: null,
  scripts: [],
  createdAt: provider.checkedAt,
  updatedAt: provider.checkedAt,
  deletedAt: null,
};
const adapter = {
  instanceId: model.instanceId,
  driver: provider.driver,
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("external provider execution is disabled in Deus bridge fixtures"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const openFixtureSession: ProviderAdapter.ProviderAdapterV2["Service"]["openSession"] = Effect.fn(
  "DeusThreadBridge.test.openFixtureSession",
)(function* (input) {
  const now = yield* DateTime.now;
  return {
    instanceId: model.instanceId,
    driver: provider.driver,
    providerSessionId: input.providerSessionId,
    providerSession: {
      id: input.providerSessionId,
      providerInstanceId: model.instanceId,
      driver: provider.driver,
      status: "running" as const,
      cwd: "/fixture",
      model: model.model,
      capabilities: CodexProviderCapabilitiesV2,
      createdAt: now,
      updatedAt: now,
      lastError: null,
    },
    events: Stream.never,
    ensureThread: () => Effect.die("unused fixture ensureThread"),
    resumeThread: () => Effect.die("unused fixture resumeThread"),
    startTurn: () => Effect.die("external generation is disabled in Deus bridge fixtures"),
    steerTurn: () => Effect.void,
    interruptTurn: () => Effect.void,
    respondToRuntimeRequest: () => Effect.die("unused fixture runtime request"),
    readThreadSnapshot: () => Effect.die("unused fixture read snapshot"),
    rollbackThread: () => Effect.die("unused fixture rollback"),
    forkThread: () => Effect.die("unused fixture fork"),
  };
});

function harness(
  options: {
    readonly deny?: boolean;
    readonly enabled?: boolean;
    readonly ceiling?: "approval-required" | "full-access";
    readonly externalFixture?: boolean;
  } = {},
) {
  const database = Sqlite.layerMemory;
  const registry = ProviderAdapters.layerFromAdapters([
    { ...adapter, ...(options.externalFixture ? { openSession: openFixtureSession } : {}) },
  ]);
  const orchestrator = Replay.layerWithRegistry({ name: "deus-bridge" }, registry, {
    databaseLayer: database,
    runEffectWorker: false,
  });
  const settings = Settings.layerTest();
  const receipts = Receipts.layer.pipe(Layer.provide(database));
  const threadEvents = ThreadEvents.layer.pipe(Layer.provide(database));
  const threads = ThreadManagement.layer.pipe(
    Layer.provide(Layer.mergeAll(orchestrator, settings, receipts)),
  );
  const external = Layer.mergeAll(
    NodeServices.layer,
    McpSessions.layer,
    ServerConfig.layerTest(process.cwd(), { prefix: "deus-bridge-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
    ProviderRegistryMock.layer([{ ...provider, enabled: options.enabled ?? true }]),
    Layer.mock(Projects.ProjectService)({
      getById: (id) => Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
    }),
    Layer.mock(ManagedFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/fixture",
      isScratchProject: () => Effect.succeed(false),
      folderForThread: () => Effect.succeedNone,
    }),
    SetupTracker.layer,
    Layer.mock(CloneTracker.ProjectCloneTracker)({ get: () => Effect.succeed(null) }),
    Layer.mock(Terminal.TerminalManager)({}),
    Layer.mock(Documents.DocumentText)({}),
    Layer.mock(GitWorkflow.GitWorkflowService)({}),
    Layer.mock(Setup.ProjectSetupScriptRunner)({}),
    Layer.mock(TextGeneration.TextGeneration)({}),
    Layer.succeed(Authority.DeusAuthority, {
      authorize: () =>
        options.deny
          ? Effect.fail(new Authority.DeusAuthorityError({ reason: "inactive" }))
          : Effect.succeed({
              runtimeMode: options.ceiling ?? "full-access",
              interactionMode: "default",
              allowWorktree: false,
            }),
    }),
  );
  const launches = ThreadLaunch.layer.pipe(
    Layer.provide(Layer.mergeAll(external, threads, receipts, IdAllocator.layer, settings)),
  );
  const sessions = Sessions.layer.pipe(
    Layer.provideMerge(Repository.layer),
    Layer.provide(Events.layer),
    Layer.provide(external),
    Layer.provide(database),
  );
  return Bridge.layer.pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        sessions,
        threads,
        launches,
        receipts,
        threadEvents,
        registry,
        external,
        database,
        orchestrator,
      ),
    ),
  );
}

const setup = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
    VALUES (${projectId}, 'Fixture', '/fixture', '[]', ${provider.checkedAt}, ${provider.checkedAt})`;
  const sessions = yield* Sessions.DeusSessionService;
  const snapshot = yield* sessions.open({
    environmentId,
    projectId,
    inputId: DeusInputId.make("open"),
  });
  const input = {
    ...snapshot.session,
    inputId: DeusInputId.make("launch"),
    conversation: DeusConversation.make(1),
    prompt: "Bounded worker fixture",
    kind: "work" as const,
    model,
    runtimeMode: "full-access" as const,
    workspace: "project" as const,
  };
  return { sql, sessions, input, bridge: yield* Bridge.DeusThreadBridge };
});

const authenticate = Effect.fn("DeusThreadBridge.test.authenticate")(function* (
  threadId: ThreadId,
  providerSessionId = "fixture-session",
) {
  const sessions = yield* McpSessions.McpProviderSessions;
  yield* sessions.set({
    environmentId,
    threadId,
    providerSessionId,
    providerInstanceId: model.instanceId,
    endpoint: "http://127.0.0.1/mcp",
    authorizationHeader: "Bearer fixture-only",
    browserToolsAvailable: false,
  });
  return {
    environmentId,
    capabilities: new Set(["orchestration"] as const),
    issuedAt: 0,
    requestNamespace: providerSessionId,
    client: undefined,
    thread: { threadId, providerInstanceId: model.instanceId, providerSessionId },
  };
});

it.effect("launches one actual worker and initial message on duplicate accepted launch", () =>
  Effect.gen(function* () {
    const { bridge, input, sql, sessions } = yield* setup;
    const first = yield* bridge.launch(input);
    const second = yield* bridge.launch(input);
    assert.equal(
      (yield* bridge.launch({ ...input, prompt: "incompatible retry" }).pipe(Effect.flip))._tag,
      "DeusStateError",
    );
    assert.equal(first.workers[0]?.runId, second.workers[0]?.runId);
    assert.isNotNull(first.workers[0]?.runId);
    assert.lengthOf((yield* sessions.snapshot(input)).tasks, 1);
    assert.equal(
      (yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`)[0]?.count,
      1,
    );
    const threads = yield* ThreadManagement.ThreadManagementService;
    const worker = yield* threads.getThreadRecords(first.workers[0]!.threadId, [
      "messages",
      "runs",
    ]);
    assert.lengthOf(worker.messages, 1);
    assert.lengthOf(worker.runs, 1);
    assert.equal(worker.thread.creationSource, "deus");
    assert.equal(worker.thread.lineage.parentThreadId, null);
    assert.equal(worker.messages[0]?.senderThreadId, undefined);
    assert.equal(
      (yield* sessions.pending).filter((item) => item.intent.type === "launch-thread").length,
      0,
    );
  }).pipe(Effect.provide(harness())),
);

it.effect("reconciles external acceptance before acknowledgment without using the latest run", () =>
  Effect.gen(function* () {
    const { bridge, input, sessions } = yield* setup;
    const prepared = yield* sessions.prepareLaunch(input);
    const pending = (yield* sessions.pending)[0]!;
    if (pending.intent.type !== "launch-thread") return assert.fail("Missing launch");
    const launches = yield* ThreadLaunch.ThreadLaunchService;
    yield* launches.launch({
      commandId: pending.intent.commandId,
      threadId: pending.intent.threadId,
      projectId,
      title: input.prompt,
      modelSelection: model,
      runtimeMode: input.runtimeMode,
      interactionMode: "default",
      workspaceStrategy: { type: "root" },
      initialMessage: { text: input.prompt, attachments: [] },
      createdBy: "agent",
      creationSource: "deus",
    });
    const restarted = yield* Bridge.DeusThreadBridge.pipe(Effect.provide(Bridge.layer));
    yield* restarted.recover;
    const task = (yield* sessions.snapshot(input)).tasks.find(
      (item) => item.id === prepared.task.id,
    )!;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const records = yield* threads.getThreadRecords(pending.intent.threadId, ["messages", "runs"]);
    assert.equal(task.workers[0]?.runId, records.runs[0]?.id);
    assert.lengthOf(records.messages, 1);
    assert.lengthOf(records.runs, 1);
    yield* threads.sendToThread({
      projectId,
      threadId: pending.intent.threadId,
      commandId: CommandId.make("later"),
      messageId: MessageId.make("later-message"),
      text: "Later run",
      attachments: [],
      mode: "queue",
      createdBy: "user",
      creationSource: "web",
    });
    yield* bridge.recover;
    const original = (yield* sessions.snapshot(input)).tasks[0]!.workers[0]!;
    assert.equal(original.runId, records.runs[0]?.id);
  }).pipe(Effect.provide(harness({ deny: true }))),
);

it.effect("denies inactive authority before launch", () =>
  Effect.gen(function* () {
    const { bridge, input, sql } = yield* setup;
    const error = yield* bridge.launch(input).pipe(Effect.flip);
    assert.equal(error._tag, "DeusAuthorityError");
    assert.equal(
      (yield* sql<{
        count: number;
      }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`)[0]?.count,
      0,
    );
  }).pipe(Effect.provide(harness({ deny: true }))),
);

it.effect(
  "rejects explicit model fallback and reads immutable bounded snapshots without worker messages",
  () =>
    Effect.gen(function* () {
      const { bridge, input } = yield* setup;
      const error = yield* bridge
        .launch({ ...input, model: { ...model, model: "missing" } })
        .pipe(Effect.flip);
      assert.equal(error._tag, "DeusStateError");
      const task = yield* bridge.launch(input);
      const ref = { ...input, threadId: task.workers[0]!.threadId };
      const first = yield* bridge.read(ref);
      const second = yield* bridge.read(ref);
      assert.deepEqual(first, second);
      assert.isTrue(Object.isFrozen(first));
      assert.isAtMost(first.messages.length, 32);
      assert.isAtMost(JSON.stringify(first).length, 65536);
      const foreign = yield* bridge
        .read({ ...ref, projectId: ProjectId.make("foreign") })
        .pipe(Effect.flip);
      assert.equal(foreign._tag, "DeusStateError");
      const unowned = yield* bridge
        .read({ ...ref, threadId: ThreadId.make("unowned") })
        .pipe(Effect.flip);
      assert.equal(unowned._tag, "DeusStateError");
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "authenticates report ownership and retains original run and conversation after reset",
  () =>
    Effect.gen(function* () {
      const { bridge, sessions, input } = yield* setup;
      const task = yield* bridge.launch(input);
      const worker = task.workers[0]!;
      const scope = yield* authenticate(worker.threadId);
      assert.equal(
        (yield* bridge
          .report(
            { ...scope, thread: { ...scope.thread, providerSessionId: "forged-session" } },
            {
              inputId: DeusInputId.make("forged-report"),
              runId: worker.runId!,
              mode: "SILENT",
              text: "spoof",
            },
          )
          .pipe(Effect.flip))._tag,
        "DeusStateError",
      );
      const report = {
        inputId: DeusInputId.make("report"),
        runId: worker.runId!,
        mode: "SILENT" as const,
        text: "Real worker result",
      };
      assert.equal(
        (yield* bridge.report({ ...scope, thread: undefined }, report).pipe(Effect.flip))._tag,
        "DeusStateError",
      );
      assert.equal(
        (yield* bridge.report(scope, { ...report, runId: RunId.make("spoofed") }).pipe(Effect.flip))
          ._tag,
        "DeusStateError",
      );
      assert.equal(
        (yield* bridge
          .report({ ...scope, environmentId: EnvironmentId.make("foreign") }, report)
          .pipe(Effect.flip))._tag,
        "DeusStateError",
      );
      assert.equal(
        (yield* bridge
          .report(
            { ...scope, client: { sessionId: "oauth", label: "external", access: "full-access" } },
            report,
          )
          .pipe(Effect.flip))._tag,
        "DeusStateError",
      );
      assert.equal(
        (yield* bridge
          .report(
            {
              ...scope,
              thread: {
                ...scope.thread,
                providerInstanceId: ProviderInstanceId.make("spoofed-provider"),
              },
            },
            report,
          )
          .pipe(Effect.flip))._tag,
        "DeusStateError",
      );
      yield* sessions.resetConversation({ ...input, inputId: DeusInputId.make("reset") });
      yield* bridge.report(scope, report);
      yield* bridge.report(scope, report);
      const current = yield* sessions.snapshot(input);
      assert.lengthOf(current.reports, 1);
      assert.equal(current.reports[0]?.threadId, worker.threadId);
      assert.equal(current.reports[0]?.runId, worker.runId);
      assert.equal(current.reports[0]?.conversation, 1);
      assert.equal(current.session.conversation, 2);
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "tracks real native descendants without manufacturing thread ids or completing a live parent",
  () =>
    Effect.gen(function* () {
      const { bridge, sessions, input } = yield* setup;
      const task = yield* bridge.launch(input);
      const worker = task.workers[0]!;
      const sink = yield* Sink.EventSinkV2;
      const now = yield* DateTime.now;
      const native = {
        id: NodeId.make("native-child"),
        threadId: worker.threadId,
        runId: worker.runId,
        parentNodeId: NodeId.make("root"),
        origin: "provider_native" as const,
        createdBy: "agent" as const,
        driver: provider.driver,
        providerInstanceId: model.instanceId,
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: {
          driver: provider.driver,
          nativeId: "genuine-native-child",
          strength: "strong" as const,
        },
        prompt: "child",
        title: null,
        model: null,
        status: "completed" as const,
        result: "done",
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      };
      yield* sink.write({
        events: [
          {
            id: EventId.make("native-done"),
            type: "subagent.updated",
            threadId: worker.threadId,
            occurredAt: now,
            payload: native,
          },
        ],
      });
      yield* bridge.reconcile(input);
      const active = (yield* sessions.snapshot(input)).tasks[0]!;
      assert.equal(active.status, "running");
      assert.equal(active.descendants?.[0]?.nativeTaskRef?.nativeId, "genuine-native-child");
      const scope = yield* authenticate(worker.threadId);
      yield* bridge.report(scope, {
        inputId: DeusInputId.make("native-report"),
        runId: worker.runId!,
        subagentId: native.id,
        mode: "SILENT",
        text: "Native result",
      });
      assert.equal((yield* sessions.snapshot(input)).reports[0]?.subagentId, native.id);
      assert.equal(
        (yield* bridge
          .report(scope, {
            inputId: DeusInputId.make("spoof-native"),
            runId: worker.runId!,
            subagentId: NodeId.make("invented-native"),
            mode: "SILENT",
            text: "spoof",
          })
          .pipe(Effect.flip))._tag,
        "DeusStateError",
      );
      assert.isNull(active.descendants?.[0]?.childThreadId);
      const threads = yield* ThreadManagement.ThreadManagementService;
      const run = (yield* threads.getThreadRecords(worker.threadId, ["runs"])).runs[0]!;
      yield* sink.write({
        events: [
          {
            id: EventId.make("parent-done"),
            type: "run.updated",
            threadId: worker.threadId,
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
        ],
      });
      yield* bridge.reconcile(input);
      assert.equal((yield* sessions.snapshot(input)).tasks[0]?.status, "completed");
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "does not regress a terminal-before-ack worker when an authenticated report wins the race",
  () =>
    Effect.gen(function* () {
      const { bridge, sessions, input } = yield* setup;
      yield* sessions.prepareLaunch(input);
      const pending = (yield* sessions.pending)[0]!;
      if (pending.intent.type !== "launch-thread") return assert.fail("Missing launch");
      const launches = yield* ThreadLaunch.ThreadLaunchService;
      yield* launches.launch({
        commandId: pending.intent.commandId,
        threadId: pending.intent.threadId,
        projectId,
        title: input.prompt,
        modelSelection: model,
        runtimeMode: input.runtimeMode,
        interactionMode: "default",
        workspaceStrategy: { type: "root" },
        initialMessage: { text: input.prompt, attachments: [] },
        createdBy: "agent",
        creationSource: "deus",
      });
      const threads = yield* ThreadManagement.ThreadManagementService;
      const run = (yield* threads.getThreadRecords(pending.intent.threadId, ["runs"])).runs[0]!;
      const now = yield* DateTime.now;
      const sink = yield* Sink.EventSinkV2;
      yield* sink.write({
        events: [
          {
            id: EventId.make("early-terminal"),
            threadId: run.threadId,
            type: "run.updated",
            occurredAt: now,
            payload: { ...run, status: "completed", completedAt: now },
          },
        ],
      });
      yield* bridge.report(yield* authenticate(run.threadId), {
        inputId: DeusInputId.make("early-report"),
        runId: run.id,
        mode: "WHEN_IDLE",
        text: "finished before acknowledgment",
      });
      yield* bridge.recover;
      const snapshot = yield* sessions.snapshot(input);
      assert.equal(snapshot.tasks[0]?.status, "completed");
      assert.lengthOf(snapshot.reports, 1);
      assert.lengthOf((yield* threads.getThreadRecords(run.threadId, ["messages"])).messages, 1);
    }).pipe(Effect.provide(harness({ deny: true }))),
);

it.effect("rejects runtime escalation and non-human worktree requests", () =>
  Effect.gen(function* () {
    const { bridge, input } = yield* setup;
    const denied = yield* bridge.launch(input).pipe(Effect.flip);
    assert.equal(denied._tag, "DeusAuthorityError");
    const worktree = yield* bridge
      .launch({ ...input, runtimeMode: "approval-required", workspace: "worktree" })
      .pipe(Effect.flip);
    assert.equal(worktree._tag, "DeusAuthorityError");
  }).pipe(Effect.provide(harness({ ceiling: "approval-required" }))),
);

it.effect(
  "routes an actual app-owned descendant report to its original task and waits for live children",
  () =>
    Effect.gen(function* () {
      const { bridge, sessions, input } = yield* setup;
      const task = yield* bridge.launch(input);
      const worker = task.workers[0]!;
      const threads = yield* ThreadManagement.ThreadManagementService;
      const parent = yield* threads.getThreadRecords(worker.threadId, ["runs"]);
      const root = parent.runs[0]!;
      yield* threads.dispatch({
        type: "delegated_task.request",
        commandId: CommandId.make("real-child"),
        parentThreadId: worker.threadId,
        parentRunId: root.id,
        parentNodeId: root.rootNodeId!,
        task: "Bounded child",
        modelSelection: model,
        runtimeMode: "full-access",
        interactionMode: "default",
        createdBy: "agent",
        creationSource: "mcp",
      });
      const child = (yield* threads.getThreadRecords(worker.threadId, ["subagents"])).subagents[0]!;
      assert.isNotNull(child.childThreadId);
      const childRun = (yield* threads.getThreadRecords(child.childThreadId!, ["runs"])).runs[0]!;
      yield* bridge.report(yield* authenticate(child.childThreadId!), {
        inputId: DeusInputId.make("child-report"),
        runId: childRun.id,
        mode: "INTERRUPT",
        text: "Child result",
      });
      const report = (yield* sessions.snapshot(input)).reports[0]!;
      assert.equal(report.taskId, task.id);
      assert.equal(report.threadId, child.childThreadId);
      assert.equal(report.runId, childRun.id);
      assert.equal(report.conversation, task.conversation);
      const sink = yield* Sink.EventSinkV2;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("parent-terminal-child-live"),
            type: "run.updated",
            threadId: worker.threadId,
            occurredAt: now,
            payload: { ...root, status: "completed", completedAt: now },
          },
        ],
      });
      yield* bridge.reconcile(input);
      assert.equal((yield* sessions.snapshot(input)).tasks[0]?.status, "waiting");
      yield* sink.write({
        events: [
          {
            id: EventId.make("child-terminal"),
            type: "run.updated",
            threadId: childRun.threadId,
            occurredAt: now,
            payload: { ...childRun, status: "completed", completedAt: now },
          },
          {
            id: EventId.make("child-projection-terminal"),
            type: "subagent.updated",
            threadId: worker.threadId,
            occurredAt: now,
            payload: { ...child, status: "completed", completedAt: now },
          },
        ],
      });
      yield* bridge.reconcile(input);
      assert.equal((yield* sessions.snapshot(input)).tasks[0]?.status, "completed");
    }).pipe(Effect.provide(harness())),
);

it.effect(
  "queues, steers and interrupts only registered worker runs and keeps late run identity",
  () =>
    Effect.gen(function* () {
      const { bridge, sessions, input } = yield* setup;
      const task = yield* bridge.launch(input);
      const worker = task.workers[0]!;
      const ref = { ...input, threadId: worker.threadId };
      const threads = yield* ThreadManagement.ThreadManagementService;
      const originalRecords = yield* threads.getThreadRecords(worker.threadId, [
        "runs",
        "attempts",
        "providerThreads",
      ]);
      const original = originalRecords.runs[0]!;
      const attempt = originalRecords.attempts.find(
        (item) => item.id === original.activeAttemptId,
      )!;
      assert.isDefined(attempt);
      const sink = yield* Sink.EventSinkV2;
      const now = yield* DateTime.now;
      const attemptId = attempt.id;
      const providerThreadId = attempt.providerThreadId;
      const turnId = ProviderTurnId.make("external-fixture-turn");
      const providerThread = originalRecords.providerThreads.find(
        (item) => item.id === providerThreadId,
      )!;
      const runtime = yield* (yield* ProviderSessions.ProviderSessionManagerV2).open({
        threadId: worker.threadId,
        providerSessionId: providerThread.providerSessionId!,
        modelSelection: model,
        runtimePolicy: { cwd: null, runtimeMode: "full-access", interactionMode: "default" },
      });
      assert.equal(runtime.providerSessionId, providerThread.providerSessionId);
      yield* sink.write({
        events: [
          {
            id: EventId.make("external-fixture-running"),
            type: "run.updated",
            threadId: worker.threadId,
            occurredAt: now,
            payload: { ...original, status: "running", activeAttemptId: attemptId },
          },
          {
            id: EventId.make("external-fixture-turn"),
            type: "provider-turn.updated",
            threadId: worker.threadId,
            occurredAt: now,
            payload: {
              id: turnId,
              providerThreadId,
              nodeId: original.rootNodeId!,
              runAttemptId: attemptId,
              nativeTurnRef: null,
              ordinal: 1,
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          },
          {
            id: EventId.make("external-fixture-attempt"),
            type: "run-attempt.updated",
            threadId: worker.threadId,
            occurredAt: now,
            payload: {
              ...attempt,
              providerTurnId: turnId,
              status: "running",
              startedAt: now,
              completedAt: null,
            },
          },
        ],
      });
      const queued = yield* bridge.send({
        ...ref,
        commandId: CommandId.make("queue-worker"),
        text: "Queue followup",
        mode: "queue",
      });
      const steered = yield* bridge.send({
        ...ref,
        commandId: CommandId.make("steer-worker"),
        text: "Steer only this worker",
        mode: "steer",
      });
      assert.notEqual(queued, original.id);
      assert.equal(steered, original.id);
      const dispatched = yield* threads.getThreadRecords(worker.threadId, ["messages", "runs"]);
      assert.lengthOf(dispatched.runs, 2);
      assert.isTrue(
        dispatched.messages.some(
          (message) => message.text === "Steer only this worker" && message.runId === original.id,
        ),
      );
      assert.equal(
        (yield* bridge
          .send({
            ...ref,
            threadId: ThreadId.make("foreign"),
            commandId: CommandId.make("foreign-send"),
            text: "No",
            mode: "queue",
          })
          .pipe(Effect.flip))._tag,
        "DeusStateError",
      );
      assert.equal(
        (yield* bridge
          .interrupt({
            ...ref,
            commandId: CommandId.make("foreign-interrupt"),
            runId: RunId.make("foreign-run"),
          })
          .pipe(Effect.flip))._tag,
        "DeusStateError",
      );
      yield* bridge.report(yield* authenticate(worker.threadId), {
        inputId: DeusInputId.make("late-original-run"),
        runId: worker.runId!,
        mode: "WHEN_IDLE",
        text: "Original run result",
      });
      const state = yield* sessions.snapshot(input);
      assert.equal(state.reports[0]?.runId, worker.runId);
      assert.equal(state.tasks[0]?.status, "running");
      yield* bridge.interrupt({
        ...ref,
        commandId: CommandId.make("interrupt-worker"),
        runId: worker.runId!,
      });
    }).pipe(Effect.provide(harness({ externalFixture: true }))),
);

it.effect("keeps successful retry status after a late historical failure", () =>
  Effect.gen(function* () {
    const { bridge, sessions, input } = yield* setup;
    const task = yield* bridge.launch(input);
    const threadId = task.workers[0]!.threadId;
    const threads = yield* ThreadManagement.ThreadManagementService;
    const sink = yield* Sink.EventSinkV2;
    const now = yield* DateTime.now;
    const original = (yield* threads.getThreadRecords(threadId, ["runs"])).runs[0]!;
    yield* sink.write({
      events: [
        {
          id: EventId.make("original-failed"),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...original, status: "failed", completedAt: now },
        },
      ],
    });
    const retryId = yield* bridge.send({
      ...input,
      threadId,
      commandId: CommandId.make("retry"),
      text: "Retry successfully",
      mode: "queue",
    });
    const retry = (yield* threads.getThreadRecords(threadId, ["runs"], { runIds: [retryId] }))
      .runs[0]!;
    yield* bridge.reconcile(input);
    assert.equal((yield* sessions.snapshot(input)).tasks[0]?.status, "running");
    yield* sink.write({
      events: [
        {
          id: EventId.make("retry-completed"),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...retry, status: "completed", completedAt: now },
        },
      ],
    });
    yield* bridge.reconcile(input);
    assert.equal((yield* sessions.snapshot(input)).tasks[0]?.status, "completed");
    yield* sink.write({
      events: [
        {
          id: EventId.make("late-original-failed"),
          type: "run.updated",
          threadId,
          occurredAt: now,
          payload: { ...original, status: "failed", completedAt: now },
        },
      ],
    });
    yield* bridge.reconcile(input);
    const current = (yield* sessions.snapshot(input)).tasks[0]!;
    assert.equal(current.status, "completed");
    assert.deepEqual(
      current.workers.map((worker) => worker.runId),
      [original.id, retryId],
    );
  }).pipe(Effect.provide(harness())),
);

it.effect(
  "reads a coherent latest-run snapshot without relabeling messages or waking workers",
  () =>
    Effect.gen(function* () {
      const { bridge, input } = yield* setup;
      const task = yield* bridge.launch(input);
      const threadId = task.workers[0]!.threadId;
      const latestRunId = yield* bridge.send({
        ...input,
        threadId,
        commandId: CommandId.make("snapshot-followup"),
        text: "Distinct newer run message",
        mode: "queue",
      });
      const threads = yield* ThreadManagement.ThreadManagementService;
      const before = yield* threads.getThreadRecords(threadId, ["runs", "messages"]);
      const snapshot = yield* bridge.read({ ...input, threadId });
      assert.equal(snapshot.runId, latestRunId);
      assert.equal(snapshot.status, before.runs.find((run) => run.id === latestRunId)?.status);
      assert.deepEqual(
        snapshot.messages.map((message) => message.text),
        ["Distinct newer run message"],
      );
      assert.isTrue(snapshot.messages.every((message) => message.runId === latestRunId));
      assert.isTrue(Object.isFrozen(snapshot.messages));
      assert.isTrue(snapshot.messages.every(Object.isFrozen));
      assert.deepEqual(yield* threads.getThreadRecords(threadId, ["runs", "messages"]), before);
    }).pipe(Effect.provide(harness())),
);

it.effect("rejects revoked credentials and a new credential claiming an earlier terminal run", () =>
  Effect.gen(function* () {
    const { bridge, input, sessions } = yield* setup;
    const task = yield* bridge.launch(input);
    const worker = task.workers[0]!;
    const scope = yield* authenticate(worker.threadId);
    const threads = yield* ThreadManagement.ThreadManagementService;
    const run = (yield* threads.getThreadRecords(worker.threadId, ["runs"])).runs[0]!;
    const sink = yield* Sink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make("credential-run-completed"),
          type: "run.updated",
          threadId: worker.threadId,
          occurredAt: now,
          payload: { ...run, status: "completed", completedAt: now },
        },
      ],
    });
    const report = {
      inputId: DeusInputId.make("credential-report"),
      runId: run.id,
      mode: "SILENT" as const,
      text: "Owned late result",
    };
    yield* bridge.report(scope, report);
    const credentials = yield* McpSessions.McpProviderSessions;
    yield* credentials.clear(worker.threadId);
    assert.equal(
      (yield* bridge
        .report(scope, { ...report, inputId: DeusInputId.make("revoked-report") })
        .pipe(Effect.flip))._tag,
      "DeusStateError",
    );
    const replacement = yield* authenticate(worker.threadId, "replacement-session");
    assert.equal(
      (yield* bridge
        .report(
          { ...replacement, issuedAt: DateTime.toEpochMillis(now) + 1 },
          { ...report, inputId: DeusInputId.make("replacement-report") },
        )
        .pipe(Effect.flip))._tag,
      "DeusStateError",
    );
    assert.lengthOf((yield* sessions.snapshot(input)).reports, 1);
  }).pipe(Effect.provide(harness())),
);

it.effect("rejects disabled providers", () =>
  Effect.gen(function* () {
    const { bridge, input } = yield* setup;
    assert.equal((yield* bridge.launch(input).pipe(Effect.flip))._tag, "DeusStateError");
  }).pipe(Effect.provide(harness({ enabled: false }))),
);
