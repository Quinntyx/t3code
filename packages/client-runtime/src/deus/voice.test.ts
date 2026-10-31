import { describe, expect, it } from "@effect/vitest";
import {
  DeusAttachmentId,
  DeusSessionId,
  EnvironmentId,
  ProjectId,
  type DeusMediaOutput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { makeDeusVoiceConnection } from "./voice.ts";

describe("portable voice connection", () => {
  it.effect(
    "delivers canonical epochs and bounded PCM, disposes its lease without worker commands",
    () =>
      Effect.gen(function* () {
        const received = yield* Queue.unbounded<DeusMediaOutput>();
        const heard = yield* Queue.unbounded<{ bytes: Uint8Array; epoch: number }>();
        let detaches = 0;
        const epochs: number[] = [];
        const base = {
          environmentId: EnvironmentId.make("e"),
          projectId: ProjectId.make("p"),
          sessionId: DeusSessionId.make("s"),
          attachmentId: DeusAttachmentId.make("a"),
          generation: 1,
          responseEpoch: 5,
        };
        const connection = yield* makeDeusVoiceConnection(
          { ...base, expiresAt: "2099-01-01T00:00:00.000Z" },
          {
            push: () => Effect.void,
            control: () => Effect.void,
            renew: Effect.never,
            detach: Effect.sync(() => {
              detaches++;
            }),
            output: Stream.fromQueue(received),
            disconnected: Effect.never,
          },
          {
            audio: (bytes, epoch) => {
              Queue.offerUnsafe(heard, { bytes, epoch });
            },
            epoch: (epoch) => {
              epochs.push(epoch);
            },
            event: () => {},
            closed: () => {},
          },
        );
        expect(epochs).toEqual([5]);
        yield* Queue.offer(received, {
          ...base,
          sequence: 0,
          type: "pcm",
          encoding: "pcm16le",
          sampleRate: 24000,
          channels: 1,
          data: "AAA=",
        });
        expect(yield* Queue.take(heard)).toEqual({ bytes: new Uint8Array(2), epoch: 5 });
        expect(yield* Effect.promise(() => connection.control("interrupt-response"))).toBe(true);
        yield* Effect.promise(() => connection.dispose());
        expect(detaches).toBe(1);
        expect(yield* Effect.promise(() => connection.offer(new Uint8Array(640)))).toBe(false);
      }),
  );
});
