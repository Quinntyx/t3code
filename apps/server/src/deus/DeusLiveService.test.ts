import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  type FunctionResponse,
  LiveServerMessage,
  type LiveSendRealtimeInputParameters,
} from "@google/genai";
import {
  CommandId,
  DeusAttachmentId,
  DeusConversation,
  DeusCursor,
  DeusInputId,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  NodeId,
  type DeusAttachment,
  type DeusTask,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import * as Config from "../config.ts";
import * as Identity from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Repository from "./DeusRepository.ts";
import * as Working from "./DeusContextService.ts";
import * as Memory from "./DeusMemoryService.ts";
import * as Authority from "./DeusAuthority.ts";
import * as Adapter from "./GeminiLiveAdapter.ts";
import * as Live from "./DeusLiveService.ts";
import * as Tools from "./DeusTools.ts";

const environmentId = EnvironmentId.make("live-fixture-environment");
const projectId = ProjectId.make("live-fixture-project");
const base = Working.layer.pipe(
  Layer.provideMerge(Repository.layer),
  Layer.provide(
    Layer.mock(Memory.DeusMemoryService)({
      search: () => Effect.succeed({ items: [], omitted: 0 }),
    }),
  ),
  Layer.provide(
    Layer.succeed(Identity.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "deus-live-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const harness = Effect.gen(function* () {
  const repository = yield* Repository.DeusRepository;
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at)
    VALUES (${projectId},'Live fixture','/test/live','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
  const snapshot = yield* repository.open({
    environmentId,
    projectId,
    inputId: DeusInputId.make("open"),
  });
  const attachment: DeusAttachment = {
    ...snapshot.session,
    attachmentId: DeusAttachmentId.make("attachment-1"),
    generation: 1,
    responseEpoch: 0,
    expiresAt: "2099-01-01T00:00:00.000Z",
  };
  const events = yield* Queue.bounded<Adapter.LiveEvent>(128);
  const responses = yield* Queue.unbounded<FunctionResponse>();
  const realtime = yield* Queue.unbounded<LiveSendRealtimeInputParameters>();
  const contexts = yield* Queue.unbounded<unknown>();
  const started = yield* Deferred.make<void>();
  const release = yield* Deferred.make<void>();
  const connectionClosed = yield* Deferred.make<void>();
  const connecting = yield* Queue.unbounded<void>();
  const connectionRelease = yield* Deferred.make<void>();
  let connectionHeld = false;
  const setups: unknown[] = [];
  const accepted: DeusTask[] = [];
  const executions: Tools.ToolInvocation[] = [];
  let revoked = false;
  let slow = false;
  let cleanupFails = false;
  let closes = 0;
  const layers = Live.layer.pipe(
    Layer.provide(
      Layer.succeed(Adapter.GeminiLiveAdapter, {
        connect: (evidence) =>
          Effect.gen(function* () {
            setups.push(evidence);
            yield* Queue.offer(connecting, undefined);
            if (connectionHeld) yield* Deferred.await(connectionRelease);
            return {
              events,
              respond: (response: FunctionResponse) =>
                Queue.offer(responses, response).pipe(Effect.asVoid),
              realtime: (input: LiveSendRealtimeInputParameters) =>
                Queue.offer(realtime, input).pipe(Effect.asVoid),
              context: (context: unknown) => Queue.offer(contexts, context).pipe(Effect.asVoid),
              close: Effect.gen(function* () {
                closes++;
                yield* Deferred.succeed(connectionClosed, undefined);
                if (cleanupFails)
                  return yield* new Adapter.DeusLiveError({
                    code: "provider",
                    message: "Fixture cleanup failed",
                  });
              }),
            };
          }),
      }),
    ),
    Layer.provide(
      Layer.succeed(Live.DeusLiveAuthority, {
        validate: () =>
          revoked
            ? Effect.fail(
                new Adapter.DeusLiveError({ code: "authority", message: "Revoked fixture owner" }),
              )
            : Effect.void,
      }),
    ),
    Layer.provide(
      Layer.succeed(Authority.DeusAuthority, {
        authorize: () =>
          revoked
            ? Effect.fail(new Authority.DeusAuthorityError({ reason: "inactive" }))
            : Effect.succeed({
                runtimeMode: "full-access",
                interactionMode: "default",
                allowWorktree: false,
              }),
      }),
    ),
    Layer.provide(
      Layer.succeed(Tools.DeusTools, {
        execute: (call) =>
          Effect.gen(function* () {
            executions.push(call);
            let task: DeusTask | undefined;
            if (call.name === "spawn") {
              const result = yield* repository.commit({
                type: "launch",
                input: {
                  ...call.input,
                  inputId: DeusInputId.make(call.actionId),
                  prompt: "Fixture work",
                  kind: "work",
                  model: { instanceId: ProviderInstanceId.make("fixture"), model: "fixture-model" },
                  runtimeMode: "full-access",
                  workspace: "project",
                },
              });
              task = result.task!;
              const threadId = task.workers[0]!.threadId;
              const runId = RunId.make(`run-${task.id}`);
              const acknowledged = yield* repository.commit({
                type: "acknowledge-launch",
                input: {
                  ...call.input,
                  inputId: DeusInputId.make(`ack:${call.actionId}`),
                  taskId: task.id,
                  threadId,
                  runId,
                  commandId: CommandId.make(`deus-launch:${call.input.sessionId}:${call.actionId}`),
                },
              });
              task = acknowledged.task!;
              accepted.push(task);
            }
            yield* Deferred.succeed(started, undefined);
            if (slow) yield* Deferred.await(release);
            return {
              ok: true,
              evidenceOnly: true,
              result: task ? { task } : { answer: "Fixture result" },
            };
          }).pipe(Effect.orDie),
      }),
    ),
  );
  const services = yield* Layer.build(layers);
  const live = Context.get(services, Live.DeusLiveService);
  const restart = Layer.build(layers).pipe(
    Effect.map((next) => Context.get(next, Live.DeusLiveService)),
  );
  const send = (
    message: Pick<LiveServerMessage, "serverContent" | "toolCall" | "toolCallCancellation">,
  ) =>
    Queue.offer(events, {
      type: "message",
      message: Object.assign(new LiveServerMessage(), message),
    }).pipe(Effect.asVoid);
  const next = live.next(attachment);
  const turn = (text = "Please delegate and answer.") =>
    Effect.gen(function* () {
      yield* send({
        serverContent: { inputTranscription: { text, finished: true }, turnComplete: true },
      });
      assert.equal((yield* next).type, "media");
      assert.equal((yield* next).type, "turn-end");
      assert.include((yield* Queue.take(realtime)).text, "Server continuation");
    });
  const report = (
    task: DeusTask,
    mode: "SILENT" | "WHEN_IDLE" | "INTERRUPT",
    id: string,
    child = false,
  ) =>
    repository.commit({
      type: "report",
      input: {
        ...snapshot.session,
        inputId: DeusInputId.make(id),
        taskId: task.id,
        threadId: task.workers[0]!.threadId,
        runId: task.workers[0]!.runId!,
        mode,
        text: id,
        ...(child ? { subagentId: NodeId.make("child-node") } : {}),
      },
    });
  const reportResponse = Stream.fromQueue(responses).pipe(
    Stream.filter((response) => response.response?.event !== undefined),
    Stream.runHead,
    Effect.map(Option.getOrThrow),
  );
  return {
    live,
    restart,
    repository,
    attachment,
    events,
    responses,
    reportResponse,
    realtime,
    contexts,
    connectionClosed,
    connecting,
    connectionRelease,
    holdConnection: () => {
      connectionHeld = true;
    },
    setups,
    accepted,
    executions,
    started,
    release,
    send,
    next,
    turn,
    report,
    revoke: () => {
      revoked = true;
    },
    slow: () => {
      slow = true;
    },
    cleanupFails: () => {
      cleanupFails = true;
    },
    closes: () => closes,
  };
});
const attach = Effect.gen(function* () {
  const h = yield* harness;
  yield* h.live.attach(h.attachment, DeusCursor.make(0));
  const first = yield* h.next;
  assert.equal(first.type, "media");
  return h;
});

it.effect(
  "reserves a session while SDK setup is pending so concurrent attaches cannot create two audio owners",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      h.holdConnection();
      const first = yield* h.live.attach(h.attachment, DeusCursor.make(0)).pipe(Effect.forkScoped);
      yield* Queue.take(h.connecting);
      const second = yield* h.live.attach(h.attachment, DeusCursor.make(0)).pipe(Effect.forkScoped);
      const attempted = yield* Effect.race(
        Queue.take(h.connecting).pipe(Effect.as("connected")),
        Fiber.await(second).pipe(Effect.as("finished")),
      );
      yield* Deferred.succeed(h.connectionRelease, undefined);
      yield* Fiber.join(first);
      const outcome = yield* Fiber.await(second);
      assert.equal(attempted, "finished");
      assert.equal(outcome._tag, "Failure");
      assert.lengthOf(h.setups, 1);
      yield* h.live.detach(h.attachment);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "preserves a maximum-length partial transcript and recoverable failure without overflowing the durable reply bound",
  () =>
    Effect.gen(function* () {
      const h = yield* attach;
      const text = "x".repeat(Adapter.LIVE_LIMITS.transcript);
      yield* h.send({
        serverContent: {
          inputTranscription: { text: "Answer me", finished: true },
          outputTranscription: { text },
        },
      });
      yield* Queue.offer(h.events, {
        type: "failure",
        error: new Adapter.DeusLiveError({ code: "provider", message: "Provider ended" }),
      });
      yield* Deferred.await(h.connectionClosed);
      const snapshot = yield* h.repository.snapshot(h.attachment);
      assert.equal(snapshot.transcripts.at(-1)?.role, "assistant");
      assert.equal(snapshot.transcripts.at(-1)?.text, text);
      assert.equal(snapshot.transcripts.at(-1)?.error?.code, "provider");
      yield* h.live.detach(h.attachment);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "bounds independent playback backpressure and preserves accepted workers and final transcript",
  () =>
    Effect.gen(function* () {
      const h = yield* attach;
      yield* h.send({
        serverContent: { inputTranscription: { text: "Do this task", finished: true } },
        toolCall: { functionCalls: [{ id: "playback-spawn", name: "spawn", args: {} }] },
      });
      yield* Queue.take(h.responses);
      for (let index = 0; index <= Adapter.LIVE_LIMITS.queue; index++)
        yield* h.send({ serverContent: { outputTranscription: { text: "reply " } } });
      yield* Deferred.await(h.connectionClosed);
      const event = yield* h.next;
      assert.equal(event.type, "error");
      if (event.type === "error") assert.equal(event.error.code, "backpressure");
      const snapshot = yield* h.repository.snapshot(h.attachment);
      assert.lengthOf(snapshot.tasks, 1);
      assert.equal(snapshot.tasks[0]?.status, "running");
      assert.equal(snapshot.transcripts.at(-1)?.error?.code, "provider");
      yield* h.live.detach(h.attachment);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "injects context after real speech text, persists final origin and one answer, and leaves no typed outbox",
  () =>
    Effect.gen(function* () {
      const h = yield* attach;
      assert.equal(Queue.sizeUnsafe(h.contexts), 0);
      yield* h.send({
        serverContent: { inputTranscription: { text: "What is current?", finished: true } },
      });
      yield* Queue.take(h.contexts);
      yield* h.next;
      yield* h.send({
        serverContent: {
          outputTranscription: { text: "Here is the answer.", finished: true },
          turnComplete: true,
        },
      });
      yield* h.next;
      assert.equal((yield* h.next).type, "turn-end");
      const current = yield* h.repository.snapshot(h.attachment);
      assert.deepEqual(
        current.transcripts.map((entry) => [entry.role, entry.text, entry.origin?.type]),
        [
          ["human", "What is current?", "live"],
          ["assistant", "Here is the answer.", "live"],
        ],
      );
      assert.equal(current.transcripts[0]?.inputId, current.transcripts[1]?.inputId);
      assert.lengthOf(yield* h.repository.pending, 0);
      yield* h.live.detach(h.attachment);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "recovers lost spoken reply debt at Live service startup without typed generation or fabricated replies",
  () =>
    Effect.gen(function* () {
      const h = yield* harness;
      yield* h.repository.commit({
        type: "spoken-input",
        input: {
          ...h.attachment,
          conversation: DeusConversation.make(1),
          inputId: DeusInputId.make("lost-spoken-input"),
          text: "Please answer this.",
          origin: {
            type: "live",
            attachmentId: h.attachment.attachmentId,
            generation: 1,
            turnId: "lost-turn",
          },
        },
      });
      yield* h.restart;
      const recovered = yield* h.repository.snapshot(h.attachment);
      assert.lengthOf(recovered.transcripts, 2);
      assert.equal(recovered.transcripts[1]?.error?.code, "provider");
      assert.equal(recovered.transcripts[0]?.inputId, recovered.transcripts[1]?.inputId);
      assert.deepEqual(recovered.transcripts[0]?.origin, recovered.transcripts[1]?.origin);
      assert.lengthOf(yield* h.repository.pending, 0);
      assert.lengthOf(h.executions, 0);
      assert.lengthOf(h.setups, 0);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "bounds reply debt to one continuation without repeating mutations under fresh provider IDs",
  () =>
    Effect.gen(function* () {
      const h = yield* attach;
      yield* h.send({
        serverContent: {
          inputTranscription: { text: "Start two identical jobs.", finished: true },
        },
        toolCall: {
          functionCalls: [
            { id: "first", name: "spawn", args: {} },
            { id: "second", name: "spawn", args: {} },
          ],
        },
      });
      yield* Queue.take(h.responses);
      yield* Queue.take(h.responses);
      assert.lengthOf(h.executions, 2);
      assert.lengthOf(h.accepted, 2);
      yield* h.next;
      yield* h.send({ serverContent: { turnComplete: true } });
      yield* h.next;
      assert.include((yield* Queue.take(h.realtime)).text, "Server continuation");
      yield* h.send({ toolCall: { functionCalls: [{ id: "fresh-id", name: "spawn", args: {} }] } });
      assert.equal((yield* Queue.take(h.responses)).scheduling, "SILENT");
      assert.lengthOf(h.executions, 2);
      yield* h.send({ serverContent: { turnComplete: true } });
      assert.equal((yield* h.next).type, "turn-end");
      const error = yield* h.next;
      assert.equal(error.type, "error");
      assert.equal(Queue.sizeUnsafe(h.realtime), 0);
      const current = yield* h.repository.snapshot(h.attachment);
      assert.equal(current.transcripts[1]?.error?.code, "reply-debt");
      assert.lengthOf(current.tasks, 2);
      yield* h.live.detach(h.attachment);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "accepts original legitimate mutations in the same packet as turnComplete before starting reply-debt continuation",
  () =>
    Effect.gen(function* () {
      const h = yield* attach;
      yield* h.send({
        serverContent: {
          inputTranscription: { text: "Start work", finished: true },
          turnComplete: true,
        },
        toolCall: { functionCalls: [{ id: "same-packet", name: "spawn", args: {} }] },
      });
      const receipt = yield* Queue.take(h.responses);
      assert.equal(receipt.response?.ok, true);
      assert.lengthOf(h.accepted, 1);
      yield* h.live.detach(h.attachment);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "keeps capture and interruption responsive during a pending tool, then preserves accepted work on detach",
  () =>
    Effect.gen(function* () {
      const h = yield* attach;
      h.slow();
      yield* h.send({
        serverContent: { inputTranscription: { text: "Start work", finished: true } },
        toolCall: { functionCalls: [{ id: "slow-spawn", name: "spawn", args: {} }] },
      });
      yield* Deferred.await(h.started);
      yield* h.live.input({
        ...h.attachment,
        type: "pcm",
        sequence: 0,
        encoding: "pcm16le",
        channels: 1,
        sampleRate: 16000,
        data: "AAA=",
      });
      assert.equal((yield* Queue.take(h.realtime)).audio?.mimeType, "audio/pcm;rate=16000");
      yield* h.live.control({ ...h.attachment, action: "interrupt-response", sequence: 1 });
      assert.lengthOf(h.accepted, 1);
      yield* h.live.detach(h.attachment);
      yield* Deferred.succeed(h.release, undefined);
      const current = yield* h.repository.snapshot(h.attachment);
      assert.equal(current.tasks[0]?.status, "running");
      assert.equal(current.transcripts[1]?.error?.code, "provider");
    }).pipe(Effect.provide(base)),
);

it.effect(
  "delivers report-before-acceptance with stored modes, keeps child completion on its root and flushes stale playback",
  () =>
    Effect.gen(function* () {
      const h = yield* attach;
      h.slow();
      yield* h.send({
        serverContent: { inputTranscription: { text: "Launch", finished: true } },
        toolCall: { functionCalls: [{ id: "spawn-channel", name: "spawn", args: {} }] },
      });
      yield* Deferred.await(h.started);
      const task = h.accepted[0]!;
      yield* h.report(task, "SILENT", "raced-before-accept");
      yield* Deferred.succeed(h.release, undefined);
      assert.equal((yield* Queue.take(h.responses)).scheduling, "SILENT");
      const raced = yield* h.reportResponse;
      assert.equal(raced.id, "spawn-channel");
      assert.equal(raced.scheduling, "SILENT");
      yield* h.next;
      yield* h.send({
        serverContent: { outputTranscription: { text: "Working on it." }, turnComplete: true },
      });
      yield* h.next;
      yield* h.next;
      yield* h.report(task, "WHEN_IDLE", "child-complete", true);
      const child = yield* h.reportResponse;
      assert.equal(child.scheduling, "WHEN_IDLE");
      assert.equal(child.willContinue, true);
      yield* h.send({
        serverContent: {
          outputTranscription: { text: "Child evidence" },
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAA=" } }],
          },
        },
      });
      yield* h.next;
      yield* h.report(task, "INTERRUPT", "urgent-report");
      const urgent = yield* h.reportResponse;
      assert.equal(urgent.scheduling, "INTERRUPT");
      const invalidated = yield* h.next;
      assert.equal(invalidated.attachment.responseEpoch, 1);
      yield* h.send({
        serverContent: {
          modelTurn: {
            parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AgA=" } }],
          },
          turnComplete: true,
        },
      });
      assert.equal((yield* h.next).type, "turn-end");
      yield* h.send({
        serverContent: {
          outputTranscription: { text: "New urgent evidence." },
          turnComplete: true,
        },
      });
      yield* h.next;
      yield* h.next;
      const current = yield* h.repository.snapshot(h.attachment);
      assert.equal(current.transcripts.at(-1)?.origin?.type, "report");
      assert.deepEqual(
        current.reports.map((report) => report.mode),
        ["SILENT", "WHEN_IDLE", "INTERRUPT"],
      );
      yield* h.live.detach(h.attachment);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "copies silent bootstrap without a synthetic human and never reuses old call IDs on reconnect",
  () =>
    Effect.gen(function* () {
      const h = yield* attach;
      yield* h.send({
        serverContent: { inputTranscription: { text: "Start", finished: true } },
        toolCall: { functionCalls: [{ id: "old-id", name: "spawn", args: {} }] },
      });
      yield* Queue.take(h.responses);
      yield* h.report(h.accepted[0]!, "INTERRUPT", "old-report");
      yield* h.reportResponse;
      yield* h.live.detach(h.attachment);
      const fresh = {
        ...h.attachment,
        attachmentId: DeusAttachmentId.make("fresh-attachment"),
        generation: 2,
      };
      yield* Queue.take(h.connecting);
      h.holdConnection();
      const acquiring = yield* h.live.attach(fresh, DeusCursor.make(0)).pipe(Effect.forkScoped);
      yield* Queue.take(h.connecting);
      yield* h.report(h.accepted[0]!, "SILENT", "between-snapshot-and-attach");
      yield* Deferred.succeed(h.connectionRelease, undefined);
      yield* Fiber.join(acquiring);
      yield* h.live.next(fresh);
      assert.include(JSON.stringify(h.setups[1]), '"mode":"SILENT"');
      assert.notInclude(JSON.stringify(h.setups[1]), "old-id");
      assert.equal(Queue.sizeUnsafe(h.realtime), 0);
      assert.equal((yield* h.repository.snapshot(fresh)).reports[0]?.mode, "INTERRUPT");
      assert.notInclude(JSON.stringify(h.setups[1]), "between-snapshot-and-attach");
      yield* h.send({
        serverContent: { inputTranscription: { text: "Recover updates", finished: true } },
        toolCall: { functionCalls: [{ id: "fresh-bootstrap", name: "recover", args: {} }] },
      });
      const overlapping = yield* h.reportResponse;
      assert.equal(overlapping.id, "fresh-bootstrap");
      assert.equal(overlapping.scheduling, "SILENT");
      assert.include(JSON.stringify(overlapping.response), "between-snapshot-and-attach");
      assert.notInclude(JSON.stringify(overlapping.response), "old-report");
      yield* h.live.detach(fresh);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "cancels connection-local streams without cancelling accepted workers and recovers queued reports on a new channel",
  () =>
    Effect.gen(function* () {
      const h = yield* attach;
      yield* h.send({
        serverContent: { inputTranscription: { text: "Start", finished: true } },
        toolCall: { functionCalls: [{ id: "cancel-me", name: "spawn", args: {} }] },
      });
      yield* Queue.take(h.responses);
      yield* h.send({
        toolCallCancellation: { ids: ["cancel-me"] },
        serverContent: { outputTranscription: { text: "Started." }, turnComplete: true },
      });
      yield* h.next;
      yield* h.next;
      yield* h.next;
      yield* h.report(h.accepted[0]!, "SILENT", "queued-after-cancel");
      yield* h.send({
        serverContent: { inputTranscription: { text: "Recover updates", finished: true } },
        toolCall: { functionCalls: [{ id: "new-bootstrap", name: "recover", args: {} }] },
      });
      const report = yield* h.reportResponse;
      assert.equal(report.id, "new-bootstrap");
      assert.equal(report.scheduling, "SILENT");
      assert.equal((yield* h.repository.snapshot(h.attachment)).tasks[0]?.status, "running");
      yield* h.live.detach(h.attachment);
    }).pipe(Effect.provide(base)),
);

it.effect(
  "reset invalidates the attachment but preserves original voice conversation, reports and workers",
  () =>
    Effect.gen(function* () {
      const h = yield* attach;
      yield* h.send({
        serverContent: { inputTranscription: { text: "Start", finished: true } },
        toolCall: { functionCalls: [{ id: "before-reset", name: "spawn", args: {} }] },
      });
      yield* Queue.take(h.responses);
      yield* h.next;
      yield* h.repository.commit({
        type: "reset",
        input: {
          ...h.attachment,
          inputId: DeusInputId.make("reset"),
          conversation: DeusConversation.make(1),
        },
      });
      const lost = yield* h.next;
      assert.equal(lost.type, "error");
      const current = yield* h.repository.snapshot(h.attachment);
      assert.equal(current.session.conversation, 2);
      assert.equal(current.tasks[0]?.conversation, 1);
      assert.equal(current.transcripts.at(-1)?.conversation, 1);
      assert.equal(current.transcripts.at(-1)?.error?.code, "provider");
    }).pipe(Effect.provide(base)),
);

it.effect(
  "revokes future media/tool effects, validates owner/sequence and treats mute as audio stream end only",
  () =>
    Effect.gen(function* () {
      const h = yield* attach;
      assert.equal(
        (yield* h.live
          .input({
            ...h.attachment,
            generation: 2,
            type: "pcm",
            sequence: 0,
            encoding: "pcm16le",
            channels: 1,
            sampleRate: 16000,
            data: "AAA=",
          })
          .pipe(Effect.flip)).code,
        "stale",
      );
      yield* h.live.control({ ...h.attachment, sequence: 0, action: "mute" });
      assert.deepEqual(yield* Queue.take(h.realtime), { audioStreamEnd: true });
      yield* h.live.input({
        ...h.attachment,
        type: "pcm",
        sequence: 1,
        encoding: "pcm16le",
        channels: 1,
        sampleRate: 16000,
        data: "AAA=",
      });
      assert.equal(Queue.sizeUnsafe(h.realtime), 0);
      h.revoke();
      assert.equal(
        (yield* h.live
          .control({ ...h.attachment, sequence: 2, action: "resume" })
          .pipe(Effect.flip)).code,
        "authority",
      );
    }).pipe(Effect.provide(base)),
);

it.effect(
  "retains provider cause and cleanup error, fails only the attachment and keeps durable worker state",
  () =>
    Effect.gen(function* () {
      const h = yield* attach;
      yield* h.send({
        serverContent: { inputTranscription: { text: "Start", finished: true } },
        toolCall: { functionCalls: [{ id: "start", name: "spawn", args: {} }] },
      });
      yield* Queue.take(h.responses);
      yield* h.next;
      h.cleanupFails();
      yield* Queue.offer(h.events, {
        type: "failure",
        error: new Adapter.DeusLiveError({
          code: "provider",
          message: "Configured model rejected NON_BLOCKING",
        }),
      });
      const failed = yield* h.next;
      assert.equal(failed.type, "error");
      if (failed.type === "error") {
        assert.include(failed.error.message, "rejected NON_BLOCKING");
        assert.include(failed.cleanup, "cleanup failed");
      }
      const current = yield* h.repository.snapshot(h.attachment);
      assert.equal(current.tasks[0]?.status, "running");
      assert.equal(current.transcripts.at(-1)?.error?.code, "provider");
      assert.isAtLeast(h.closes(), 1);
    }).pipe(Effect.provide(base)),
);
