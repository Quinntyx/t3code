import * as NodeUtil from "node:util";
import {
  CommandId,
  DeusConversation,
  DeusCursor,
  DeusDelta,
  DeusOpenInput,
  DeusObservationId,
  DeusSourceRef,
  DeusScope,
  DeusSessionId,
  DeusSessionRef,
  DeusSnapshot,
  DeusStateError,
  DeusTaskId,
  DeusTranscriptId,
  type DeusInputId,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as SqlClient from "effect/sql/SqlClient";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import { Command, CommandResult, PendingIntent, decide, project } from "./decide.ts";
import { Continuation, TEXT_LIMITS, checkBytes } from "./textProtocol.ts";

export class DeusPersistenceError extends Schema.TaggedError<DeusPersistenceError>()(
  "DeusPersistenceError",
  {
    operation: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Deus persistence operation '${this.operation}' failed.`;
  }
}
export type DeusRepositoryError = DeusStateError | DeusPersistenceError;

export class DeusRepository extends Context.Service<
  DeusRepository,
  {
    readonly validateScope: (input: DeusScope) => Effect.Effect<void, DeusRepositoryError>;
    readonly open: (input: DeusOpenInput) => Effect.Effect<DeusSnapshot, DeusRepositoryError>;
    readonly snapshot: (ref: DeusSessionRef) => Effect.Effect<DeusSnapshot, DeusRepositoryError>;
    readonly currentConversation: (
      ref: DeusSessionRef,
    ) => Effect.Effect<DeusConversation, DeusRepositoryError>;
    readonly commit: (command: Command) => Effect.Effect<CommandResult, DeusRepositoryError>;
    readonly readDeltas: (
      ref: DeusSessionRef,
      after: DeusCursor,
    ) => Effect.Effect<ReadonlyArray<DeusDelta>, DeusRepositoryError>;
    readonly readSource: (ref: DeusSourceRef) => Effect.Effect<DeusDelta, DeusRepositoryError>;
    readonly subscribe: Effect.Effect<PubSub.Subscription<void>, never, Scope.Scope>;
    readonly pending: Effect.Effect<ReadonlyArray<PendingIntent>, DeusRepositoryError>;
    readonly saveContinuation: (
      pending: PendingIntent,
      next: Continuation,
    ) => Effect.Effect<void, DeusRepositoryError>;
    readonly workerSessions: Effect.Effect<ReadonlyArray<DeusSessionRef>, DeusRepositoryError>;
    readonly findWorker: (
      threadId: ThreadId,
    ) => Effect.Effect<DeusSessionRef | null, DeusRepositoryError>;
    readonly projectDeleted: (projectId: ProjectId) => Effect.Effect<void>;
  }
>()("t3/deus/DeusRepository") {}

const decodeConversation = Schema.decodeEffect(DeusConversation);
const decodeSnapshot = Schema.decodeEffect(Schema.fromJsonString(DeusSnapshot));
const decodeResult = Schema.decodeEffect(Schema.fromJsonString(CommandResult));
const decodeDelta = Schema.decodeEffect(Schema.fromJsonString(DeusDelta));
const decodePending = Schema.decodeEffect(Schema.fromJsonString(PendingIntent));
const decodeContinuation = Schema.decodeEffect(Continuation);
const decodeSessionRef = Schema.decodeEffect(DeusSessionRef);
const decodeSourceRef = Schema.decodeEffect(DeusSourceRef);
const encodeSnapshot = Schema.encodeSync(Schema.fromJsonString(DeusSnapshot));
const encodeDelta = Schema.encodeSync(Schema.fromJsonString(DeusDelta));
const encodePending = Schema.encodeSync(Schema.fromJsonString(PendingIntent));
const encodeResult = Schema.encodeSync(Schema.fromJsonString(CommandResult));
const encodeCommand = Schema.encodeSync(Command);
const encodeCommandJson = Schema.encodeSync(Schema.fromJsonString(Command));
const OpenCommand = Schema.Struct({ type: Schema.Literal("open"), input: DeusOpenInput });
const encodeOpenCommand = Schema.encodeSync(Schema.fromJsonString(OpenCommand));
const decodeOpenInput = Schema.decodeEffect(DeusOpenInput);
const decodeCommand = Schema.decodeEffect(Command);
const decodeStoredCommand = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));
const isStateError = Schema.is(DeusStateError);

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const crypto = yield* Crypto.Crypto;
  const identity = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const environmentId = yield* identity.getEnvironmentId;
  // Signals carry no payload: one wake-up replays every durable cursor since the last read.
  const changes = yield* PubSub.sliding<void>(1);
  const lane = yield* Semaphore.make(1);
  const mapError =
    (operation: string) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.mapError((cause) =>
          isStateError(cause) ? cause : new DeusPersistenceError({ operation, cause }),
        ),
      );
  const validateScope = Effect.fn("DeusRepository.validateScope")(function* (scope: DeusScope) {
    if (scope.environmentId !== environmentId) {
      return yield* new DeusStateError({
        reason: "scope-mismatch",
        message: "Deus scope is not in this environment.",
      });
    }
    const rows =
      yield* sql`SELECT project_id FROM projection_projects WHERE project_id = ${scope.projectId} AND deleted_at IS NULL`;
    if (rows.length === 0)
      return yield* new DeusStateError({
        reason: "not-found",
        message: "Deus project was not found.",
      });
  });
  const readSnapshot = Effect.fn("DeusRepository.readSnapshot")(function* (ref: DeusSessionRef) {
    yield* validateScope(ref);
    const rows = yield* sql<{ snapshot_json: string }>`SELECT snapshot_json FROM deus_sessions
      WHERE session_id = ${ref.sessionId} AND environment_id = ${environmentId}
      AND project_id = ${ref.projectId} AND closed_at IS NULL`;
    if (!rows[0])
      return yield* new DeusStateError({
        reason: "scope-mismatch",
        message: "Deus session does not belong to this scope.",
      });
    return yield* decodeSnapshot(rows[0].snapshot_json);
  });
  const sourceAt = Effect.fn("DeusRepository.sourceAt")(function* (ref: DeusSourceRef) {
    const rows = yield* sql<{ delta_json: string }>`SELECT delta_json FROM deus_events
      WHERE session_id = ${ref.sessionId} AND cursor = ${ref.cursor}`;
    if (!rows[0])
      return yield* new DeusStateError({
        reason: "not-found",
        message: "Deus source was not found.",
      });
    const delta = yield* decodeDelta(rows[0].delta_json);
    if (
      delta.environmentId !== ref.environmentId ||
      delta.projectId !== ref.projectId ||
      delta.sessionId !== ref.sessionId ||
      delta.cursor !== ref.cursor
    )
      return yield* new DeusStateError({
        reason: "scope-mismatch",
        message: "Deus source is not in this scope.",
      });
    return delta;
  });
  const readSource = Effect.fn("DeusRepository.readSource")(function (raw: DeusSourceRef) {
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const ref = yield* decodeSourceRef(raw);
          yield* readSnapshot(ref);
          return yield* sourceAt(ref);
        }),
      )
      .pipe(mapError("read-source"));
  });
  const receipt = Effect.fn("DeusRepository.receipt")(function* (
    scope: DeusScope,
    inputId: DeusInputId,
    command: unknown,
  ) {
    const rows = yield* sql<{
      command_json: string;
      result_json: string;
      session_id: string;
    }>`SELECT command_json, result_json, session_id FROM deus_receipts
      WHERE environment_id = ${environmentId} AND project_id = ${scope.projectId} AND input_id = ${inputId}`;
    const row = rows[0];
    if (!row) return undefined;
    const stored = yield* decodeStoredCommand(row.command_json);
    if (!NodeUtil.isDeepStrictEqual(stored, command))
      return yield* new DeusStateError({
        reason: "conflict",
        message: "Deus input identity was already used for different content.",
      });
    return row;
  });
  const snapshot = Effect.fn("DeusRepository.snapshot")(function (ref: DeusSessionRef) {
    return sql.withTransaction(readSnapshot(ref)).pipe(mapError("snapshot"));
  });
  const open = Effect.fn("DeusRepository.open")(function (raw: DeusOpenInput) {
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const input = yield* decodeOpenInput(raw);
          yield* validateScope(input);
          const command = { type: "open" as const, input };
          const previous = yield* receipt(input, input.inputId, command);
          const existing = yield* sql<{ session_id: string }>`SELECT session_id FROM deus_sessions
        WHERE environment_id = ${environmentId} AND project_id = ${input.projectId} AND closed_at IS NULL`;
          const sessionId = DeusSessionId.make(
            previous?.session_id ?? existing[0]?.session_id ?? (yield* crypto.randomUUIDv4()),
          );
          if (!previous && existing.length === 0) {
            const now = DateTime.formatIso(yield* DateTime.now);
            const initial: DeusSnapshot = {
              session: {
                environmentId,
                projectId: input.projectId,
                sessionId,
                conversation: DeusConversation.make(1),
                createdAt: now,
                updatedAt: now,
              },
              cursor: DeusCursor.make(0),
              transcripts: [],
              tasks: [],
              reports: [],
              observations: [],
              memories: [],
              ponderReceipts: [],
            };
            yield* sql`INSERT INTO deus_sessions (session_id, environment_id, project_id, snapshot_json)
          VALUES (${sessionId}, ${environmentId}, ${input.projectId}, ${encodeSnapshot(initial)})`;
          }
          if (!previous)
            yield* sql`INSERT INTO deus_receipts (environment_id, project_id, input_id, session_id, command_json, result_json)
        VALUES (${environmentId}, ${input.projectId}, ${input.inputId}, ${sessionId}, ${encodeOpenCommand(command)}, '{}')`;
          return yield* readSnapshot({ ...input, sessionId });
        }),
      )
      .pipe(mapError("open"));
  });
  const commit = Effect.fn("DeusRepository.commit")(function (raw: Command) {
    return lane
      .withPermits(1)(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const result = yield* sql.withTransaction(
              Effect.gen(function* () {
                const command = yield* decodeCommand(raw);
                const { input } = command;
                let current = yield* readSnapshot(input);
                const previous = yield* receipt(input, input.inputId, encodeCommand(command));
                if (previous) {
                  const replayed = yield* decodeResult(previous.result_json);
                  return {
                    result: {
                      ...replayed,
                      receipt: { ...replayed.receipt, status: "replayed" as const },
                    },
                    changed: false,
                  };
                }
                const now = DateTime.formatIso(yield* DateTime.now);
                const source =
                  command.type === "observe" || command.type === "report-response"
                    ? yield* sourceAt({ ...input, cursor: command.input.sourceCursor })
                    : undefined;
                const planned = decide(
                  current,
                  command,
                  now,
                  {
                    transcriptId: DeusTranscriptId.make(yield* crypto.randomUUIDv4()),
                    taskId: DeusTaskId.make(yield* crypto.randomUUIDv4()),
                    threadId: ThreadId.make(yield* crypto.randomUUIDv4()),
                    commandId: CommandId.make(`deus-launch:${input.sessionId}:${input.inputId}`),
                    observationId: DeusObservationId.make(yield* crypto.randomUUIDv4()),
                  },
                  source,
                );
                if (isStateError(planned)) return yield* planned;
                if (command.type === "respond") {
                  const rows = yield* sql<{ input_id: string }>`SELECT input_id FROM deus_outbox
                    WHERE session_id = ${input.sessionId} AND input_id = ${command.input.humanInputId}
                    AND status = 'pending' AND json_extract(intent_json, '$.intent.type') IN ('coordinate-input', 'spoken-input')`;
                  if (!rows[0])
                    return yield* new DeusStateError({
                      reason: "conflict",
                      message: "Human input has no pending reply.",
                    });
                  yield* sql`UPDATE deus_outbox SET status = 'acknowledged' WHERE session_id = ${input.sessionId} AND input_id = ${command.input.humanInputId}`;
                }
                if (command.type === "acknowledge-launch") {
                  const ack = command.input;
                  const links = yield* sql<{
                    input_id: string;
                  }>`SELECT o.input_id FROM deus_worker_links w
            JOIN deus_outbox o ON o.session_id = w.session_id
              AND json_extract(o.intent_json, '$.intent.taskId') = w.task_id
            WHERE w.session_id = ${ack.sessionId} AND w.task_id = ${ack.taskId}
              AND w.thread_id = ${ack.threadId} AND w.command_id = ${ack.commandId}
              AND (w.run_id IS NULL OR w.run_id = ${ack.runId})`;
                  if (!links[0])
                    return yield* new DeusStateError({
                      reason: "scope-mismatch",
                      message: "Launch acknowledgment does not match a committed intent.",
                    });
                  yield* sql`UPDATE deus_worker_links SET run_id = ${ack.runId} WHERE session_id = ${ack.sessionId} AND task_id = ${ack.taskId}`;
                  yield* sql`UPDATE deus_outbox SET status = 'acknowledged' WHERE session_id = ${ack.sessionId} AND input_id = ${links[0].input_id}`;
                }
                for (const change of planned.changes) {
                  const delta: DeusDelta = {
                    environmentId,
                    projectId: input.projectId,
                    sessionId: input.sessionId,
                    previousCursor: current.cursor,
                    cursor: DeusCursor.make(current.cursor + 1),
                    change,
                  };
                  current = project(current, change, now);
                  yield* sql`INSERT INTO deus_events (session_id, cursor, delta_json) VALUES (${input.sessionId}, ${delta.cursor}, ${encodeDelta(delta)})`;
                }
                yield* sql`UPDATE deus_sessions SET cursor = ${current.cursor}, snapshot_json = ${encodeSnapshot(current)} WHERE session_id = ${input.sessionId}`;
                if (planned.intent) {
                  const pending: PendingIntent = {
                    environmentId,
                    projectId: input.projectId,
                    sessionId: input.sessionId,
                    cursor: current.cursor,
                    inputId: input.inputId,
                    intent: planned.intent,
                  };
                  yield* sql`INSERT INTO deus_outbox (session_id, input_id, cursor, intent_json) VALUES (${input.sessionId}, ${input.inputId}, ${current.cursor}, ${encodePending(pending)})`;
                  if (planned.intent.type === "launch-thread" && command.type === "launch") {
                    const intent = planned.intent;
                    yield* sql`INSERT INTO deus_worker_links (session_id, task_id, thread_id, command_id, conversation)
              VALUES (${input.sessionId}, ${intent.taskId}, ${intent.threadId}, ${intent.commandId}, ${command.input.conversation})`;
                  }
                }
                const task = planned.changes.find((change) => change.type === "task");
                const outcome: CommandResult = {
                  receipt: { inputId: input.inputId, cursor: current.cursor, status: "accepted" },
                  ...(task?.type === "task" ? { task: task.task } : {}),
                };
                yield* sql`INSERT INTO deus_receipts (environment_id, project_id, input_id, session_id, command_json, result_json)
          VALUES (${environmentId}, ${input.projectId}, ${input.inputId}, ${input.sessionId}, ${encodeCommandJson(command)}, ${encodeResult(outcome)})`;
                return { result: outcome, changed: true };
              }),
            );
            if (result.changed) yield* PubSub.publish(changes, undefined);
            return result.result;
          }),
        ),
      )
      .pipe(mapError("commit"));
  });
  const readDeltas = Effect.fn("DeusRepository.readDeltas")(function (
    ref: DeusSessionRef,
    after: DeusCursor,
  ) {
    return sql
      .withTransaction(
        Effect.gen(function* () {
          const current = yield* readSnapshot(ref);
          if (after > current.cursor)
            return yield* new DeusStateError({
              reason: "conflict",
              message: "Deus cursor is ahead of the session.",
            });
          const rows = yield* sql<{
            delta_json: string;
          }>`SELECT delta_json FROM deus_events WHERE session_id = ${ref.sessionId}
        AND cursor > ${after} ORDER BY cursor LIMIT 128`;
          return yield* Effect.forEach(rows, (row) => decodeDelta(row.delta_json));
        }),
      )
      .pipe(mapError("read-deltas"));
  });
  const pending = sql
    .withTransaction(
      Effect.gen(function* () {
        const rows = yield* sql<{
          intent_json: string;
        }>`SELECT o.intent_json FROM deus_outbox o JOIN deus_sessions s ON s.session_id = o.session_id
      JOIN projection_projects p ON p.project_id = s.project_id WHERE s.environment_id = ${environmentId}
      AND s.closed_at IS NULL AND p.deleted_at IS NULL AND o.status = 'pending' ORDER BY s.session_id, o.cursor`;
        return yield* Effect.forEach(rows, (row) => decodePending(row.intent_json));
      }),
    )
    .pipe(mapError("pending"));
  const saveContinuation = Effect.fn("DeusRepository.saveContinuation")(function (
    pending: PendingIntent,
    raw: Continuation,
  ) {
    return lane
      .withPermits(1)(
        sql.withTransaction(
          Effect.gen(function* () {
            yield* readSnapshot(pending);
            const next = yield* decodeContinuation(raw);
            yield* Effect.try({
              try: () => checkBytes(next, TEXT_LIMITS.continuationBytes),
              catch: () =>
                new DeusStateError({
                  reason: "conflict",
                  message: "Text continuation exceeds its bound.",
                }),
            });
            const rows = yield* sql<{
              intent_json: string;
            }>`SELECT intent_json FROM deus_outbox WHERE session_id = ${pending.sessionId} AND input_id = ${pending.inputId} AND status = 'pending'`;
            if (!rows[0])
              return yield* new DeusStateError({
                reason: "conflict",
                message: "Text continuation is no longer pending.",
              });
            const current = yield* decodePending(rows[0].intent_json);
            if (
              current.intent.type !== "coordinate-input" ||
              pending.intent.type !== "coordinate-input" ||
              !NodeUtil.isDeepStrictEqual(current, pending) ||
              next.revision !== (current.intent.continuation?.revision ?? 0) + 1
            )
              return yield* new DeusStateError({
                reason: "conflict",
                message: "Text continuation changed concurrently.",
              });
            const updated = { ...current, intent: { ...current.intent, continuation: next } };
            yield* sql`UPDATE deus_outbox SET intent_json = ${encodePending(updated)} WHERE session_id = ${pending.sessionId} AND input_id = ${pending.inputId}`;
          }),
        ),
      )
      .pipe(mapError("save-continuation"));
  });
  const findWorker = Effect.fn("DeusRepository.findWorker")(function* (threadId: ThreadId) {
    const rows = yield* sql<{
      session_id: string;
      project_id: string;
    }>`SELECT s.session_id, s.project_id FROM deus_worker_links w
      JOIN deus_sessions s ON s.session_id = w.session_id JOIN projection_projects p ON p.project_id = s.project_id
      WHERE w.thread_id = ${threadId} AND s.environment_id = ${environmentId} AND s.closed_at IS NULL AND p.deleted_at IS NULL`;
    return rows[0]
      ? yield* decodeSessionRef({
          environmentId,
          sessionId: rows[0].session_id,
          projectId: rows[0].project_id,
        })
      : null;
  });
  return DeusRepository.of({
    validateScope: Effect.fn("DeusRepository.validateScope")((input) =>
      validateScope(input).pipe(mapError("validate-scope")),
    ),
    findWorker: Effect.fn("DeusRepository.findRegisteredWorker")((threadId) =>
      findWorker(threadId).pipe(mapError("findWorker")),
    ),
    workerSessions: sql<{
      session_id: string;
      project_id: string;
    }>`SELECT DISTINCT s.session_id, s.project_id FROM deus_sessions s
      JOIN deus_worker_links w ON w.session_id = s.session_id JOIN projection_projects p ON p.project_id = s.project_id
      WHERE s.environment_id = ${environmentId} AND s.closed_at IS NULL AND p.deleted_at IS NULL`.pipe(
      Effect.flatMap((rows) =>
        Effect.forEach(rows, (row) =>
          decodeSessionRef({
            environmentId,
            sessionId: row.session_id,
            projectId: row.project_id,
          }),
        ),
      ),
      mapError("workerSessions"),
    ),
    open,
    snapshot,
    currentConversation: Effect.fn("DeusRepository.currentConversation")(function* (ref) {
      yield* validateScope(ref);
      const rows = yield* sql<{
        conversation: number;
      }>`SELECT json_extract(snapshot_json, '$.session.conversation') AS conversation
        FROM deus_sessions WHERE session_id = ${ref.sessionId} AND environment_id = ${environmentId}
        AND project_id = ${ref.projectId} AND closed_at IS NULL`;
      if (!rows[0])
        return yield* new DeusStateError({
          reason: "scope-mismatch",
          message: "Deus session does not belong to this scope.",
        });
      return yield* decodeConversation(rows[0].conversation);
    }, mapError("current-conversation")),
    commit,
    readDeltas,
    readSource,
    pending,
    saveContinuation,
    subscribe: PubSub.subscribe(changes),
    projectDeleted: Effect.fn("DeusRepository.projectDeleted")(function (_projectId) {
      return PubSub.publish(changes, undefined).pipe(Effect.asVoid);
    }),
  });
});
export const layer = Layer.effect(DeusRepository, make);
