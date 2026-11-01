import {
  DeusInputId,
  DeusPonderId,
  DeusSessionRef,
  DeusScope,
  DeusLearningInput,
  DeusLearningStatus,
  DeusPonderInput,
  DeusPonderReceipt,
  DeusStateError,
  DeusObservation,
  ModelSelection,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { forkParked } from "../serverActivation.ts";
import * as Repository from "./DeusRepository.ts";
import * as Writer from "./DeusMemoryWriter.ts";
import * as Worker from "./DeusPonderWorker.ts";
import {
  PONDER_LIMITS,
  PonderRun,
  PromotionResult,
  dailyPonderDue,
  localDay,
  ponderError,
  validatePromotion,
} from "./ponderProtocol.ts";

type Failure = Repository.DeusRepositoryError;
export class DeusPonderService extends Context.Service<
  DeusPonderService,
  {
    readonly configure: (input: DeusLearningInput) => Effect.Effect<DeusLearningStatus, Failure>;
    readonly status: (input: DeusScope) => Effect.Effect<DeusLearningStatus, Failure>;
    readonly runNow: (input: DeusPonderInput) => Effect.Effect<DeusPonderReceipt, Failure>;
    readonly runDue: Effect.Effect<void, Failure>;
    readonly recover: Effect.Effect<void, Failure>;
    readonly start: Effect.Effect<void, never, Scheduler.Scheduler | Scope.Scope>;
  }
>()("t3/deus/DeusPonderService") {}
const isStateError = Schema.is(DeusStateError);
const decodeModel = Schema.decodeEffect(Schema.fromJsonString(ModelSelection));
const decodeSession = Schema.decodeEffect(DeusSessionRef);
const decodeLearning = Schema.decodeEffect(DeusLearningInput);
const decodePonder = Schema.decodeEffect(DeusPonderInput);
const decodeScope = Schema.decodeEffect(DeusScope);
const decodeRun = Schema.decodeEffect(Schema.fromJsonString(PonderRun));
const encodeRun = Schema.encodeSync(Schema.fromJsonString(PonderRun));
const decodeResult = Schema.decodeUnknownEffect(PromotionResult);
const encodeModel = Schema.encodeSync(Schema.fromJsonString(ModelSelection));
const encodeObservation = Schema.encodeSync(Schema.fromJsonString(DeusObservation));
const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const repository = yield* Repository.DeusRepository;
  const writer = yield* Writer.DeusMemoryWriter;
  const worker = yield* Worker.DeusPonderWorker;
  const crypto = yield* Crypto.Crypto;
  const lane = yield* Semaphore.make(1);
  const previous = yield* Ref.make(yield* Clock.currentTimeMillis);
  const persistence = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError((cause) =>
        isStateError(cause)
          ? cause
          : new Repository.DeusPersistenceError({ operation: "ponder", cause }),
      ),
    );
  const save = Effect.fn("DeusPonderService.save")((run: PonderRun) =>
    persistence(
      sql`UPDATE deus_ponder_runs SET run_json = ${encodeRun(run)} WHERE environment_id = ${run.environmentId} AND project_id = ${run.projectId} AND local_date = ${run.localDate}`,
    ).pipe(Effect.asVoid),
  );
  const runs = Effect.fn("DeusPonderService.runs")(function* (scope: DeusScope) {
    const rows = yield* persistence(
      sql<{
        run_json: string;
      }>`SELECT run_json FROM deus_ponder_runs WHERE environment_id = ${scope.environmentId} AND project_id = ${scope.projectId} ORDER BY local_date DESC LIMIT 32`,
    );
    return yield* Effect.forEach(rows, (row) => persistence(decodeRun(row.run_json)));
  });
  const pending = Effect.fn("DeusPonderService.pending")(function* (ref: DeusSessionRef) {
    const snapshot = yield* repository.snapshot(ref);
    const rows = yield* persistence(
      sql<{
        observation_id: string;
      }>`SELECT observation_id FROM deus_ponder_acknowledgments WHERE project_id = ${ref.projectId}`,
    );
    const acknowledged = new Set(rows.map((row) => row.observation_id));
    return {
      snapshot,
      observations: snapshot.observations.filter((record) => !acknowledged.has(record.id)),
    };
  });
  const settings = Effect.fn("DeusPonderService.settings")(function* (scope: DeusScope) {
    yield* repository.validateScope(scope);
    const rows = yield* persistence(
      sql<{
        enabled: number;
        model_json: string | null;
      }>`SELECT enabled, model_json FROM deus_learning_projects WHERE environment_id = ${scope.environmentId} AND project_id = ${scope.projectId}`,
    );
    const row = rows[0];
    const model = row?.model_json ? yield* persistence(decodeModel(row.model_json)) : null;
    return { enabled: row?.enabled === 1, model };
  });
  const status = Effect.fn("DeusPonderService.status")(function* (scope: DeusScope) {
    const config = yield* settings(scope);
    const sessions = yield* persistence(
      sql<{
        session_id: string;
      }>`SELECT session_id FROM deus_sessions WHERE environment_id = ${scope.environmentId} AND project_id = ${scope.projectId} AND closed_at IS NULL LIMIT 1`,
    );
    const ref = sessions[0]
      ? yield* persistence(decodeSession({ ...scope, sessionId: sessions[0].session_id }))
      : null;
    return {
      environmentId: scope.environmentId,
      projectId: scope.projectId,
      ...config,
      pendingCount: ref ? (yield* pending(ref)).observations.length : 0,
      runs: (yield* runs(scope)).map((run) => run.receipt),
    };
  });
  const configure = Effect.fn("DeusPonderService.configure")(function* (raw: DeusLearningInput) {
    const input = yield* persistence(decodeLearning(raw));
    const current = yield* settings(input);
    const model = input.model === undefined ? current.model : input.model;
    yield* persistence(
      sql`INSERT INTO deus_learning_projects (environment_id,project_id,enabled,model_json) VALUES (${input.environmentId},${input.projectId},${input.enabled ? 1 : 0},${model === null ? null : encodeModel(model)}) ON CONFLICT (environment_id,project_id) DO UPDATE SET enabled=excluded.enabled,model_json=excluded.model_json`,
    );
    return yield* status(input);
  }, lane.withPermits(1));
  const promote = Effect.fn("DeusPonderService.promote")(function* (run: PonderRun) {
    const result = yield* writer.commit(run);
    run = {
      ...run,
      commit: result.commit,
      receipt: { ...run.receipt, commit: result.commit, writtenMemoryIds: result.ids },
    };
    yield* save(run);
    const completedAt = DateTime.formatIso(yield* DateTime.now);
    const receipt: DeusPonderReceipt = {
      ...run.receipt,
      status: "succeeded",
      error: null,
      completedAt,
      acknowledgedObservationIds: run.intent!.consumedObservationIds,
      counts: {
        snapshot: run.observations.length,
        omitted: run.omitted,
        consumed: run.intent!.consumedObservationIds.length,
        written: result.ids.length,
      },
    };
    yield* persistence(
      sql.withTransaction(
        Effect.gen(function* () {
          for (const id of receipt.acknowledgedObservationIds)
            yield* sql`INSERT INTO deus_ponder_acknowledgments (observation_id,project_id,ponder_id) VALUES (${id},${run.projectId},${receipt.id}) ON CONFLICT (observation_id) DO NOTHING`;
          yield* save({ ...run, receipt });
        }),
      ),
    );
    return receipt;
  });
  const failed = Effect.fn("DeusPonderService.failed")(function* (run: PonderRun, error: string) {
    const latest = yield* persistence(
      sql<{
        run_json: string;
      }>`SELECT run_json FROM deus_ponder_runs WHERE environment_id=${run.environmentId} AND project_id=${run.projectId} AND local_date=${run.localDate}`,
    );
    if (latest[0]) run = yield* persistence(decodeRun(latest[0].run_json));
    const receipt: DeusPonderReceipt = {
      ...run.receipt,
      status: "failed",
      completedAt: DateTime.formatIso(yield* DateTime.now),
      error,
    };
    yield* save({ ...run, receipt });
    return receipt;
  });
  const execute = Effect.fn("DeusPonderService.execute")(function* (run: PonderRun) {
    if (run.intent) return yield* promote(run);
    const result = yield* worker.run(run).pipe(
      Effect.flatMap((raw) => decodeResult(raw)),
      Effect.mapError(() =>
        ponderError("Learning worker failed or returned an invalid structured result."),
      ),
    );
    yield* Effect.try({
      try: () => validatePromotion(run, result),
      catch: () =>
        ponderError("Learning result has invalid evidence, scope, paths, or consumption."),
    });
    const intent = { ...run, intent: result };
    yield* save(intent);
    return yield* promote(intent);
  });
  const runNow = Effect.fn("DeusPonderService.runNow")(function* (
    raw: DeusPonderInput,
    daily = false,
  ) {
    const input = yield* persistence(decodePonder(raw));
    const config = yield* settings(input);
    if (!config.enabled)
      return yield* ponderError(
        "Project learning is disabled. Enable it explicitly before running.",
      );
    const { snapshot, observations } = yield* pending(input);
    const date = localDay(yield* Clock.currentTimeMillis).date;
    const rows = yield* persistence(
      sql<{
        run_json: string;
      }>`SELECT run_json FROM deus_ponder_runs WHERE environment_id = ${input.environmentId} AND project_id = ${input.projectId} AND local_date = ${date}`,
    );
    let run = rows[0] ? yield* persistence(decodeRun(rows[0].run_json)) : null;
    if (run && (daily || run.receipt.status === "succeeded")) return run.receipt;
    const now = DateTime.formatIso(yield* DateTime.now);
    if (run) {
      const attempt = run.intent ? run.attempt : run.attempt + 1;
      const threadId = run.intent ? run.threadId : ThreadId.make(`${run.receipt.id}:${attempt}`);
      run = {
        ...run,
        model: run.intent ? run.model : config.model,
        attempt,
        threadId,
        receipt: {
          ...run.receipt,
          attempt,
          threadId,
          status: "running",
          startedAt: now,
          completedAt: null,
          error: null,
        },
      };
      yield* save(run);
    } else {
      if (snapshot.cursor !== input.snapshotCursor)
        return yield* ponderError("Learning snapshot cursor is stale.");
      let bytes = 0;
      const selected = observations
        .filter((record) => {
          const size = Buffer.byteLength(encodeObservation(record));
          if (size > PONDER_LIMITS.observationBytes || bytes + size > PONDER_LIMITS.snapshotBytes)
            return false;
          bytes += size;
          return true;
        })
        .slice(0, PONDER_LIMITS.observations);
      // An idle snapshot must not claim the day's receipt; later arrivals stay runnable today.
      if (selected.length === 0)
        return yield* ponderError("No complete pending observations fit the learning snapshot.");
      const id = DeusPonderId.make(`ponder-${yield* persistence(crypto.randomUUIDv4())}`);
      const threadId = ThreadId.make(`${id}:1`);
      const receipt: DeusPonderReceipt = {
        id,
        snapshotCursor: snapshot.cursor,
        observationIds: selected.map((item) => item.id),
        status: "running",
        writtenMemoryIds: [],
        acknowledgedObservationIds: [],
        error: null,
        createdAt: now,
        startedAt: now,
        completedAt: null,
        localDate: date,
        attempt: 1,
        threadId,
        commit: null,
        counts: {
          snapshot: selected.length,
          omitted: observations.length - selected.length,
          consumed: 0,
          written: 0,
        },
      };
      run = {
        ...input,
        localDate: date,
        receipt,
        model: config.model,
        threadId,
        attempt: 1,
        observations: selected,
        history: snapshot.transcripts
          .slice(-PONDER_LIMITS.history)
          .filter((item) => Buffer.byteLength(item.text) <= PONDER_LIMITS.observationBytes),
        omitted: observations.length - selected.length,
        intent: null,
        commit: null,
      };
      yield* persistence(
        sql`INSERT INTO deus_ponder_runs (environment_id,project_id,local_date,run_json) VALUES (${input.environmentId},${input.projectId},${date},${encodeRun(run)})`,
      );
    }
    if (run.observations.length === 0)
      return yield* failed(run, "No complete pending observations fit the learning snapshot.");
    const current = run;
    return yield* execute(current).pipe(
      Effect.catch((error) =>
        failed(
          current,
          error instanceof Error ? error.message : "Learning failed; retry the persisted run.",
        ),
      ),
      Effect.onInterrupt(() =>
        failed(current, "Learning owner was interrupted; retry explicitly.").pipe(Effect.ignore),
      ),
    );
  }, lane.withPermits(1));
  const recover = Effect.gen(function* () {
    const rows = yield* persistence(
      sql<{
        run_json: string;
      }>`SELECT run_json FROM deus_ponder_runs WHERE json_extract(run_json,'$.receipt.status') = 'running' OR (json_extract(run_json,'$.receipt.status') = 'failed' AND json_extract(run_json,'$.intent') IS NOT NULL)`,
    );
    for (const row of rows) {
      const run = yield* persistence(decodeRun(row.run_json));
      if (run.intent)
        yield* promote(run).pipe(
          Effect.catch(() =>
            failed(run, "Interrupted promotion recovery failed; retry the persisted intent."),
          ),
        );
      else yield* failed(run, "Learning was interrupted by server restart; retry explicitly.");
    }
  }).pipe(lane.withPermits(1));
  const runDue = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const before = yield* Ref.getAndSet(previous, now);
    if (!dailyPonderDue(before, now)) return;
    const projects = yield* persistence(
      sql<{
        environment_id: string;
        project_id: string;
      }>`SELECT l.environment_id,l.project_id FROM deus_learning_projects l JOIN projection_projects p ON p.project_id=l.project_id WHERE l.enabled=1 AND p.deleted_at IS NULL`,
    );
    for (const project of projects) {
      yield* Effect.gen(function* () {
        const scope = yield* persistence(
          decodeScope({
            environmentId: project.environment_id,
            projectId: project.project_id,
          }),
        );
        const snapshot = yield* repository.open({
          ...scope,
          inputId: DeusInputId.make(`daily:${localDay(now).date}`),
        });
        yield* runNow(
          {
            ...snapshot.session,
            inputId: DeusInputId.make(`daily:${localDay(now).date}`),
            snapshotCursor: snapshot.cursor,
          },
          true,
        );
      }).pipe(
        // One project's failure must not cost the others their only run of the day.
        Effect.catch((error) =>
          Effect.logWarning("Deus daily learning failed", { projectId: project.project_id, error }),
        ),
      );
    }
  });
  const start = Effect.gen(function* () {
    const scheduler = yield* Scheduler.Scheduler;
    yield* forkParked(
      recover.pipe(
        Effect.andThen(scheduler.register("deus-ponder", runDue)),
        Effect.catchCause((cause) => Effect.logWarning("Deus learning startup failed", { cause })),
      ),
    );
  });
  return DeusPonderService.of({ configure, status, runNow, runDue, recover, start });
});
export const layer = Layer.effect(DeusPonderService, make);
