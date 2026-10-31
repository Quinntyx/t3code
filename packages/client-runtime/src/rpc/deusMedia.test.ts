import { describe, expect, it } from "@effect/vitest";
import {
  DeusAttachmentId,
  DeusConversation,
  DeusSessionId,
  EnvironmentId,
  ProjectId,
  type DeusAttachment,
  type DeusMediaOutput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { makeDeusMediaController, type DeusMediaTransport } from "./deusMedia.ts";

const base = {
  environmentId: EnvironmentId.make("destination"),
  projectId: ProjectId.make("project"),
  sessionId: DeusSessionId.make("session"),
  attachmentId: DeusAttachmentId.make("attachment"),
  generation: 1,
  responseEpoch: 0,
};
const fixture = Effect.fn("DeusMediaTest.fixture")(function* (
  onEpoch?: (epoch: number) => void,
  conversation?: DeusConversation,
) {
  const disconnected = yield* Deferred.make<void>();
  const pushed = yield* Queue.unbounded<void>();
  const renewed = yield* Queue.unbounded<void>();
  const pushGate = yield* Deferred.make<void>();
  const received = yield* Queue.unbounded<DeusMediaOutput>();
  let inflight = 0,
    maximum = 0,
    controls = 0,
    renewals = 0,
    detaches = 0;
  const now = (yield* DateTime.now).epochMilliseconds;
  const attachment: DeusAttachment = {
    ...base,
    expiresAt: DateTime.formatIso(DateTime.makeUnsafe(now + 30000)),
  };
  const transport: DeusMediaTransport = {
    push: () =>
      Effect.gen(function* () {
        inflight++;
        maximum = Math.max(maximum, inflight);
        yield* Queue.offer(pushed, undefined);
        yield* Deferred.await(pushGate).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              inflight--;
            }),
          ),
        );
      }),
    control: () =>
      Effect.sync(() => {
        controls++;
      }),
    renew: Effect.gen(function* () {
      renewals++;
      yield* Queue.offer(renewed, undefined);
      return {
        ...attachment,
        expiresAt: DateTime.formatIso(DateTime.add(yield* DateTime.now, { seconds: 30 })),
      };
    }),
    detach: Effect.sync(() => {
      detaches++;
    }),
    output: Stream.fromQueue(received),
    disconnected: Deferred.await(disconnected),
  };
  const controller = yield* makeDeusMediaController(attachment, transport, onEpoch, conversation);
  return {
    controller,
    disconnected,
    pushed,
    renewed,
    received,
    pushGate,
    counts: () => ({ inflight, maximum, controls, renewals, detaches }),
  };
});

describe("bounded portable Deus media controller", () => {
  it.effect("preserves canonical conversation/turn identity and rejects late or legacy media", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const conversation = DeusConversation.make(2);
        const h = yield* fixture(undefined, conversation);
        const pcm = {
          ...base,
          type: "pcm" as const,
          encoding: "pcm16le" as const,
          channels: 1 as const,
          sampleRate: 24000 as const,
          data: "AAA=",
        };
        yield* Queue.offer(h.received, { ...pcm, sequence: 0 });
        yield* Queue.offer(h.received, {
          ...pcm,
          conversation: DeusConversation.make(1),
          turnId: "old",
          sequence: 1,
        });
        yield* Queue.offer(h.received, { ...pcm, conversation, turnId: "first", sequence: 2 });
        expect(yield* h.controller.takeFrame).toMatchObject({
          bytes: new Uint8Array(2),
          epoch: 0,
          conversation,
          turnId: "first",
        });
        yield* Queue.offer(h.received, {
          ...base,
          conversation,
          turnId: "first",
          sequence: 3,
          type: "turn-end",
        });
        yield* Queue.take(h.controller.events);
        yield* Queue.offer(h.received, { ...pcm, conversation, turnId: "first", sequence: 4 });
        yield* Queue.offer(h.received, { ...pcm, conversation, turnId: "second", sequence: 5 });
        expect(yield* h.controller.takeFrame).toMatchObject({ turnId: "second" });
        yield* Queue.offer(h.received, { ...pcm, conversation, turnId: "first", sequence: 6 });
        yield* Queue.offer(h.received, { ...pcm, conversation, turnId: "second", sequence: 7 });
        yield* h.controller.takeFrame;
        expect(h.controller.stats().rejectedOutput).toBe(4);
      }),
    ),
  );
  it.effect("flushes external scheduled playback synchronously on local and remote epochs", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const epochs: number[] = [];
        const h = yield* fixture((epoch) => {
          epochs.push(epoch);
        });
        yield* h.controller.control("interrupt-response");
        expect(epochs).toEqual([1]);
        yield* Queue.offer(h.received, {
          ...base,
          responseEpoch: 2,
          sequence: 0,
          type: "control",
          state: "interrupted",
        });
        yield* Queue.take(h.controller.events);
        expect(epochs).toEqual([1, 2]);
        yield* Queue.offer(h.received, {
          ...base,
          responseEpoch: 2,
          sequence: 1,
          type: "pcm",
          encoding: "pcm16le",
          channels: 1,
          sampleRate: 24000,
          data: "AAA=",
        });
        expect(yield* h.controller.takeFrame).toEqual({ bytes: new Uint8Array(2), epoch: 2 });
      }),
    ),
  );

  it.effect(
    "keeps one PCM request in flight and four pending, prioritizes mute/interrupt and never acquires audio",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* fixture();
          expect(yield* h.controller.offer(new Uint8Array(32000))).toBe(true);
          yield* Queue.take(h.pushed);
          for (let i = 0; i < 4; i++)
            expect(yield* h.controller.offer(new Uint8Array(32000))).toBe(true);
          expect(yield* h.controller.offer(new Uint8Array(32000))).toBe(false);
          expect(h.controller.stats()).toMatchObject({
            inputHighWater: 4,
            inputInFlight: 1,
            maxInputInFlight: 1,
            droppedInput: 1,
          });
          yield* h.controller.control("mute");
          expect(yield* h.controller.offer(new Uint8Array(32000))).toBe(false);
          yield* h.controller.control("interrupt-response");
          expect(h.counts()).toMatchObject({ controls: 2, maximum: 1 });
          yield* h.controller.dispose;
          expect(h.counts()).toMatchObject({ inflight: 0, detaches: 1 });
        }),
      ),
  );
  it.effect(
    "rejects malformed input and stale/other-owner output, flushes old PCM at an epoch change",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* fixture();
          for (const size of [0, 1, 32002])
            expect(yield* h.controller.offer(new Uint8Array(size))).toBe(false);
          const output = {
            ...base,
            type: "pcm" as const,
            encoding: "pcm16le" as const,
            channels: 1 as const,
            sampleRate: 24000 as const,
            sequence: 0,
            data: "AAA=",
          };
          yield* Queue.offer(h.received, {
            ...output,
            attachmentId: DeusAttachmentId.make("observer"),
          });
          yield* Queue.offer(h.received, output);
          yield* Queue.offer(h.received, {
            ...base,
            type: "control",
            state: "interrupted",
            responseEpoch: 1,
            sequence: 1,
          });
          expect(yield* Queue.take(h.controller.events)).toMatchObject({
            type: "control",
            responseEpoch: 1,
          });
          expect(h.controller.stats()).toMatchObject({
            outputQueued: 0,
            rejectedOutput: 1,
            responseEpoch: 1,
          });
          yield* Queue.offer(h.received, { ...output, responseEpoch: 0, sequence: 2 });
          yield* Queue.offer(h.received, { ...output, responseEpoch: 1, sequence: 3 });
          expect(yield* h.controller.takeAudio).toEqual(new Uint8Array(2));
          expect(h.controller.stats().rejectedOutput).toBe(2);
        }),
      ),
  );
  it.effect(
    "renews using TestClock and tears down pending setup/output on disconnect without reconnecting media",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const h = yield* fixture();
          yield* TestClock.adjust("10 seconds");
          expect(h.counts().renewals).toBe(1);
          yield* Queue.take(h.renewed);
          expect(h.counts().renewals).toBe(1);
          yield* Deferred.succeed(h.disconnected, undefined);
          yield* h.controller.closed;
          expect(yield* h.controller.offer(new Uint8Array(2))).toBe(false);
          expect(h.controller.stats().closed).toBe(true);
          expect(h.counts().detaches).toBe(1);
        }),
      ),
  );
  it.effect(
    "scope closure releases blocked media even when its caller fails before disposing",
    () =>
      Effect.gen(function* () {
        const result = yield* Effect.scoped(
          Effect.gen(function* () {
            const h = yield* fixture();
            yield* h.controller.offer(new Uint8Array(2));
            yield* Queue.take(h.pushed);
            return yield* Effect.fail("caller-stopped");
          }),
        ).pipe(Effect.flip);
        expect(result).toBe("caller-stopped");
      }),
  );
  it.effect("ends a saturated playback attachment without losing its terminal control event", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const h = yield* fixture();
        for (let sequence = 0; sequence < 5; sequence++)
          yield* Queue.offer(h.received, {
            ...base,
            type: "pcm",
            encoding: "pcm16le",
            channels: 1,
            sampleRate: 24000,
            sequence,
            data: "AAA=",
          });
        yield* h.controller.closed;
        expect(h.controller.stats()).toMatchObject({
          outputHighWater: 4,
          outputQueued: 0,
          closed: true,
        });
        expect(yield* Queue.take(h.controller.events)).toMatchObject({
          type: "error",
          error: { reason: "backpressure" },
        });
        yield* Effect.logInfo(`deus-controller fixture: ${JSON.stringify(h.controller.stats())}`);
      }),
    ),
  );
});
