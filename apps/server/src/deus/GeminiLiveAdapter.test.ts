import { NodeWS } from "@effect/platform-node/NodeSocket";
import { assert, it } from "@effect/vitest";
import { FunctionResponseScheduling, GoogleGenAI } from "@google/genai";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
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
  const layer = Adapter.layerWithClient(
    (apiKey) =>
      new GoogleGenAI({
        apiKey,
        vertexai: false,
        httpOptions: { baseUrl: `http://127.0.0.1:${address.port}`, apiVersion: "v1beta" },
      }),
  ).pipe(Layer.provide(config));
  return {
    frames,
    sockets,
    layer,
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

it.live(
  "closes a late SDK session after acquisition is cancelled without dispatching media or tools",
  () =>
    Effect.gen(function* () {
      const h = yield* fixture;
      h.hold();
      yield* Effect.gen(function* () {
        const adapter = yield* Adapter.GeminiLiveAdapter;
        const acquiring = yield* adapter.connect({}).pipe(Effect.forkScoped);
        yield* Queue.take(h.frames);
        yield* Fiber.interrupt(acquiring);
        const socket = yield* Queue.take(h.sockets);
        const ended = Promise.withResolvers<void>();
        socket.once("close", () => ended.resolve());
        socket.send(JSON.stringify({ setupComplete: {} }));
        yield* Effect.promise(() => ended.promise);
      }).pipe(Effect.provide(h.layer));
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
        yield* connection.close;
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
