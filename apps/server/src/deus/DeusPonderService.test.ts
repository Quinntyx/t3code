import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { DeusInputId, EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";
import * as Config from "../config.ts";
import * as Identity from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Repository from "./DeusRepository.ts";
import * as Writer from "./DeusMemoryWriter.ts";
import * as Memory from "./DeusMemoryService.ts";
import * as Ponder from "./DeusPonderService.ts";
import * as Worker from "./DeusPonderWorker.ts";
import { dailyPonderDue, type PonderRun } from "./ponderProtocol.ts";
import { DEUS_TOOL_DECLARATIONS } from "./DeusTools.ts";

const environmentId = EnvironmentId.make("ponder-fixture");
const projectId = ProjectId.make("ponder-project");
const base = Repository.layer.pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(Git.layer),
  Layer.provideMerge(
    Layer.succeed(Identity.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "deus-ponder-" })),
  Layer.provideMerge(NodeServices.layer),
);
const setup = Effect.fn("PonderTest.setup")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Ponder fixture','/synthetic','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
  const repository = yield* Repository.DeusRepository;
  const snapshot = yield* repository.open({
    environmentId,
    projectId,
    inputId: DeusInputId.make("open"),
  });
  let sequence = 0;
  const observe = Effect.fn("PonderTest.observe")(function* (text: string) {
    const inputId = DeusInputId.make(`human-${sequence++}`);
    const source = yield* repository.commit({
      type: "input",
      input: { ...snapshot.session, inputId, text },
    });
    yield* repository.commit({
      type: "observe",
      input: {
        ...snapshot.session,
        inputId: DeusInputId.make(`observe-${sequence++}`),
        sourceCursor: source.receipt.cursor,
        kind: "context",
        text,
        supersedes: null,
      },
    });
    return (yield* repository.snapshot(snapshot.session)).observations.at(-1)!;
  });
  const started = yield* Deferred.make<PonderRun>();
  const release = yield* Deferred.make<void>();
  let calls = 0;
  let result: (run: PonderRun) => unknown = (run) => ({
    disposition: "promote",
    reason: "Evidence supports a durable project fact.",
    consumedObservationIds: run.observations.map((item) => item.id),
    entries: [
      {
        kind: "fact",
        scope: "project",
        text: "Synthetic project uses bounded evidence.",
        paths: [],
        evidence: [{ observationId: run.observations[0]!.id, quote: run.observations[0]!.text }],
      },
    ],
  });
  const worker = Layer.succeed(Worker.DeusPonderWorker, {
    run: (run) =>
      Effect.gen(function* () {
        calls++;
        yield* Deferred.succeed(started, run);
        yield* Deferred.await(release);
        return result(run);
      }),
  });
  const services = yield* Layer.build(
    Ponder.layer.pipe(
      Layer.provideMerge(Writer.layer),
      Layer.provide(Memory.layer),
      Layer.provide(worker),
    ),
  );
  const service = Context.get(services, Ponder.DeusPonderService);
  yield* service.configure({ environmentId, projectId, enabled: true });
  const run = Effect.fn("PonderTest.run")(function* () {
    const current = yield* repository.snapshot(snapshot.session);
    return yield* service.runNow({
      ...snapshot.session,
      inputId: DeusInputId.make(`run-${sequence++}`),
      snapshotCursor: current.cursor,
    });
  });
  return {
    sql,
    repository,
    service,
    snapshot,
    observe,
    run,
    started,
    release,
    calls: () => calls,
    result: (next: typeof result) => {
      result = next;
    },
  };
});

it.effect("runs only a live 04:00 crossing, never catches up, and handles local DST days", () =>
  Effect.sync(() => {
    for (const [before, after, expected] of [
      ["2026-03-08T03:59:58-05:00", "2026-03-08T04:00:03-05:00", true],
      ["2026-11-01T03:59:58-06:00", "2026-11-01T04:00:03-06:00", true],
      ["2026-11-01T03:59:58-06:00", "2026-11-01T04:01:00-06:00", false],
    ] as const) {
      assert.equal(
        dailyPonderDue(Date.parse(before), Date.parse(after), "America/Chicago"),
        expected,
      );
    }
    const now = Date.parse("2026-11-01T10:00:01Z");
    assert.isFalse(dailyPonderDue(now, now, "America/Chicago"));
    assert.isFalse(dailyPonderDue(now + 5000, now, "America/Chicago"));
    assert.isFalse(
      DEUS_TOOL_DECLARATIONS.some((tool) => /ponder|learning|run_now/i.test(tool.name ?? "")),
    );
  }),
);

it.effect("serializes manual/daily receipt claims and leaves concurrent arrivals pending", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-01-01T03:59:55"));
    const h = yield* setup();
    const first = yield* h.observe("Synthetic project uses bounded evidence.");
    yield* TestClock.setTime(Date.parse("2026-01-01T04:00:00"));
    const fiber = yield* h.service.runDue.pipe(Effect.forkChild);
    const intent = yield* Deferred.await(h.started);
    const late = yield* h.observe("A record arriving after the snapshot stays pending.");
    const collision = yield* h.run().pipe(Effect.forkChild);
    yield* Deferred.succeed(h.release, undefined);
    yield* Fiber.join(fiber);
    const receipt = yield* Fiber.join(collision);
    yield* h.service.runDue;
    assert.equal(receipt.id, intent.receipt.id);
    assert.equal(h.calls(), 1);
    assert.equal(receipt.status, "succeeded", receipt.error ?? "promotion failed");
    assert.deepEqual(receipt.acknowledgedObservationIds, [first.id]);
    assert.notInclude(receipt.acknowledgedObservationIds, late.id);
    assert.deepEqual(
      intent.observations.map((item) => item.id),
      [first.id],
    );
    const status = yield* h.service.status(h.snapshot.session);
    assert.equal(status.pendingCount, 1);
    assert.equal(status.runs[0]!.writtenMemoryIds.length, 1);
    yield* Effect.logInfo(`STEP11 synthetic promotion: ${JSON.stringify(receipt)}`);
  }).pipe(Effect.provide(base)),
);

it.effect(
  "rejects empty and invalid evidence without acknowledgment and accepts explicit no-change",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const observation = yield* h.observe("A complete synthetic observation.");
      h.result(() => ({}));
      yield* Deferred.succeed(h.release, undefined);
      assert.equal((yield* h.run()).status, "failed");
      h.result(() => ({
        disposition: "promote",
        reason: "Unsupported claim",
        consumedObservationIds: [observation.id],
        entries: [
          {
            kind: "fact",
            scope: "project",
            text: "Unfounded",
            paths: [],
            evidence: [{ observationId: observation.id, quote: "fabricated" }],
          },
        ],
      }));
      assert.equal((yield* h.run()).status, "failed");
      assert.equal((yield* h.service.status(h.snapshot.session)).pendingCount, 1);
      h.result(() => ({
        disposition: "no-change",
        reason: "Transient context; nothing durable to retain.",
        consumedObservationIds: [observation.id],
        entries: [],
      }));
      const receipt = yield* h.run();
      assert.equal(receipt.status, "succeeded");
      assert.deepEqual(receipt.writtenMemoryIds, []);
      assert.deepEqual(receipt.acknowledgedObservationIds, [observation.id]);
    }).pipe(Effect.provide(base)),
);

it.effect("persists commit intent and recovers a crash between Git commit and acknowledgment", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.observe("Synthetic project uses bounded evidence.");
    yield* Deferred.succeed(h.release, undefined);
    yield* h.sql`CREATE TRIGGER synthetic_ack_crash BEFORE UPDATE ON deus_ponder_runs WHEN json_extract(NEW.run_json, '$.receipt.status') = 'succeeded' BEGIN SELECT RAISE(ABORT, 'synthetic crash after Git commit'); END`;
    yield* h.run().pipe(Effect.exit);
    assert.equal((yield* h.service.status(h.snapshot.session)).pendingCount, 1);
    yield* h.sql`DROP TRIGGER synthetic_ack_crash`;
    yield* h.service.recover;
    const status = yield* h.service.status(h.snapshot.session);
    assert.equal(status.pendingCount, 0, status.runs[0]?.error ?? "recovery failed");
    assert.equal(status.runs[0]!.status, "succeeded");
    assert.equal(h.calls(), 1);
    const config = yield* Config.ServerConfig;
    const git = yield* Git.GitVcsDriver;
    const result = yield* git.execute({
      cwd: `${config.stateDir}/deus-memory`,
      args: ["rev-list", "--count", "HEAD"],
      operation: "synthetic-recovery-proof",
    });
    assert.equal(result.stdout.trim(), "1");
  }).pipe(Effect.provide(base)),
);

it.effect("keeps failed Git promotion retryable without another worker", () =>
  Effect.gen(function* () {
    const h = yield* setup();
    yield* h.observe("Synthetic project uses bounded evidence.");
    const config = yield* Config.ServerConfig;
    const fs = yield* FileSystem.FileSystem;
    const git = yield* Git.GitVcsDriver;
    const root = `${config.stateDir}/deus-memory`;
    yield* fs.makeDirectory(root, { recursive: true });
    yield* git.execute({
      cwd: root,
      args: ["init", "--quiet"],
      operation: "synthetic-lock-fixture",
    });
    yield* fs.writeFileString(`${root}/.git/index.lock`, "synthetic lock");
    yield* Deferred.succeed(h.release, undefined);
    const failed = yield* h.run();
    assert.equal(failed.status, "failed");
    assert.deepEqual(failed.acknowledgedObservationIds, []);
    assert.equal((yield* h.service.status(h.snapshot.session)).pendingCount, 1);
    yield* fs.rename(`${root}/.git/index.lock`, `${config.stateDir}/synthetic-lock`);
    const retried = yield* h.run();
    assert.equal(retried.status, "succeeded", retried.error ?? "retry failed");
    assert.equal(retried.id, failed.id);
    assert.equal(h.calls(), 1);
  }).pipe(Effect.provide(base)),
);

it.effect(
  "never consumes oversized omitted records and visibly recovers an interrupted worker",
  () =>
    Effect.gen(function* () {
      const h = yield* setup();
      const omitted = yield* h.observe("x".repeat(5000));
      const complete = yield* h.observe("A complete bounded observation.");
      const fiber = yield* h.run().pipe(Effect.forkChild);
      const snapshot = yield* Deferred.await(h.started);
      assert.deepEqual(
        snapshot.observations.map((record) => record.id),
        [complete.id],
      );
      assert.equal(snapshot.omitted, 1);
      yield* Fiber.interrupt(fiber);
      yield* h.service.recover;
      const status = yield* h.service.status(h.snapshot.session);
      assert.equal(status.runs[0]!.status, "failed");
      assert.include(status.runs[0]!.error!, "interrupted");
      assert.notInclude(status.runs[0]!.acknowledgedObservationIds, omitted.id);
      assert.equal(status.pendingCount, 2);
    }).pipe(Effect.provide(base)),
);

it.effect("an idle project neither claims the day nor blocks another project's daily run", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-01-01T03:59:55"));
    const h = yield* setup();
    const otherId = ProjectId.make("ponder-project-other");
    yield* h.sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${otherId},'Other fixture','/synthetic-other','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
    yield* h.service.configure({ environmentId, projectId: otherId, enabled: true });
    const other = yield* h.repository.open({
      environmentId,
      projectId: otherId,
      inputId: DeusInputId.make("open-other"),
    });
    const source = yield* h.repository.commit({
      type: "input",
      input: { ...other.session, inputId: DeusInputId.make("other-input"), text: "Other fact." },
    });
    yield* h.repository.commit({
      type: "observe",
      input: {
        ...other.session,
        inputId: DeusInputId.make("other-observe"),
        sourceCursor: source.receipt.cursor,
        kind: "context",
        text: "Other fact.",
        supersedes: null,
      },
    });
    yield* Deferred.succeed(h.release, undefined);
    yield* TestClock.setTime(Date.parse("2026-01-01T04:00:00"));
    yield* h.service.runDue;
    assert.equal(h.calls(), 1);
    assert.equal((yield* h.service.status(other.session)).runs[0]!.status, "succeeded");
    assert.deepEqual((yield* h.service.status(h.snapshot.session)).runs, []);
    yield* h.observe("Synthetic project uses bounded evidence.");
    assert.equal((yield* h.run()).status, "succeeded");
  }).pipe(Effect.provide(base)),
);

it.effect("takes scheduling time from TestClock without a catch-up run", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-01-01T13:00:00Z"));
    const h = yield* setup();
    yield* h.service.runDue;
    assert.equal(h.calls(), 0);
  }).pipe(Effect.provide(base)),
);
