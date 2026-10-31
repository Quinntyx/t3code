import type {
  DeusAttachment,
  DeusConversation,
  DeusMediaControlInput,
  DeusMediaOutput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { makeDeusMediaController, type DeusMediaTransport } from "../rpc/deusMedia.ts";

export interface DeusVoiceHandlers {
  readonly audio: (
    bytes: Uint8Array,
    epoch: number,
    identity: { readonly conversation?: DeusConversation; readonly turnId?: string },
  ) => void;
  readonly epoch: (epoch: number) => void;
  readonly event: (event: Exclude<DeusMediaOutput, { type: "pcm" }>) => void;
  readonly closed: () => void;
}

export type DeusVoiceConnection = Effect.Success<ReturnType<typeof makeDeusVoiceConnection>>;

export const makeDeusVoiceConnection = Effect.fn("DeusVoice.connect")(function* (
  attachment: DeusAttachment,
  transport: DeusMediaTransport,
  handlers: DeusVoiceHandlers,
  conversation?: DeusConversation,
) {
  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  const scope = yield* Scope.make();
  const setup = Effect.gen(function* () {
    handlers.epoch(attachment.responseEpoch);
    const controller = yield* makeDeusMediaController(
      attachment,
      transport,
      handlers.epoch,
      conversation,
    );
    yield* Effect.forever(
      controller.takeFrame.pipe(
        Effect.tap((frame) => Effect.sync(() => handlers.audio(frame.bytes, frame.epoch, frame))),
      ),
    ).pipe(Effect.forkScoped);
    yield* Effect.forever(
      Queue.take(controller.events).pipe(
        Effect.tap((event) => Effect.sync(() => handlers.event(event))),
      ),
    ).pipe(Effect.forkScoped);
    yield* controller.closed.pipe(Effect.andThen(Effect.sync(handlers.closed)), Effect.forkScoped);
    return {
      offer: (bytes: Uint8Array) => run(controller.offer(bytes)),
      control: (action: DeusMediaControlInput["action"]) => run(controller.control(action)),
      dispose: () => run(Scope.close(scope, Exit.void)),
    };
  });
  return yield* setup.pipe(
    Effect.provideService(Scope.Scope, scope),
    Effect.onError(() => Scope.close(scope, Exit.void)),
  );
});
