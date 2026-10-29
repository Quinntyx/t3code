import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  DeusConversation,
  DeusCursor,
  DeusInputId,
  DeusSessionId,
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  type DeusSessionRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as DateTime from "effect/DateTime";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as EventStore from "../persistence/OrchestrationEventStore.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as ThreadEventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as DeusRepository from "./DeusRepository.ts";
import * as DeusSessionService from "./DeusSessionService.ts";

const environmentId = EnvironmentId.make("deus-test-environment");
const projectId = ProjectId.make("deus-test-project");
const scope = { environmentId, projectId };
const inputId = (id: string) => DeusInputId.make(id);
const services = DeusSessionService.layer.pipe(
  Layer.provideMerge(DeusRepository.layer),
  Layer.provide(EventStore.layer),
  Layer.provide(
    Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
);
const database = Sqlite.layerMemory.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "deus-session-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const testLayer = services.pipe(Layer.provideMerge(database));
const projectLayer = EventSink.layer.pipe(
  Layer.provide(
    Layer.mergeAll(ThreadEventStore.layerFromOrchestrationEventStore, ProjectionStore.layer),
  ),
  Layer.provideMerge(EventStore.layer),
  Layer.provideMerge(testLayer),
);
const seed = Effect.fn("DeusTest.seed")(function* (id: ProjectId = projectId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root,
    scripts_json, created_at, updated_at) VALUES (${id}, 'Deus fixture', ${`/test/${id}`},
    '[]', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`;
});
const open = Effect.gen(function* () {
  yield* seed();
  return yield* (yield* DeusSessionService.DeusSessionService).open({
    ...scope,
    inputId: inputId("open"),
  });
});
const deleteProject = Effect.gen(function* () {
  const sink = yield* EventSink.EventSinkV2;
  const commandId = CommandId.make("delete-project");
  yield* sink.commitProjectCommand({
    commandId,
    projectId,
    commandType: "project.delete",
    acceptedAt: yield* DateTime.now,
    event: {
      eventId: EventId.make("delete-project"),
      aggregateKind: "project",
      aggregateId: projectId,
      occurredAt: "2026-01-02T00:00:00.000Z",
      commandId,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "project.deleted",
      payload: { projectId, deletedAt: "2026-01-02T00:00:00.000Z" },
    },
  });
});
function text(ref: DeusSessionRef, id = "text", content = "Coordinate this work") {
  return { ...ref, inputId: inputId(id), conversation: DeusConversation.make(1), text: content };
}
function launch(ref: DeusSessionRef) {
  return {
    ...ref,
    inputId: inputId("launch"),
    conversation: DeusConversation.make(1),
    prompt: "Bounded fake-boundary fixture",
    kind: "work" as const,
    model: {
      instanceId: ProviderInstanceId.make("pi-fixture"),
      model: "fixture-not-a-provider-call",
    },
    runtimeMode: "full-access" as const,
    workspace: "project" as const,
  };
}

it.effect(
  "opens one standalone session without a thread and replays compatible commands only",
  () =>
    Effect.gen(function* () {
      const service = yield* DeusSessionService.DeusSessionService;
      const snapshot = yield* open;
      const again = yield* service.open({ ...scope, inputId: inputId("open-again") });
      assert.equal(again.session.sessionId, snapshot.session.sessionId);
      const accepted = yield* service.acceptInput(text(snapshot.session));
      const replay = yield* service.acceptInput(text(snapshot.session));
      assert.equal(accepted.status, "accepted");
      assert.deepEqual(replay, { ...accepted, status: "replayed" });
      const conflict = yield* service
        .acceptInput(text(snapshot.session, "text", "Different content"))
        .pipe(Effect.flip);
      assert.equal(conflict._tag, "DeusStateError");
      const current = yield* service.snapshot(snapshot.session);
      assert.lengthOf(current.transcripts, 1);
      assert.lengthOf(yield* service.pending, 1);
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_threads`)[0]?.count,
        0,
      );
      assert.equal(
        (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM orchestration_events`)[0]
          ?.count,
        0,
      );
      assert.equal(
        (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM orchestration_v2_events`)[0]
          ?.count,
        0,
      );
      assert.equal(
        (yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_v2_projection_provider_threads`)[0]?.count,
        0,
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects foreign environment/project/session and deleted or missing projects", () =>
  Effect.gen(function* () {
    const service = yield* DeusSessionService.DeusSessionService;
    const { session } = yield* open;
    const otherProject = ProjectId.make("other-project");
    yield* seed(otherProject);
    for (const ref of [
      { ...session, environmentId: EnvironmentId.make("foreign") },
      { ...session, projectId: otherProject },
      { ...session, sessionId: DeusSessionId.make("missing-session") },
    ]) {
      assert.equal((yield* service.snapshot(ref).pipe(Effect.flip))._tag, "DeusStateError");
    }
    assert.equal(
      (yield* service
        .open({ ...scope, projectId: ProjectId.make("missing"), inputId: inputId("missing") })
        .pipe(Effect.flip))._tag,
      "DeusStateError",
    );
    yield* deleteProject;
    assert.equal(
      (yield* service.acceptInput(text(session)).pipe(Effect.flip))._tag,
      "DeusStateError",
    );
    const sql = yield* SqlClient.SqlClient;
    assert.isNotNull(
      (yield* sql<{ closed_at: string | null }>`SELECT closed_at FROM deus_sessions`)[0]?.closed_at,
    );
  }).pipe(Effect.provide(projectLayer)),
);

it.effect(
  "rolls back projections, events, receipts and outbox before notifying on SQL failure",
  () =>
    Effect.gen(function* () {
      const service = yield* DeusSessionService.DeusSessionService;
      const { session } = yield* open;
      const sql = yield* SqlClient.SqlClient;
      const stream = yield* service.subscribe({ ...session, after: DeusCursor.make(0) });
      yield* sql`CREATE TRIGGER fail_deus_intent BEFORE INSERT ON deus_outbox BEGIN SELECT RAISE(ABORT, 'fixture rollback'); END`;
      assert.equal(
        (yield* service.acceptInput(text(session)).pipe(Effect.flip))._tag,
        "DeusPersistenceError",
      );
      assert.equal((yield* service.snapshot(session)).cursor, 0);
      assert.equal(
        (yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM deus_events`)[0]?.count,
        0,
      );
      assert.equal(
        (yield* sql<{
          count: number;
        }>`SELECT COUNT(*) AS count FROM deus_receipts WHERE input_id = 'text'`)[0]?.count,
        0,
      );
      yield* sql`DROP TRIGGER fail_deus_intent`;
      yield* service.acceptInput(text(session));
      const events = yield* stream.pipe(Stream.take(2), Stream.runCollect);
      assert.deepEqual(
        events.map((event) => event.type),
        ["snapshot", "delta"],
      );
      assert.lengthOf(yield* service.pending, 1);
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "reset retains work and memory; late reports retain the original task conversation and run",
  () =>
    Effect.gen(function* () {
      const service = yield* DeusSessionService.DeusSessionService;
      const { session } = yield* open;
      yield* service.acceptInput(text(session));
      const launched = yield* service.prepareLaunch(launch(session));
      const intent = (yield* service.pending).find((item) => item.intent.type === "launch-thread");
      assert.isDefined(intent);
      if (!intent || intent.intent.type !== "launch-thread") return assert.fail("No launch intent");
      const runId = RunId.make("original-run");
      yield* service.acknowledgeLaunch({
        ...session,
        inputId: inputId("ack"),
        taskId: launched.task.id,
        threadId: intent.intent.threadId,
        commandId: intent.intent.commandId,
        runId,
      });
      const sql = yield* SqlClient.SqlClient;
      yield* sql`UPDATE deus_sessions SET snapshot_json = json_set(snapshot_json, '$.memories',
      json('[{"id":"memory-fixture","revision":1,"text":"Retain this","observationIds":[],"ponderId":null,"supersedes":null,"removedAt":null,"updatedAt":"2026-01-01T00:00:00.000Z"}]'))`;
      const reset = {
        ...session,
        inputId: inputId("reset"),
        conversation: DeusConversation.make(1),
      };
      yield* service.resetConversation(reset);
      assert.equal((yield* service.resetConversation(reset)).status, "replayed");
      assert.equal((yield* service.acceptInput(text(session))).status, "replayed");
      assert.equal(
        (yield* service.acceptInput(text(session, "stale-input")).pipe(Effect.flip))._tag,
        "DeusStateError",
      );
      const report = {
        ...session,
        inputId: inputId("report"),
        taskId: launched.task.id,
        threadId: intent.intent.threadId,
        runId,
        mode: "WHEN_IDLE" as const,
        text: "Late original result",
      };
      yield* service.recordReport(report);
      assert.equal((yield* service.recordReport(report)).status, "replayed");
      assert.equal(
        (yield* service
          .recordReport({ ...report, inputId: inputId("spoof"), runId: RunId.make("wrong-run") })
          .pipe(Effect.flip))._tag,
        "DeusStateError",
      );
      const current = yield* service.snapshot(session);
      assert.equal(current.session.conversation, 2);
      assert.lengthOf(current.transcripts, 1);
      assert.equal(current.transcripts[0]?.conversation, 1);
      assert.equal(current.tasks[0]?.conversation, 1);
      assert.equal(current.tasks[0]?.status, "running");
      assert.equal(current.tasks[0]?.workers[0]?.runId, runId);
      assert.equal(current.reports[0]?.runId, runId);
      assert.lengthOf(current.observations, 1);
      assert.equal(current.observations[0]?.text, report.text);
      assert.deepInclude(current.observations[0], {
        conversation: DeusConversation.make(1),
        taskId: launched.task.id,
        inputId: report.inputId,
        kind: "report",
        source: {
          ...scope,
          sessionId: session.sessionId,
          cursor: current.reports[0]!.cursor,
        },
      });
      assert.equal(current.memories[0]?.text, "Retain this");
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "buffers snapshot/live overlap, deduplicates replay, and catches up beyond the signal buffer",
  () =>
    Effect.gen(function* () {
      const service = yield* DeusSessionService.DeusSessionService;
      const { session } = yield* open;
      const stream = yield* service.subscribe({ ...session, after: DeusCursor.make(0) });
      for (let index = 1; index <= 135; index++) {
        yield* service.acceptInput(text(session, `input-${index}`));
      }
      const events = yield* stream.pipe(Stream.take(136), Stream.runCollect);
      assert.equal(events[0]?.type, "snapshot");
      assert.deepEqual(
        events.flatMap((event) => (event.type === "delta" ? [event.delta.cursor] : [])),
        Array.from({ length: 135 }, (_, index) => index + 1),
      );
      const resumed = yield* service.subscribe({ ...session, after: DeusCursor.make(133) });
      yield* service.acceptInput(text(session, "input-136"));
      const replay = yield* resumed.pipe(Stream.take(3), Stream.runCollect);
      assert.deepEqual(
        replay.flatMap((event) => (event.type === "delta" ? [event.delta.cursor] : [])),
        [134, 135, 136],
      );
      assert.equal(
        (yield* service.subscribe({ ...session, after: DeusCursor.make(999) }).pipe(Effect.flip))
          ._tag,
        "DeusStateError",
      );
    }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "retains pending intent on deletion without cancelling unrelated sessions or worker work",
  () =>
    Effect.gen(function* () {
      const service = yield* DeusSessionService.DeusSessionService;
      const { session } = yield* open;
      yield* service.prepareLaunch(launch(session));
      const otherProject = ProjectId.make("surviving-project");
      yield* seed(otherProject);
      const other = yield* service.open({
        ...scope,
        projectId: otherProject,
        inputId: inputId("other-open"),
      });
      yield* deleteProject;
      assert.equal((yield* service.snapshot(other.session)).cursor, 0);
      assert.lengthOf(yield* service.pending, 0);
      const sql = yield* SqlClient.SqlClient;
      assert.equal(
        (yield* sql<{ status: string }>`SELECT status FROM deus_outbox`)[0]?.status,
        "pending",
      );
      assert.equal(
        (yield* sql<{
          snapshot_json: string;
        }>`SELECT snapshot_json FROM deus_sessions WHERE session_id = ${session.sessionId}`)[0]?.snapshot_json.includes(
          '"status":"pending"',
        ),
        true,
      );
    }).pipe(Effect.provide(projectLayer)),
);

it.effect("closes an attached subscription through the committed project lifecycle", () =>
  Effect.gen(function* () {
    const service = yield* DeusSessionService.DeusSessionService;
    const { session } = yield* open;
    yield* service.start;
    const stream = yield* service.subscribe({ ...session, after: DeusCursor.make(0) });
    const closed = yield* stream.pipe(Stream.runDrain, Effect.forkScoped);
    yield* deleteProject;
    assert.isTrue(Exit.isFailure(yield* Fiber.await(closed)));
  }).pipe(Effect.provide(projectLayer)),
);

it.effect("serializes concurrent duplicate submissions before allocating durable work", () =>
  Effect.gen(function* () {
    const service = yield* DeusSessionService.DeusSessionService;
    const { session } = yield* open;
    const results = yield* Effect.all(
      [service.prepareLaunch(launch(session)), service.prepareLaunch(launch(session))],
      { concurrency: "unbounded" },
    );
    assert.deepEqual(results.map((result) => result.receipt.status).toSorted(), [
      "accepted",
      "replayed",
    ]);
    assert.equal(results[0]?.task.id, results[1]?.task.id);
    assert.lengthOf(yield* service.pending, 1);
    assert.lengthOf((yield* service.snapshot(session)).tasks, 1);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("recovers intents in committed cursor order rather than caller input-ID order", () =>
  Effect.gen(function* () {
    const service = yield* DeusSessionService.DeusSessionService;
    const { session } = yield* open;
    yield* service.acceptInput(text(session, "z-first"));
    yield* service.acceptInput(text(session, "a-second"));
    assert.deepEqual(
      (yield* service.recover).map((item) => item.inputId),
      ["z-first", "a-second"],
    );
  }).pipe(Effect.provide(testLayer)),
);

it.effect(
  "reopens SQLite after commit and reconciles the same allocated identity at a fake external boundary",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped({ prefix: "deus-restart-" });
      const dbPath = `${home}/statev2.sqlite`;
      const db = Sqlite.layerFromPath(dbPath);
      const externalReceipts = new Map<string, string>();
      const first = yield* Effect.gen(function* () {
        const service = yield* DeusSessionService.DeusSessionService;
        const { session } = yield* open;
        const command = launch(session);
        const prepared = yield* service.prepareLaunch(command);
        const pending = yield* service.pending;
        const launchIntent = pending[0];
        if (!launchIntent || launchIntent.intent.type !== "launch-thread")
          return assert.fail("Missing intent");
        // The fake boundary commits before teardown; its acknowledgment never reaches SQLite.
        externalReceipts.set(launchIntent.intent.commandId, launchIntent.intent.threadId);
        return { session, command, prepared, pending };
      }).pipe(Effect.provide(services.pipe(Layer.provideMerge(db))), Effect.scoped);
      yield* Effect.gen(function* () {
        const service = yield* DeusSessionService.DeusSessionService;
        const recovered = yield* service.recover;
        assert.deepEqual(recovered, first.pending);
        const replay = yield* service.prepareLaunch(first.command);
        assert.equal(replay.task.id, first.prepared.task.id);
        assert.equal(replay.receipt.status, "replayed");
        const pending = recovered[0];
        if (!pending || pending.intent.type !== "launch-thread")
          return assert.fail("Missing recovered intent");
        assert.equal(externalReceipts.get(pending.intent.commandId), pending.intent.threadId);
        assert.equal(externalReceipts.size, 1);
        yield* service.acknowledgeLaunch({
          ...first.session,
          inputId: inputId("ack-recovered"),
          taskId: pending.intent.taskId,
          threadId: pending.intent.threadId,
          commandId: pending.intent.commandId,
          runId: RunId.make("fake-run"),
        });
        assert.lengthOf(yield* service.pending, 0);
        yield* Effect.logInfo(
          "DEUS SERVICE HARNESS: reopened SQLite; compatible retry replayed; one stable task/thread/command; fake receipt reconciled; pending -> acknowledged. No real ThreadLaunchService or model calls.",
        );
      }).pipe(
        Effect.provide(services.pipe(Layer.provideMerge(Sqlite.layerFromPath(dbPath)))),
        Effect.scoped,
      );
    }).pipe(Effect.provide(NodeServices.layer)),
);
