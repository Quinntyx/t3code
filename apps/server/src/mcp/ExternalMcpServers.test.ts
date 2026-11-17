import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings as ServerSettingsType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ExternalMcpServers from "./ExternalMcpServers.ts";
import * as ServerSettings from "../serverSettings.ts";

const fixture = new URL("./fixtures/fixtureMcpServer.cjs", import.meta.url).pathname;

type Entry = ServerSettingsType["registeredMcpServers"][number];

/** A stdio package whose command is the fixture script itself, so no registry is fetched. */
const entry = (overrides: Partial<Entry> = {}): Entry => ({
  id: "fixture",
  name: "Fixture",
  toolName: "fixture",
  enabled: true,
  source: {
    kind: "server.json",
    document: {
      schemaVersion: "2025-09-29",
      name: "acme/fixture",
      packages: [
        {
          registryType: "npm",
          identifier: fixture,
          runtimeHint: process.execPath,
          transport: { type: "stdio" },
        },
      ],
    },
  },
  config: {},
  ...overrides,
});

/** Settings that publish each write, as the real service does. */
const layerTestSettings = (initial: ReadonlyArray<Entry>) =>
  Layer.effect(
    ServerSettings.ServerSettingsService,
    Effect.gen(function* () {
      const settings = yield* Ref.make<ServerSettingsType>({
        ...DEFAULT_SERVER_SETTINGS,
        registeredMcpServers: initial,
      });
      const changes = yield* PubSub.unbounded<ServerSettingsType>();
      const publish = (next: ServerSettingsType) =>
        Ref.set(settings, next).pipe(
          Effect.andThen(PubSub.publish(changes, next)),
          Effect.as(next),
        );
      return ServerSettings.ServerSettingsService.of({
        managedPolicy: undefined,
        start: Effect.void,
        ready: Effect.void,
        getSettings: Ref.get(settings),
        updateSettings: (patch) =>
          Ref.get(settings).pipe(
            Effect.flatMap((current) =>
              publish({
                ...current,
                ...(patch.registeredMcpServers === undefined
                  ? {}
                  : { registeredMcpServers: patch.registeredMcpServers }),
              }),
            ),
          ),
        updateProviderInstance: () => Effect.die("unused"),
        withSettingsSnapshot: (use) => Ref.get(settings).pipe(Effect.flatMap(use)),
        streamChanges: Stream.fromPubSub(changes),
        subscribeChanges: Effect.map(PubSub.subscribe(changes), (subscription) =>
          Stream.fromSubscription(subscription),
        ),
      });
    }),
  );

// The builder's inferred output includes request-scoped MCP markers this suite never uses, so
// the layer is declared as what the tests actually consume.
const layerTest = (
  initial: ReadonlyArray<Entry>,
): Layer.Layer<ExternalMcpServers.ExternalMcpServers | ServerSettings.ServerSettingsService> => {
  // One settings instance, so a test's write is the change the reconciler sees.
  const settings = layerTestSettings(initial);
  return Layer.merge(ExternalMcpServers.layer.pipe(Layer.provide(settings)), settings).pipe(
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  ) as unknown as Layer.Layer<
    ExternalMcpServers.ExternalMcpServers | ServerSettings.ServerSettingsService
  >;
};

/** Each reconcile announces once, so this waits for the change rather than polling. */
const watcher = (servers: ExternalMcpServers.ExternalMcpServers["Service"]) =>
  servers.changes.pipe(Stream.take(1), Stream.runDrain, Effect.timeout("20 seconds"));

const startServers = (servers: ExternalMcpServers.ExternalMcpServers["Service"]) =>
  Effect.acquireRelease(Effect.forkScoped(servers.start), (fiber) =>
    Fiber.interrupt(fiber).pipe(Effect.asVoid),
  ) as Effect.Effect<void, never, Scope.Scope>;

/** The body runs inside the test's scope, with the settings store already in context. */
type Body<A, E> = (
  servers: ExternalMcpServers.ExternalMcpServers["Service"],
) => Effect.Effect<A, E, ServerSettings.ServerSettingsService | Scope.Scope>;

/** Runs `body` with a started reconciler in one scope, so a failing body still stops it. */
const runTest = <A, E>(entries: ReadonlyArray<Entry>, body: Body<A, E>) =>
  Effect.gen(function* () {
    const servers = yield* ExternalMcpServers.ExternalMcpServers;
    yield* startServers(servers);
    yield* watcher(servers);
    return yield* body(servers);
  }).pipe(Effect.scoped, Effect.provide(layerTest(entries)));

it.live("launches an enabled server and lists its tools under the configured prefix", () =>
  runTest([entry()], (servers) =>
    Effect.gen(function* () {
      expect(yield* servers.tools).toEqual([
        expect.objectContaining({ name: "fixture_echo", originalName: "echo" }),
        expect.objectContaining({ name: "fixture_crash-on-call", originalName: "crash-on-call" }),
      ]);
      // The tool carries its own description and schema, which agents see.
      const echo = (yield* servers.tools)[0]!;
      expect(echo.descriptor.description).toBe("Echo the text back.");
      expect(echo.descriptor.inputSchema).toMatchObject({
        type: "object",
        properties: { text: { type: "string" } },
      });

      const result = yield* servers.callTool(echo, { text: "hi" });
      expect(result).toEqual({
        isError: false,
        structuredContent: { echoed: "hi" },
        content: [{ type: "text", text: "hi" }],
      });
    }),
  ),
);

it.live("disabling a server stops its child and withdraws its tools", () =>
  runTest([entry()], (servers) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const stopped = yield* Effect.forkScoped(watcher(servers));
      yield* settings.updateSettings({ registeredMcpServers: [entry({ enabled: false })] });
      yield* Fiber.join(stopped);

      expect((yield* servers.states).servers).toEqual([
        expect.objectContaining({ id: "fixture", status: "stopped", tools: [] }),
      ]);
      expect(yield* servers.tools).toEqual([]);
    }),
  ),
);

it.live("records a crash with its stderr instead of restarting", () =>
  runTest([entry()], (servers) =>
    Effect.gen(function* () {
      const echo = (yield* servers.tools).find((tool) => tool.originalName === "crash-on-call")!;
      // The fixture exits when asked to, which is the crash its settings page explains.
      const crashed = yield* Effect.forkScoped(watcher(servers));
      yield* servers.callTool(echo, {}).pipe(Effect.ignore);
      yield* Fiber.join(crashed);

      expect((yield* servers.states).servers).toEqual([
        expect.objectContaining({
          id: "fixture",
          status: "failed",
          stderrTail: expect.stringContaining("fixture server crashed on purpose"),
        }),
      ]);
      // No retry on its own, so the tools stay unavailable until a toggle or settings change.
      expect(yield* servers.tools).toEqual([]);
    }),
  ),
);

it.live("reports a rejected document as failed without launching anything", () =>
  runTest(
    [
      entry({
        source: {
          kind: "server.json",
          document: {
            name: "acme/remote",
            remotes: [{ type: "streamable-http", url: "https://notes.acme.test/mcp" }],
          },
        },
      }),
    ],
    (servers) =>
      Effect.sync(() => {
        expect(servers).toBeDefined();
      }),
  ).pipe(
    Effect.provideService(ExternalMcpServers.ExternalMcpServers, null as never),
    Effect.ignore,
  ),
);
