import { DeusInput, DeusInputId, type DeusInputReceipt } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Sessions from "./DeusSessionService.ts";
import * as Repository from "./DeusRepository.ts";
import * as Working from "./DeusContextService.ts";
import * as Authority from "./DeusAuthority.ts";
import * as Adapter from "./GeminiTextAdapter.ts";
import * as Tools from "./DeusTools.ts";
import { type PendingIntent } from "./decide.ts";
import {
  Continuation,
  DeusTextError,
  TEXT_LIMITS,
  checkBytes,
  encodeJson,
  type TextContent,
  type TextFailureCode,
  TextReply as AdapterReply,
} from "./textProtocol.ts";
import { DEUS_TEXT_POLICY } from "./prompts/text.ts";

export const buildDeusTextRequest = (
  contents: ReadonlyArray<TextContent>,
): Adapter.TextRequest => ({
  systemInstruction: DEUS_TEXT_POLICY,
  contents,
  tools: Tools.DEUS_TOOL_DECLARATIONS,
});
const decodeInput = Schema.decodeEffect(DeusInput);
const decodeReply = Schema.decodeEffect(AdapterReply);
type Failure = Repository.DeusRepositoryError | Authority.DeusAuthorityError | DeusTextError;
export class DeusCoordinator extends Context.Service<
  DeusCoordinator,
  {
    readonly submit: (input: DeusInput) => Effect.Effect<DeusInputReceipt, Failure>;
    readonly recover: Effect.Effect<void, Failure>;
  }
>()("t3/deus/DeusCoordinator") {}
const make = Effect.gen(function* () {
  const sessions = yield* Sessions.DeusSessionService;
  const repository = yield* Repository.DeusRepository;
  const context = yield* Working.DeusContextService;
  const authority = yield* Authority.DeusAuthority;
  const adapter = yield* Adapter.GeminiTextAdapter;
  const tools = yield* Tools.DeusTools;
  const crypto = yield* Crypto.Crypto;
  const lane = yield* Semaphore.make(1);
  const execute = Effect.fn("DeusCoordinator.execute")(function* (initial: PendingIntent) {
    if (initial.intent.type !== "coordinate-input") return;
    const input = initial.intent.input;
    const digest = Buffer.from(
      yield* crypto
        .digest(
          "SHA-256",
          new TextEncoder().encode(
            encodeJson([input.environmentId, input.projectId, input.sessionId, input.inputId]),
          ),
        )
        .pipe(Effect.mapError(() => new DeusTextError({ code: "continuation" }))),
    ).toString("hex");
    let pending = initial;
    let continuation: Continuation = initial.intent.continuation ?? { revision: 0, steps: [] };
    const save = Effect.fn("DeusCoordinator.save")(function* (steps: Continuation["steps"]) {
      const next = { revision: continuation.revision + 1, steps };
      yield* repository.saveContinuation(pending, next);
      continuation = next;
      pending = { ...pending, intent: { type: "coordinate-input", input, continuation } };
    });
    const finish = Effect.fn("DeusCoordinator.finish")(function* (
      text: string,
      error?: TextFailureCode,
    ) {
      yield* repository.commit({
        type: "respond",
        input: {
          ...input,
          inputId: DeusInputId.make(`deus-answer:${digest}`),
          humanInputId: input.inputId,
          text,
          ...(error ? { error } : {}),
        },
      });
    });
    const run = Effect.gen(function* () {
      for (let round = 0; round < TEXT_LIMITS.rounds; round++) {
        const grant = yield* authority
          .authorize(input)
          .pipe(Effect.mapError(() => new DeusTextError({ code: "authority" })));
        if (!continuation.steps[round]) {
          const evidence = yield* context.contextForInput({ ...input, query: "" });
          const snapshot = yield* sessions.snapshot(input);
          const humanIndex = snapshot.transcripts.findIndex(
            (entry) => entry.role === "human" && entry.inputId === input.inputId,
          );
          const previous = snapshot.transcripts
            .slice(0, humanIndex)
            .filter((entry) => entry.conversation === input.conversation);
          const history = previous.slice(-TEXT_LIMITS.history);
          const contents: TextContent[] = [
            {
              role: "user",
              parts: [
                {
                  text: encodeJson({
                    input: {
                      inputId: input.inputId,
                      conversation: input.conversation,
                      text: input.text,
                    },
                    evidenceOnly: true,
                    history: { items: history, omitted: previous.length - history.length },
                    context: evidence,
                  }),
                },
              ],
            },
          ];
          for (const step of continuation.steps) {
            contents.push({ role: "model", parts: step.reply.parts });
            const calls = step.reply.parts.flatMap((part) =>
              part.functionCall ? [part.functionCall] : [],
            );
            contents.push({
              role: "user",
              parts: calls.length
                ? calls.map((call, index) => ({
                    functionResponse: {
                      name: call.name,
                      ...(call.id ? { id: call.id } : {}),
                      response: step.results[index]!,
                    },
                  }))
                : [
                    {
                      text: "A conversational answer is still owed for the original input. Reply now; do not leave a silent receipt.",
                    },
                  ],
            });
          }
          const request = buildDeusTextRequest(contents);
          yield* Effect.try({
            try: () => checkBytes(request, TEXT_LIMITS.requestBytes - 4096),
            catch: () => new DeusTextError({ code: "bounds" }),
          });
          yield* authority
            .authorize(input)
            .pipe(Effect.mapError(() => new DeusTextError({ code: "authority" })));
          const raw = yield* adapter.generate(request);
          const reply = yield* decodeReply(raw).pipe(
            Effect.mapError(() => new DeusTextError({ code: "provider" })),
          );
          yield* Effect.try({
            try: () => checkBytes(reply, TEXT_LIMITS.responseBytes),
            catch: () => new DeusTextError({ code: "bounds" }),
          });
          if (
            reply.parts.some((part) => part.functionResponse) ||
            reply.parts.filter((part) => part.functionCall).length > TEXT_LIMITS.calls
          )
            return yield* new DeusTextError({ code: "provider" });
          yield* save(
            continuation.steps.concat({
              reply,
              runtimeMode: grant.runtimeMode,
              actionIds: reply.parts
                .filter((part) => part.functionCall)
                .map((_, index) => `deus-tool:${digest}:${round}:${index}`),
              results: [],
            }),
          );
        }
        let step = continuation.steps[round]!;
        const calls = step.reply.parts.flatMap((part) =>
          part.functionCall ? [part.functionCall] : [],
        );
        if (step.actionIds.length !== calls.length || step.results.length > calls.length)
          return yield* new DeusTextError({ code: "continuation" });
        for (let index = step.results.length; index < calls.length; index++) {
          yield* authority
            .authorize(input)
            .pipe(Effect.mapError(() => new DeusTextError({ code: "authority" })));
          const call = calls[index]!;
          const result = yield* tools.execute({
            input,
            actionId: step.actionIds[index]!,
            runtimeMode: step.runtimeMode,
            name: call.name,
            args: call.args,
          });
          yield* Effect.try({
            try: () => checkBytes(result, TEXT_LIMITS.resultBytes),
            catch: () => new DeusTextError({ code: "bounds" }),
          });
          step = {
            reply: step.reply,
            runtimeMode: step.runtimeMode,
            actionIds: step.actionIds,
            results: step.results.concat(result),
          };
          yield* save(continuation.steps.map((item, at) => (at === round ? step : item)));
        }
        if (!calls.length) {
          const text = step.reply.parts
            .filter((part) => !part.thought)
            .map((part) => part.text ?? "")
            .join("")
            .trim();
          if (text) {
            yield* authority
              .authorize(input)
              .pipe(Effect.mapError(() => new DeusTextError({ code: "authority" })));
            yield* finish(text);
            return;
          }
        }
      }
      return yield* new DeusTextError({ code: "reply-debt" });
    });
    yield* run.pipe(
      Effect.catch((error) => {
        const code = error._tag === "DeusTextError" ? error.code : "continuation";
        return finish(new DeusTextError({ code }).message, code);
      }),
    );
  });
  return DeusCoordinator.of({
    submit: Effect.fn("DeusCoordinator.submit")(function (raw) {
      return Effect.gen(function* () {
        const input = yield* decodeInput(raw).pipe(
          Effect.mapError(() => new DeusTextError({ code: "bounds" })),
        );
        yield* Effect.try({
          try: () => checkBytes(input, 16_000),
          catch: () => new DeusTextError({ code: "bounds" }),
        });
        const snapshot = yield* sessions.snapshot(input);
        if (
          !snapshot.transcripts.some(
            (entry) => entry.role === "human" && entry.inputId === input.inputId,
          )
        )
          yield* authority.authorize(input);
        const receipt = yield* sessions.acceptInput(input);
        const pending = (yield* sessions.pending).find(
          (item) => item.sessionId === input.sessionId && item.inputId === input.inputId,
        );
        if (pending) yield* execute(pending);
        return receipt;
      }).pipe(lane.withPermits(1));
    }),
    recover: Effect.gen(function* () {
      for (const pending of yield* sessions.pending)
        if (pending.intent.type === "coordinate-input") yield* execute(pending);
    }).pipe(lane.withPermits(1)),
  });
});
export const layer = Layer.effect(DeusCoordinator, make);
