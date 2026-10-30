import {
  FunctionResponseScheduling,
  type FunctionCall,
  type LiveServerMessage,
} from "@google/genai";
import {
  DeusAttachment,
  DeusAttachmentInput,
  DeusConversation,
  DeusCursor,
  DeusInputId,
  DeusMediaControlInput,
  DeusPcmInput,
  type DeusMediaOutput,
  type DeusReport,
  type DeusTask,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Authority from "./DeusAuthority.ts";
import * as Repository from "./DeusRepository.ts";
import * as Working from "./DeusContextService.ts";
import * as Tools from "./DeusTools.ts";
import * as Adapter from "./GeminiLiveAdapter.ts";
import { type SpokenInput } from "./decide.ts";
import { checkBytes, encodeJson } from "./textProtocol.ts";
import { page, preview } from "./contextBounds.ts";

const { DeusLiveError, LIVE_LIMITS } = Adapter;
const unavailable = () =>
  new DeusLiveError({
    code: "authority",
    message: "A trusted current human Live attachment is required.",
  });
const stale = () =>
  new DeusLiveError({
    code: "stale",
    message: "This Live attachment or response epoch is no longer current.",
  });
export class DeusLiveAuthority extends Context.Service<
  DeusLiveAuthority,
  {
    readonly validate: (attachment: DeusAttachment) => Effect.Effect<void, Adapter.DeusLiveError>;
  }
>()("t3/deus/DeusLiveService/DeusLiveAuthority") {}
export type LiveOutput = {
  readonly attachment: DeusAttachment;
  readonly conversation: DeusConversation;
  readonly turnId: string;
} & (
  | { readonly type: "media"; readonly media: DeusMediaOutput }
  | { readonly type: "turn-end" }
  | { readonly type: "error"; readonly error: Adapter.DeusLiveError; readonly cleanup?: string }
);
type Call = {
  readonly id: string;
  readonly name: string;
  readonly signature: string;
  readonly actionId: string;
  readonly input: Effect.Effect<SpokenInput, Adapter.DeusLiveError>;
  readonly continuation: boolean;
  humanInputId?: string;
  result?: Record<string, unknown>;
  continuing?: boolean;
};
type SpeechSource =
  | { readonly type: "human"; readonly input: SpokenInput }
  | { readonly type: "report"; readonly report: DeusReport };
interface AttachmentState {
  attachment: DeusAttachment;
  readonly scope: Scope.Closeable;
  readonly connection: Adapter.LiveConnection;
  readonly output: Queue.Queue<LiveOutput>;
  readonly ended: Deferred.Deferred<void>;
  readonly lane: Semaphore.Semaphore;
  readonly calls: Map<string, Call>;
  readonly cancelled: Set<string>;
  readonly streams: Map<string, { readonly call: Call; readonly runId: string | null }>;
  ready: Deferred.Deferred<SpokenInput, Adapter.DeusLiveError>;
  readonly conversation: DeusConversation;
  readonly snapshotCursor: DeusCursor;
  cursor: DeusCursor;
  readonly delivered: Set<DeusCursor>;
  bootstrap?: Call | undefined;
  source?: SpeechSource | undefined;
  human?: SpokenInput | undefined;
  inputText: string;
  outputText: string;
  turnId: string;
  inputSequence: number;
  outputSequence: number;
  contextRevision: number;
  contextRunning: boolean;
  contextPending: string;
  captured: boolean;
  active: boolean;
  debt: boolean;
  nudged: boolean;
  continuation: boolean;
  suppress: boolean;
  muted: boolean;
  spawning: number;
  runningCalls: number;
  closed: boolean;
}
export class DeusLiveService extends Context.Service<
  DeusLiveService,
  {
    readonly attach: (
      attachment: DeusAttachment,
      after: DeusCursor,
    ) => Effect.Effect<void, Adapter.DeusLiveError>;
    readonly input: (input: DeusPcmInput) => Effect.Effect<void, Adapter.DeusLiveError>;
    readonly control: (input: DeusMediaControlInput) => Effect.Effect<void, Adapter.DeusLiveError>;
    readonly next: (
      attachment: DeusAttachmentInput,
    ) => Effect.Effect<LiveOutput, Adapter.DeusLiveError>;
    readonly detach: (
      attachment: DeusAttachmentInput,
    ) => Effect.Effect<void, Adapter.DeusLiveError>;
  }
>()("t3/deus/DeusLiveService") {}

type OutputEvent = LiveOutput extends infer O
  ? O extends LiveOutput
    ? Omit<O, "attachment" | "conversation" | "turnId">
    : never
  : never;
type MediaEvent = DeusMediaOutput extends infer O
  ? O extends DeusMediaOutput
    ? Omit<O, keyof DeusAttachment | "sequence">
    : never
  : never;
const decodeAttachment = Schema.decodeEffect(DeusAttachment);
const decodeAttachmentInput = Schema.decodeEffect(DeusAttachmentInput);
const decodePcm = Schema.decodeEffect(DeusPcmInput);
const decodeControl = Schema.decodeEffect(DeusMediaControlInput);
const isLiveError = Schema.is(DeusLiveError);
const make = Effect.gen(function* () {
  const repository = yield* Repository.DeusRepository;
  for (const pending of yield* repository.pending) {
    if (pending.intent.type !== "spoken-input") continue;
    const input = pending.intent.input;
    yield* repository
      .commit({
        type: "respond",
        input: {
          ...input,
          inputId: DeusInputId.make(`deus-live-recovery:${input.inputId}`),
          humanInputId: input.inputId,
          error: "provider",
          text: "The voice attachment was lost before a complete reply was recorded. Reconnect and retry; accepted workers are preserved.",
        },
      })
      .pipe(Effect.orDie);
  }
  const working = yield* Working.DeusContextService;
  const tools = yield* Tools.DeusTools;
  const authority = yield* Authority.DeusAuthority;
  const owner = yield* DeusLiveAuthority;
  const adapter = yield* Adapter.GeminiLiveAdapter;
  const crypto = yield* Crypto.Crypto;
  const serviceScope = yield* Scope.Scope;
  const states = new Map<string, AttachmentState>();
  const acquiring = new Set<string>();
  const failure = (cause: unknown) =>
    isLiveError(cause)
      ? cause
      : new DeusLiveError({
          code: "provider",
          message:
            "Live state could not be committed or recovered; reconnect. Accepted workers are preserved.",
        });
  const uuid = crypto.randomUUIDv4();
  const output = (state: AttachmentState, event: OutputEvent) => {
    if (
      !Queue.offerUnsafe(state.output, {
        ...event,
        attachment: state.attachment,
        conversation: state.conversation,
        turnId: state.turnId,
      })
    )
      throw new DeusLiveError({
        code: "backpressure",
        message: "Live playback queue is full; reconnect. Workers are preserved.",
      });
  };
  const emit = (state: AttachmentState, media: MediaEvent) =>
    Effect.try({
      try: () =>
        output(state, {
          type: "media",
          media: { ...state.attachment, ...media, sequence: state.outputSequence++ },
        }),
      catch: failure,
    });
  const invalidate = Effect.fn("DeusLiveService.invalidate")(function* (state: AttachmentState) {
    yield* Queue.clear(state.output);
    state.attachment = { ...state.attachment, responseEpoch: state.attachment.responseEpoch + 1 };
    state.suppress = state.active;
    yield* emit(state, { type: "control", state: "interrupted" } as DeusMediaOutput);
  });
  const guard = Effect.fn("DeusLiveService.guard")(function* (state: AttachmentState) {
    if (state.closed) return yield* stale();
    yield* owner.validate(state.attachment);
    const grant = yield* authority.authorize(state.attachment).pipe(Effect.mapError(unavailable));
    const conversation = yield* repository
      .currentConversation(state.attachment)
      .pipe(Effect.mapError(failure));
    if (conversation !== state.conversation) return yield* stale();
    return grant;
  });
  const lookup = Effect.fn("DeusLiveService.lookup")(function* (input: DeusAttachmentInput) {
    const decoded = yield* decodeAttachmentInput(input).pipe(Effect.mapError(stale));
    const state = states.get(decoded.attachmentId);
    if (
      !state ||
      state.attachment.generation !== decoded.generation ||
      state.attachment.sessionId !== decoded.sessionId ||
      state.attachment.projectId !== decoded.projectId ||
      state.attachment.environmentId !== decoded.environmentId
    )
      return yield* stale();
    return state;
  });
  const finish = Effect.fn("DeusLiveService.finish")(function* (
    state: AttachmentState,
    error?: "provider" | "reply-debt",
  ) {
    const text = state.outputText.trim();
    if (state.source?.type === "human" && (text || error)) {
      const input = state.source.input;
      yield* repository.commit({
        type: "respond",
        input: {
          ...input,
          inputId: DeusInputId.make(`deus-live-answer:${input.inputId}`),
          humanInputId: input.inputId,
          text:
            text ||
            "Voice did not complete a reply. Reconnect or retry; accepted workers are preserved.",
          ...(error ? { error } : {}),
        },
      });
      if (state.human?.inputId === input.inputId) state.debt = false;
    } else if (state.source?.type === "report" && text) {
      yield* repository.commit({
        type: "report-response",
        input: {
          ...state.attachment,
          inputId: DeusInputId.make(
            `deus-live-report:${state.attachment.attachmentId}:${state.turnId}`,
          ),
          sourceCursor: state.source.report.cursor,
          origin: {
            type: "live",
            attachmentId: state.attachment.attachmentId,
            generation: state.attachment.generation,
            turnId: state.turnId,
          },
          text,
        },
      });
    }
    state.outputText = "";
    state.source = undefined;
  }, Effect.mapError(failure));
  const finalizeInput = Effect.fn("DeusLiveService.finalizeInput")(function* (
    state: AttachmentState,
  ) {
    const text = state.inputText.trim();
    if (!text) return;
    if (state.debt && state.human) {
      state.source = { type: "human", input: state.human };
      yield* finish(state, "provider");
    }
    const input: SpokenInput = {
      ...state.attachment,
      conversation: state.conversation,
      inputId: DeusInputId.make(`deus-spoken:${yield* uuid}`),
      text,
      origin: {
        type: "live",
        attachmentId: state.attachment.attachmentId,
        generation: state.attachment.generation,
        turnId: state.turnId,
      },
    };
    yield* repository.commit({ type: "spoken-input", input }).pipe(Effect.mapError(failure));
    state.inputText = "";
    state.human = input;
    state.source = { type: "human", input };
    state.debt = true;
    state.nudged = false;
    state.continuation = false;
    yield* Deferred.succeed(state.ready, input);
  });
  const close = Effect.fn("DeusLiveService.close")(function* (
    state: AttachmentState,
    error?: Adapter.DeusLiveError,
  ) {
    if (state.closed) return;
    state.closed = true;
    yield* Deferred.fail(state.ready, stale());
    let cleanup: string | undefined;
    const preserve = yield* Effect.exit(
      Effect.gen(function* () {
        yield* finalizeInput(state);
        if (state.debt && state.human && !state.source)
          state.source = { type: "human", input: state.human };
        yield* finish(state, state.debt ? "provider" : undefined);
        if (state.debt && state.human) {
          state.source = { type: "human", input: state.human };
          yield* finish(state, "provider");
        }
      }),
    );
    if (Exit.isFailure(preserve))
      cleanup =
        "Could not persist the final voice segment; durable spoken reply debt remains recoverable.";
    yield* invalidate(state).pipe(Effect.ignore);
    const result = yield* Effect.exit(state.connection.close);
    if (Exit.isFailure(result))
      cleanup = `${cleanup ? `${cleanup} ` : ""}Live connection cleanup failed.`;
    yield* Queue.clear(state.output);
    if (error || cleanup)
      output(state, {
        type: "error",
        error: error ?? failure(undefined),
        ...(cleanup ? { cleanup } : {}),
      } as LiveOutput);
    yield* emit(state, { type: "control", state: "disconnected" } as DeusMediaOutput);
    yield* Deferred.succeed(state.ended, undefined);
    yield* Scope.close(state.scope, Exit.void).pipe(Effect.forkIn(serviceScope));
  });
  const run = <E>(state: AttachmentState, effect: Effect.Effect<void, E>) =>
    effect.pipe(Effect.catch((cause) => close(state, failure(cause))));
  const response = Effect.fn("DeusLiveService.response")(function (
    state: AttachmentState,
    call: Call,
    result: Record<string, unknown>,
    mode: DeusReport["mode"],
    continuing: boolean,
  ) {
    call.continuing = continuing;
    return state.closed || state.cancelled.has(call.id)
      ? Effect.void
      : state.connection.respond({
          id: call.id,
          name: call.name,
          response: result,
          scheduling: FunctionResponseScheduling[mode],
          willContinue: continuing,
        });
  });
  const pump = Effect.fn("DeusLiveService.pump")(function* (state: AttachmentState) {
    if (state.closed) return;
    yield* guard(state);
    let scan = state.cursor;
    let blocked = false;
    let deferred = 0;
    const deferredTasks = new Set<string>();
    while (!state.closed) {
      const page = yield* repository
        .readDeltas(state.attachment, scan)
        .pipe(Effect.mapError(failure));
      if (!page.length) return;
      for (const delta of page) {
        scan = delta.cursor;
        if (state.delivered.has(delta.cursor)) {
          if (!blocked) {
            state.cursor = delta.cursor;
            state.delivered.delete(delta.cursor);
          }
          continue;
        }
        if (delta.change.type === "conversation-reset") return yield* close(state, stale());
        if (delta.change.type === "report") {
          const report = delta.change.report;
          if (report.conversation === state.conversation && delta.cursor > state.snapshotCursor) {
            const candidate = state.streams.get(report.taskId);
            const stream = candidate?.runId === report.runId ? candidate : undefined;
            const call = stream?.call ?? state.bootstrap;
            if (
              !call ||
              state.spawning ||
              (report.mode === "WHEN_IDLE" && (state.active || state.debt))
            ) {
              blocked = true;
              if (++deferred > LIVE_LIMITS.callHistory)
                return yield* new DeusLiveError({
                  code: "backpressure",
                  message:
                    "Live deferred report history is full; reconnect. Reports remain durable.",
                });
              deferredTasks.add(report.taskId);
              continue;
            }
            if (report.mode === "INTERRUPT") {
              yield* finish(state);
              yield* invalidate(state);
            }
            const snapshot = yield* repository
              .snapshot(state.attachment)
              .pipe(Effect.mapError(failure));
            const task = snapshot.tasks.find((item) => item.id === report.taskId);
            const terminal =
              stream &&
              !report.subagentId &&
              task &&
              ["completed", "failed", "cancelled"].includes(task.status) &&
              task.workers[0]?.threadId === report.threadId &&
              stream.runId === report.runId &&
              !deferredTasks.has(report.taskId) &&
              !snapshot.reports.some(
                (next) =>
                  next.taskId === report.taskId &&
                  next.runId === report.runId &&
                  next.cursor > report.cursor &&
                  !state.delivered.has(next.cursor),
              );
            yield* response(state, call, { event: delta }, report.mode, !terminal);
            if (terminal) state.streams.delete(report.taskId);
            if (report.mode !== "SILENT") state.source = { type: "report", report };
          }
        }
        if (delta.change.type === "task") {
          const task = delta.change.task;
          const stream = state.streams.get(task.id);
          if (stream) yield* response(state, stream.call, { task }, "SILENT", true);
        }
        if (!blocked) state.cursor = delta.cursor;
        else {
          if (state.delivered.size >= LIVE_LIMITS.callHistory)
            return yield* new DeusLiveError({
              code: "backpressure",
              message: "Live report catch-up is full; reconnect. Deferred reports remain durable.",
            });
          state.delivered.add(delta.cursor);
        }
      }
    }
  });
  const execute = Effect.fn("DeusLiveService.execute")(function* (
    state: AttachmentState,
    call: Call,
    args: unknown,
  ) {
    try {
      const input = yield* call.input;
      call.humanInputId = input.inputId;
      if (state.closed || state.cancelled.has(call.id)) return;
      const grant = yield* guard(state);
      const mutation = ["spawn", "queue", "steer", "interrupt"].includes(call.name);
      let result: Record<string, unknown>;
      if (call.continuation && mutation) {
        result = [...state.calls.values()].find(
          (item) =>
            item !== call &&
            item.humanInputId === input.inputId &&
            item.signature === call.signature &&
            item.result,
        )?.result ?? {
          ok: false,
          recoverable: true,
          error: "continuation-cannot-authorize-new-mutation",
        };
      } else {
        result = yield* tools.execute({
          input,
          actionId: call.actionId,
          runtimeMode: grant.runtimeMode,
          name: call.name,
          args,
        });
      }
      call.result = result;
      yield* state.lane.withPermits(1)(
        Effect.gen(function* () {
          if (state.closed || state.cancelled.has(call.id)) return;
          yield* guard(state);
          if (call.name === "spawn" && result.ok === true) {
            const task = (result.result as { readonly task?: DeusTask } | undefined)?.task;
            if (task) {
              if (state.streams.size >= LIVE_LIMITS.callHistory)
                return yield* new DeusLiveError({
                  code: "backpressure",
                  message: "Live task stream history is full; reconnect.",
                });
              state.streams.set(task.id, { call, runId: task.workers[0]?.runId ?? null });
            }
          }
          if (call.name === "recover" && result.ok === true) {
            if (state.bootstrap) yield* response(state, state.bootstrap, {}, "SILENT", false);
            state.bootstrap = call;
          }
          const silent = ["spawn", "recover", "list"].includes(call.name);
          yield* response(
            state,
            call,
            result,
            silent ? "SILENT" : "WHEN_IDLE",
            call.name === "spawn" || call.name === "recover",
          );
        }),
      );
    } finally {
      state.runningCalls--;
      if (call.name === "spawn") state.spawning--;
    }
    yield* state.lane.withPermits(1)(pump(state));
  });
  const context = Effect.fn("DeusLiveService.context")(function* (state: AttachmentState) {
    try {
      while (state.contextPending && !state.closed) {
        const text = state.contextPending;
        state.contextPending = "";
        const revision = state.contextRevision;
        const evidence = yield* working.contextForInput({ ...state.attachment, query: text });
        if (state.closed) return;
        if (state.contextRevision === revision) {
          yield* guard(state);
          yield* state.connection.context(evidence);
        }
      }
    } finally {
      state.contextRunning = false;
    }
  });
  const message = Effect.fn("DeusLiveService.message")(function* (
    state: AttachmentState,
    incoming: LiveServerMessage,
  ) {
    if (state.closed) return;
    const content = incoming.serverContent;
    if (content) {
      if (content.interrupted) {
        if (!state.suppress) yield* finish(state, state.debt ? "provider" : undefined);
        state.active = true;
        yield* invalidate(state);
      }
      if (content.inputTranscription?.text) {
        state.inputText += content.inputTranscription.text;
        if (state.inputText.length > LIVE_LIMITS.transcript)
          return yield* new DeusLiveError({
            code: "bounds",
            message: "Spoken input exceeds the transcript bound.",
          });
        yield* emit(state, {
          type: "partial-transcript",
          role: "human",
          text: content.inputTranscription.text,
        } as DeusMediaOutput);
        state.contextRevision++;
        state.contextPending = state.inputText.slice(-1024);
        if (!state.contextRunning) {
          state.contextRunning = true;
          yield* run(state, context(state)).pipe(Effect.forkIn(serviceScope));
        }
      }
      if (content.inputTranscription?.finished) yield* finalizeInput(state);
      if (!state.suppress) {
        const transcript =
          content.outputTranscription?.text ??
          content.modelTurn?.parts
            ?.filter((part) => !part.thought)
            .map((part) => part.text ?? "")
            .join("") ??
          "";
        if (transcript) {
          if (!state.source && !state.inputText && !state.captured)
            return yield* new DeusLiveError({
              code: "provider",
              message: "Unsolicited Live transcript has no human or report source.",
            });
          state.active = true;
          state.outputText += transcript;
          if (state.outputText.length > LIVE_LIMITS.transcript)
            return yield* new DeusLiveError({
              code: "bounds",
              message: "Spoken output exceeds the transcript bound.",
            });
          yield* emit(state, {
            type: "partial-transcript",
            role: "assistant",
            text: transcript,
          } as DeusMediaOutput);
        }
        for (const part of content.modelTurn?.parts ?? []) {
          if (!part.inlineData?.data) continue;
          const data = part.inlineData.data;
          if (
            !/^audio\/pcm(?:;rate=24000)?$/.test(part.inlineData.mimeType ?? "") ||
            !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) ||
            Buffer.from(data, "base64").byteLength % 2 ||
            Buffer.from(data, "base64").byteLength > 32_000
          )
            return yield* new DeusLiveError({
              code: "bounds",
              message: "Expected mono PCM16LE Live output at 24000 Hz within the frame bound.",
            });
          if (!state.source && !state.inputText && !state.captured)
            return yield* new DeusLiveError({
              code: "provider",
              message: "Unsolicited Live speech has no human or report source.",
            });
          state.active = true;
          yield* emit(state, {
            type: "pcm",
            encoding: "pcm16le",
            channels: 1,
            sampleRate: 24_000,
            data,
          } as DeusMediaOutput);
        }
      }
    }
    yield* acceptCalls(state, incoming);
    if (content?.turnComplete) {
      yield* finalizeInput(state);
      if (state.outputText.trim()) yield* finish(state);
      yield* Effect.try({ try: () => output(state, { type: "turn-end" }), catch: failure });
      state.turnId = yield* uuid;
      state.active = false;
      const interrupted = state.suppress || content.interrupted;
      state.suppress = false;
      if (state.debt && state.human && !interrupted) {
        state.source = { type: "human", input: state.human };
        if (!state.nudged) {
          state.nudged = true;
          state.continuation = true;
          yield* state.connection.realtime({
            text: `Server continuation, NOT a new human input. Answer the original human now, provisionally if workers are running. Do not repeat accepted mutations. Original human: ${state.human.text}`,
          });
        } else {
          yield* finish(state, "reply-debt");
          yield* Effect.try({
            try: () =>
              output(state, {
                type: "error",
                error: new DeusLiveError({
                  code: "reply-debt",
                  message:
                    "The model ended twice without a conversational reply. Voice remains attached; workers are preserved.",
                }),
              } as LiveOutput),
            catch: failure,
          });
        }
      }
      if (!state.debt) {
        state.human = undefined;
        state.ready = yield* Deferred.make<SpokenInput, Adapter.DeusLiveError>();
        state.captured = false;
      }
    }
  });
  const acceptCalls = Effect.fn("DeusLiveService.acceptCalls")(function* (
    state: AttachmentState,
    incoming: LiveServerMessage,
  ) {
    for (const id of incoming.toolCallCancellation?.ids ?? []) {
      if (!state.calls.has(id)) continue;
      state.cancelled.add(id);
      if (state.cancelled.size > LIVE_LIMITS.callHistory)
        return yield* new DeusLiveError({
          code: "backpressure",
          message: "Too many cancelled Live calls; reconnect.",
        });
      if (state.bootstrap?.id === id) state.bootstrap = undefined;
      for (const [taskId, stream] of state.streams)
        if (stream.call.id === id) state.streams.delete(taskId);
    }
    for (const invocation of incoming.toolCall?.functionCalls ?? []) {
      const call = yield* prepareCall(state, invocation);
      if (call)
        yield* run(state, execute(state, call, invocation.args ?? {})).pipe(
          Effect.forkIn(serviceScope),
        );
    }
  });
  const prepareCall = Effect.fn("DeusLiveService.prepareCall")(function* (
    state: AttachmentState,
    invocation: FunctionCall,
  ) {
    if (!invocation.id || !invocation.name)
      return yield* new DeusLiveError({
        code: "provider",
        message: "Live function calls require a connection-local id and name.",
      });
    yield* Effect.try({
      try: () => checkBytes(invocation, 16_000),
      catch: () =>
        new DeusLiveError({
          code: "bounds",
          message: "Live function arguments exceed their bound.",
        }),
    });
    const signature = encodeJson([invocation.name, invocation.args ?? {}]);
    const previous = state.calls.get(invocation.id);
    if (previous) {
      if (previous.signature !== signature)
        return yield* new DeusLiveError({
          code: "provider",
          message: "Live function call identity changed.",
        });
      if (previous.result)
        yield* response(state, previous, previous.result, "SILENT", previous.continuing ?? false);
      return undefined;
    }
    if (state.runningCalls >= LIVE_LIMITS.calls || state.calls.size >= LIVE_LIMITS.callHistory)
      return yield* new DeusLiveError({
        code: "backpressure",
        message: "Live tool concurrency or call history is full; reconnect. Workers are preserved.",
      });
    const call: Call = {
      id: invocation.id,
      name: invocation.name,
      signature,
      actionId: `deus-live-tool:${state.attachment.attachmentId}:${state.attachment.generation}:${state.calls.size}`,
      input: state.human ? Effect.succeed(state.human) : Deferred.await(state.ready),
      continuation: state.continuation,
    };
    state.calls.set(call.id, call);
    state.runningCalls++;
    if (call.name === "spawn") state.spawning++;
    return call;
  });
  const attach = Effect.fn("DeusLiveService.attach")(function* (
    raw: DeusAttachment,
    after: DeusCursor,
  ) {
    const attachment = yield* decodeAttachment(raw).pipe(Effect.mapError(stale));
    yield* owner.validate(attachment);
    yield* authority.authorize(attachment).pipe(Effect.mapError(unavailable));
    const scope = yield* Scope.make();
    for (const [id, state] of states) if (state.closed) states.delete(id);
    if (
      states.size + acquiring.size >= 32 ||
      acquiring.has(attachment.sessionId) ||
      states.has(attachment.attachmentId) ||
      [...states.values()].some(
        (state) => !state.closed && state.attachment.sessionId === attachment.sessionId,
      )
    )
      return yield* stale();
    acquiring.add(attachment.sessionId);
    const acquire = Effect.gen(function* () {
      const signals = yield* repository.subscribe;
      const snapshot = yield* repository.snapshot(attachment).pipe(Effect.mapError(failure));
      if (after > snapshot.cursor) return yield* stale();
      const transcripts = page(
        snapshot.transcripts.slice(-16).map((entry) => ({ ...entry, ...preview(entry.text) })),
        5,
      );
      const tasks = page(snapshot.tasks.slice(-20), 5);
      const reports = page(
        snapshot.reports
          .slice(-20)
          .map((report) => ({ ...report, ...preview(report.text), mode: "SILENT" })),
        5,
      );
      const recovery = {
        evidenceOnly: true,
        recovery: {
          cursor: snapshot.cursor,
          conversation: snapshot.session.conversation,
          transcripts,
          tasks,
          reports,
          incomplete:
            transcripts.items.length < snapshot.transcripts.length ||
            tasks.items.length < snapshot.tasks.length ||
            reports.items.length < snapshot.reports.length,
        },
      };
      const connection = yield* adapter.connect(recovery);
      const state: AttachmentState = {
        attachment,
        scope,
        connection,
        output: yield* Queue.bounded<LiveOutput>(LIVE_LIMITS.queue),
        ended: yield* Deferred.make<void>(),
        lane: yield* Semaphore.make(1),
        calls: new Map(),
        cancelled: new Set(),
        streams: new Map(),
        ready: yield* Deferred.make<SpokenInput, Adapter.DeusLiveError>(),
        conversation: snapshot.session.conversation,
        snapshotCursor: snapshot.cursor,
        cursor: snapshot.cursor,
        delivered: new Set(),
        inputText: "",
        outputText: "",
        turnId: yield* uuid,
        inputSequence: -1,
        outputSequence: 0,
        contextRevision: 0,
        contextRunning: false,
        contextPending: "",
        captured: false,
        active: false,
        debt: false,
        nudged: false,
        continuation: false,
        suppress: false,
        muted: false,
        spawning: 0,
        runningCalls: 0,
        closed: false,
      };
      yield* guard(state);
      states.set(attachment.attachmentId, state);
      yield* emit(state, { type: "control", state: "listening" } as DeusMediaOutput);
      yield* Effect.addFinalizer(() => close(state).pipe(Effect.orDie));
      yield* Effect.forever(
        Effect.gen(function* () {
          const event = yield* Queue.take(connection.events);
          if (event.type === "failure") return yield* event.error;
          yield* state.lane.withPermits(1)(
            Effect.gen(function* () {
              yield* guard(state);
              yield* message(state, event.message);
              if (event.message.serverContent?.turnComplete) yield* pump(state);
            }),
          );
        }),
      ).pipe(
        Effect.catch((cause) => close(state, failure(cause))),
        Effect.forkScoped,
      );
      yield* Effect.forever(
        PubSub.take(signals).pipe(Effect.andThen(state.lane.withPermits(1)(pump(state)))),
      ).pipe(
        Effect.catch((cause) => close(state, failure(cause))),
        Effect.forkScoped,
      );
    }).pipe(Effect.provideService(Scope.Scope, scope));
    yield* acquire.pipe(
      Effect.mapError(failure),
      Effect.onError(() => Scope.close(scope, Exit.void)),
      Effect.ensuring(
        Effect.sync(() => {
          acquiring.delete(attachment.sessionId);
        }),
      ),
    );
  });
  yield* Effect.addFinalizer(() =>
    Effect.forEach(states.values(), (state) => Scope.close(state.scope, Exit.void), {
      discard: true,
    }),
  );
  return DeusLiveService.of({
    attach,
    input: Effect.fn("DeusLiveService.input")(function* (raw) {
      const input = yield* decodePcm(raw).pipe(
        Effect.mapError(
          () =>
            new DeusLiveError({
              code: "bounds",
              message: "Expected mono PCM16LE input at 16000 Hz within the frame bound.",
            }),
        ),
      );
      const state = yield* lookup(input);
      yield* guard(state);
      if (
        input.responseEpoch !== state.attachment.responseEpoch ||
        input.sequence <= state.inputSequence
      )
        return yield* stale();
      state.inputSequence = input.sequence;
      state.captured = true;
      if (!state.muted)
        yield* run(
          state,
          state.connection.realtime({
            audio: { data: input.data, mimeType: "audio/pcm;rate=16000" },
          }),
        );
    }),
    control: Effect.fn("DeusLiveService.control")(function* (raw) {
      const input = yield* decodeControl(raw).pipe(Effect.mapError(stale));
      const state = yield* lookup(input);
      yield* guard(state);
      if (
        input.responseEpoch !== state.attachment.responseEpoch ||
        input.sequence <= state.inputSequence
      )
        return yield* stale();
      state.inputSequence = input.sequence;
      yield* state.lane.withPermits(1)(
        run(
          state,
          Effect.gen(function* () {
            if (input.action === "mute") {
              state.muted = true;
              yield* state.connection.realtime({ audioStreamEnd: true });
            }
            if (input.action === "resume") state.muted = false;
            if (input.action === "interrupt-response") yield* invalidate(state);
          }),
        ),
      );
    }),
    next: Effect.fn("DeusLiveService.next")(function* (input) {
      const state = yield* lookup(input);
      yield* owner.validate(state.attachment);
      if (!state.closed) yield* guard(state).pipe(Effect.catch((cause) => close(state, cause)));
      if (state.closed) {
        yield* Deferred.await(state.ended);
        if (Queue.sizeUnsafe(state.output) === 0) return yield* stale();
      }
      return yield* Queue.take(state.output);
    }),
    detach: Effect.fn("DeusLiveService.detach")(function* (input) {
      const state = yield* lookup(input);
      yield* state.lane.withPermits(1)(close(state));
      yield* Scope.close(state.scope, Exit.void);
      states.delete(state.attachment.attachmentId);
    }),
  });
});
export const layer = Layer.effect(DeusLiveService, make);
