import { NodeWS } from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import { FunctionResponseScheduling } from "@google/genai";
import { createLiveClient } from "./geminiLiveProcess.ts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import type { LiveClient, LiveSession } from "./geminiLiveProcess.ts";
import * as Configuration from "./DeusConfiguration.ts";
import * as Adapter from "./GeminiLiveAdapter.ts";
import { DEUS_TOOL_DECLARATIONS } from "./DeusTools.ts";

const key = "synthetic-local-websocket-only-key";
const config = Layer.mock(Configuration.DeusConfiguration)({
  withLiveCredential: (use) => use("configured-live-model", "configured-voice", key),
});
const fixture = Effect.gen(function* () {
  const frames = yield* Queue.unbounded<Record<string, unknown>>();
  const sockets = yield* Queue.unbounded<NodeWS.WebSocket>();
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeWS.WebSocketServer({ port: 0 })),
    (value) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const client of value.clients) client.terminate();
            value.close(() => resolve());
          }),
      ),
  );
  if (!server.address())
    yield* Effect.promise(() => new Promise<void>((resolve) => server.once("listening", resolve)));
  const address = server.address();
  if (typeof address !== "object" || !address)
    return yield* Effect.die("Expected local socket fixture");
  let reject = false;
  let hold = false;
  server.on("connection", (socket) => {
    Queue.offerUnsafe(sockets, socket);
    socket.on("message", (bytes) => {
      const frame: Record<string, unknown> = JSON.parse(bytes.toString());
      Queue.offerUnsafe(frames, frame);
      if (frame.setup) {
        if (reject) socket.close(1008, `Unsupported NON_BLOCKING; key=${key}`);
        else if (!hold) socket.send(JSON.stringify({ setupComplete: {} }));
      }
    });
  });
  const owners: ReturnType<typeof createLiveClient>[] = [];
  const layer = Adapter.layerWithClient((apiKey) => {
    const client = createLiveClient({
      apiKey,
      baseUrl: `http://127.0.0.1:${address.port}`,
      ...(process.env.T3_TEST_DEUS_ENTRY ? { entry: process.env.T3_TEST_DEUS_ENTRY } : {}),
    });
    owners.push(client);
    return client;
  }).pipe(Layer.provide(config));
  return {
    frames,
    sockets,
    layer,
    owners,
    server,
    reject: () => {
      reject = true;
    },
    hold: () => {
      hold = true;
    },
  };
});

it("redacts known credentials and quoted authorization/header/token causes", () => {
  const cause =
    '{"Authorization":"Bearer another-secret","x-goog-api-key":"header-secret","access_token":"token-secret"} literal-local-key';
  const safe = Adapter.redactLiveText(cause, "literal-local-key");
  for (const secret of ["another-secret", "header-secret", "token-secret", "literal-local-key"])
    assert.notInclude(safe, secret);
});

it.live("closes the actual SDK socket when cancelled before setup ever completes", () =>
  Effect.gen(function* () {
    const h = yield* fixture;
    h.hold();
    yield* Effect.gen(function* () {
      const adapter = yield* Adapter.GeminiLiveAdapter;
      const acquiring = yield* adapter.connect({}).pipe(Effect.forkScoped);
      yield* Queue.take(h.frames);
      const socket = yield* Queue.take(h.sockets);
      const ended = Promise.withResolvers<void>();
      socket.once("close", () => ended.resolve());
      yield* Fiber.interrupt(acquiring);
      yield* Effect.promise(() => ended.promise);
      assert.equal(Queue.sizeUnsafe(h.frames), 0);
      assert.equal(h.server.clients.size, 0);
      assert.lengthOf(h.owners, 1);
      assert.equal(h.owners[0]!.owner.signalCode, "SIGKILL");
      assert.equal(h.owners[0]!.owner.connected, false);
      assert.lengthOf(h.owners[0]!.owner.eventNames(), 0);
    }).pipe(Effect.provide(h.layer));
  }),
);

it.live("closes a never-ready SDK socket when its acquisition scope closes", () =>
  Effect.gen(function* () {
    const h = yield* fixture;
    h.hold();
    yield* Effect.gen(function* () {
      const adapter = yield* Adapter.GeminiLiveAdapter;
      const scope = yield* Scope.make();
      const acquiring = yield* adapter
        .connect({})
        .pipe(Effect.provideService(Scope.Scope, scope), Effect.forkIn(scope));
      yield* Queue.take(h.frames);
      const socket = yield* Queue.take(h.sockets);
      const ended = Promise.withResolvers<void>();
      socket.once("close", () => ended.resolve());
      yield* Scope.close(scope, Exit.void);
      assert.equal((yield* Fiber.await(acquiring))._tag, "Failure");
      yield* Effect.promise(() => ended.promise);
      assert.equal(h.server.clients.size, 0);
      assert.lengthOf(h.owners[0]!.owner.eventNames(), 0);
      assert.equal(Queue.sizeUnsafe(h.frames), 0);
    }).pipe(Effect.provide(h.layer));
  }),
);

it.live(
  "setup timeout terminates the real SDK owner and a peer that never sends setupComplete",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      h.hold();
      yield* Effect.gen(function* () {
        const adapter = yield* Adapter.GeminiLiveAdapter;
        const acquiring = yield* adapter.connect({}).pipe(Effect.forkScoped);
        yield* Queue.take(h.frames);
        const socket = yield* Queue.take(h.sockets);
        const ended = Promise.withResolvers<void>();
        socket.once("close", () => ended.resolve());
        yield* TestClock.adjust("30 seconds");
        const result = yield* Fiber.join(acquiring).pipe(Effect.flip);
        assert.include(result.message, "timed out");
        yield* Effect.promise(() => ended.promise);
        assert.equal(h.server.clients.size, 0);
        assert.lengthOf(h.owners[0]!.owner.eventNames(), 0);
        assert.equal(Queue.sizeUnsafe(h.frames), 0);
      }).pipe(Effect.provide(h.layer));
    }).pipe(Effect.provide(TestClock.layer())),
);

it.effect(
  "contains late setup rejection and a throwing late Session.close after cancellation",
  () =>
    Effect.gen(function* () {
      for (const late of ["reject", "close"] as const) {
        const started = Promise.withResolvers<void>();
        const pending = Promise.withResolvers<LiveSession>();
        const attempted = Promise.withResolvers<void>();
        let disposals = 0;
        const layer = Adapter.layerWithClient(() => ({
          connect: () => {
            started.resolve();
            return pending.promise;
          },
          dispose: () => {
            disposals++;
            return Promise.resolve();
          },
        })).pipe(Layer.provide(config));
        yield* Effect.gen(function* () {
          const adapter = yield* Adapter.GeminiLiveAdapter;
          const acquiring = yield* adapter.connect({}).pipe(Effect.forkScoped);
          yield* Effect.promise(() => started.promise);
          yield* Fiber.interrupt(acquiring);
          assert.isAtLeast(disposals, 1);
          if (late === "reject") {
            pending.reject(new Error("Late SDK setup rejection"));
            yield* Effect.promise(() => pending.promise.catch(() => undefined));
          } else {
            pending.resolve({
              sendRealtimeInput: () => undefined,
              sendToolResponse: () => undefined,
              sendContextUpdate: () => undefined,
              close: () => {
                attempted.resolve();
                throw new Error("Late SDK close failed");
              },
            });
            yield* Effect.promise(() => attempted.promise);
          }
          assert.equal((yield* Fiber.await(acquiring))._tag, "Failure");
        }).pipe(Effect.provide(layer));
      }
    }),
);

it.effect(
  "preserves an acquisition callback failure when an already-resolved late Session.close throws",
  () =>
    Effect.gen(function* () {
      let disposed = 0;
      const layer = Adapter.layerWithClient(() => ({
        connect: (parameters) => {
          parameters.callbacks.onerror?.({ message: "Original acquisition callback cause" });
          return Promise.resolve({
            sendRealtimeInput: () => undefined,
            sendToolResponse: () => undefined,
            sendContextUpdate: () => undefined,
            close: () => {
              throw new Error("Secondary late close cause");
            },
          });
        },
        dispose: () => {
          disposed++;
          throw new Error("Secondary disposal cause");
        },
      })).pipe(Layer.provide(config));
      yield* Effect.gen(function* () {
        const adapter = yield* Adapter.GeminiLiveAdapter;
        const result = yield* adapter.connect({}).pipe(Effect.flip);
        assert.include(result.message, "Original acquisition callback cause");
        assert.notInclude(result.message, "Secondary late close cause");
        assert.isAtLeast(disposed, 1);
      }).pipe(Effect.provide(layer));
    }),
);

it.effect("preserves setup rejection and established close errors even when disposal fails", () =>
  Effect.gen(function* () {
    for (const phase of ["setup", "established"] as const) {
      let disposals = 0;
      const layer = Adapter.layerWithClient(
        () =>
          ({
            connect: () =>
              phase === "setup"
                ? Promise.reject(new Error("Original setup cause"))
                : Promise.resolve({
                    sendRealtimeInput: () => undefined,
                    sendToolResponse: () => undefined,
                    sendContextUpdate: () => undefined,
                    close: () => {
                      throw new Error("Original close cause");
                    },
                  }),
            dispose: () => {
              disposals++;
              return Promise.reject(new Error("Secondary disposal cause"));
            },
          }) satisfies LiveClient,
      ).pipe(Layer.provide(config));
      yield* Effect.gen(function* () {
        const adapter = yield* Adapter.GeminiLiveAdapter;
        const error = yield* (
          phase === "setup"
            ? adapter.connect({}).pipe(Effect.asVoid)
            : adapter.connect({}).pipe(Effect.flatMap((connection) => connection.close))
        ).pipe(Effect.flip);
        assert.include(
          error.message,
          phase === "setup" ? "Original setup cause" : "Original close cause",
        );
        assert.isAtLeast(disposals, 1);
      }).pipe(Effect.provide(layer));
    }
  }),
);

it.live(
  "official SDK serializes Developer API Live setup, native PCM/VAD, non-blocking streams and all three scheduling modes",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      yield* Effect.gen(function* () {
        const adapter = yield* Adapter.GeminiLiveAdapter;
        const connection = yield* adapter.connect({
          evidenceOnly: true,
          recovery: { reports: [] },
        });
        const ready = yield* Queue.take(connection.events);
        assert.equal(ready.type, "message");
        const setup = JSON.stringify(yield* Queue.take(h.frames));
        assert.include(setup, "models/configured-live-model");
        assert.include(setup, "configured-voice");
        assert.include(setup, '"automaticActivityDetection":{"disabled":false}');
        assert.include(setup, '"inputAudioTranscription":{}');
        assert.include(setup, '"outputAudioTranscription":{}');
        assert.include(setup, '"behavior":"NON_BLOCKING"');
        assert.notInclude(setup, key);
        assert.equal((setup.match(/NON_BLOCKING/g) ?? []).length, DEUS_TOOL_DECLARATIONS.length);
        yield* connection.realtime({ audio: { data: "AAA=", mimeType: "audio/pcm;rate=16000" } });
        assert.include(JSON.stringify(yield* Queue.take(h.frames)), "audio/pcm;rate=16000");
        yield* connection.realtime({ audioStreamEnd: true });
        assert.include(JSON.stringify(yield* Queue.take(h.frames)), '"audioStreamEnd":true');
        for (const mode of ["SILENT", "WHEN_IDLE", "INTERRUPT"] as const) {
          yield* connection.respond({
            id: "connection-local",
            name: "spawn",
            response: { evidenceOnly: true },
            scheduling: FunctionResponseScheduling[mode],
            willContinue: true,
          });
          assert.deepEqual(yield* Queue.take(h.frames), {
            toolResponse: {
              functionResponses: [
                {
                  id: "connection-local",
                  name: "spawn",
                  response: { evidenceOnly: true },
                  scheduling: mode,
                  willContinue: true,
                },
              ],
            },
          });
        }
        yield* connection.context({ evidenceOnly: true, fromActualTranscription: "fixture human" });
        const context = JSON.stringify(yield* Queue.take(h.frames));
        assert.include(context, "contextUpdate");
        assert.notInclude(context, "clientContent");
        const socket = yield* Queue.take(h.sockets);
        socket.send(
          JSON.stringify({
            serverContent: {
              modelTurn: {
                parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAA=" } }],
              },
              turnComplete: true,
            },
          }),
        );
        const event = yield* Queue.take(connection.events);
        assert.equal(event.type, "message");
        if (event.type === "message") assert.equal(event.message.serverContent?.turnComplete, true);
        const ended = Promise.withResolvers<void>();
        socket.once("close", () => ended.resolve());
        yield* connection.close;
        yield* Effect.promise(() => ended.promise);
        assert.equal(h.server.clients.size, 0);
        assert.lengthOf(h.owners[0]!.owner.eventNames(), 0);
        assert.equal(
          (yield* connection.realtime({ text: "must not send" }).pipe(Effect.flip)).code,
          "provider",
        );
        assert.equal(
          (yield* connection
            .respond({ id: "stale", name: "spawn", response: {} })
            .pipe(Effect.flip)).code,
          "provider",
        );
        assert.equal(Queue.sizeUnsafe(h.frames), 0);
      }).pipe(Effect.provide(h.layer));
    }),
);

it.live(
  "fails a rejected setup rather than hanging or substituting a model, and redacts its actionable cause",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      h.reject();
      yield* Effect.gen(function* () {
        const adapter = yield* Adapter.GeminiLiveAdapter;
        const error = yield* adapter.connect({}).pipe(Effect.flip);
        assert.equal(error.code, "provider");
        assert.include(error.message, "Unsupported NON_BLOCKING");
        assert.notInclude(error.message, key);
        assert.include(error.message, "configured-live-model");
      }).pipe(Effect.provide(h.layer));
    }),
);

it.live(
  "bounds the native receive queue and reports backpressure without losing the original provider boundary",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      yield* Effect.gen(function* () {
        const adapter = yield* Adapter.GeminiLiveAdapter;
        const connection = yield* adapter.connect({});
        const socket = yield* Queue.take(h.sockets);
        const ended = Promise.withResolvers<void>();
        socket.once("close", () => ended.resolve());
        for (let index = 0; index <= Adapter.LIVE_LIMITS.queue; index++)
          socket.send(
            JSON.stringify({ serverContent: { outputTranscription: { text: "bounded" } } }),
          );
        yield* Effect.promise(() => ended.promise);
        const failure = yield* Queue.take(connection.events);
        assert.equal(failure.type, "failure");
        if (failure.type === "failure") assert.equal(failure.error.code, "backpressure");
      }).pipe(Effect.provide(h.layer));
    }),
);
