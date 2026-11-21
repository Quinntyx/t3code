// @effect-diagnostics nodeBuiltinImport:off - The teardown test reads the child's PID file it wrote.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type ServerSettings as ServerSettingsType,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { applyServerSettingsPatch } from "@t3tools/shared/serverSettings";

import * as ExternalMcpServers from "./ExternalMcpServers.ts";
import * as ServerSettings from "../serverSettings.ts";

const fixture = new URL("./fixtures/fixtureMcpServer.cjs", import.meta.url).pathname;

/** A process this suite started is gone: ESRCH, not a signal. */
const isRunning = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

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
          // Absent, the fixture starts; set, it fails while starting, as a broken server does.
          environmentVariables: [
            { name: "FIXTURE_START_FAILURE" },
            { name: "FIXTURE_PID_FILE" },
            { name: "FIXTURE_PING_BEFORE_LIST" },
            { name: "FIXTURE_PAGINATE" },
            { name: "FIXTURE_TOOL_NAMES" },
            { name: "FIXTURE_LABEL" },
          ],
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
            Effect.flatMap((current) => publish(applyServerSettingsPatch(current, patch))),
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
  return Layer.merge(
    ExternalMcpServers.layer.pipe(Layer.provide(Layer.merge(settings, NodeServices.layer))),
    settings,
  ).pipe(
    Layer.provideMerge(Layer.merge(NodeServices.layer, NodeCrypto.layer)),
  ) as unknown as Layer.Layer<
    ExternalMcpServers.ExternalMcpServers | ServerSettings.ServerSettingsService
  >;
};

/** Each reconcile announces once, so this waits for the change rather than polling. */
const watcher = (servers: ExternalMcpServers.ExternalMcpServers["Service"]) =>
  servers.changes.pipe(Stream.take(1), Stream.runDrain, Effect.timeout("20 seconds"));

/** Subscribes before returning, so the change a following write causes cannot be missed. */
const watch = (servers: ExternalMcpServers.ExternalMcpServers["Service"]) =>
  watcher(servers).pipe(Effect.forkScoped({ startImmediately: true }));

const startServers = (servers: ExternalMcpServers.ExternalMcpServers["Service"]) =>
  Effect.acquireRelease(Effect.forkScoped(servers.start), (fiber) =>
    Fiber.interrupt(fiber).pipe(Effect.asVoid),
  ) as Effect.Effect<void, never, Scope.Scope>;

/** The body runs inside the test's scope, with the settings store already in context. */
type Body<A, E> = (
  servers: ExternalMcpServers.ExternalMcpServers["Service"],
) => Effect.Effect<A, E, ServerSettings.ServerSettingsService | Scope.Scope>;

/** Runs `body` once the first reconcile settles, in one scope, so a failing body still stops it. */
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
        expect.objectContaining({ name: "fixture_image", originalName: "image" }),
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

it.live("answers a server's ping instead of taking it for a reply, and follows its pages", () =>
  runTest(
    [entry({ config: { FIXTURE_PING_BEFORE_LIST: "1", FIXTURE_PAGINATE: "1" } })],
    (servers) =>
      Effect.gen(function* () {
        // The ping reuses the tools/list id; only the real reply lists, so a misread resolves nothing
        // and the start fails. The pages come back in the server's order.
        expect(yield* servers.tools).toEqual([
          expect.objectContaining({ name: "fixture_echo" }),
          expect.objectContaining({ name: "fixture_image" }),
          expect.objectContaining({ name: "fixture_crash-on-call" }),
        ]);
        expect(yield* servers.states).toEqual([expect.objectContaining({ running: true })]);
      }),
  ),
);

it.live("gives a colliding tool name to the first server", () =>
  runTest(
    [
      entry({
        id: "first",
        name: "First",
        toolName: "notes",
        config: { FIXTURE_TOOL_NAMES: "team_search,image,crash-on-call", FIXTURE_LABEL: "first" },
      }),
      entry({
        id: "second",
        name: "Second",
        toolName: "notes_team",
        config: { FIXTURE_TOOL_NAMES: "search,image,crash-on-call", FIXTURE_LABEL: "second" },
      }),
    ],
    (servers) =>
      Effect.gen(function* () {
        const tools = yield* servers.tools;
        expect(
          tools.filter((tool) => tool.name === "notes_team_search").map((tool) => tool.serverId),
        ).toEqual(["first"]);

        const states = yield* servers.states;
        expect(states[0]?.tools).toContain("notes_team_search");
        expect(states[1]?.tools).not.toContain("notes_team_search");
        expect(states[1]?.tools).toContain("notes_team_image");

        const winner = tools.find((tool) => tool.name === "notes_team_search")!;
        const result = yield* servers.callTool(winner, { text: "hi" });
        expect(result.structuredContent).toEqual({ echoed: "hi", label: "first" });
      }),
  ),
);

it.live("omits a tool whose emitted name is reserved by a native tool", () =>
  runTest(
    [entry({ toolName: "html", config: { FIXTURE_TOOL_NAMES: "render,image,crash-on-call" } })],
    (servers) =>
      Effect.gen(function* () {
        expect((yield* servers.tools).map((tool) => tool.name)).toEqual([
          "html_image",
          "html_crash-on-call",
        ]);
        expect((yield* servers.states)[0]?.tools).toEqual(["html_image", "html_crash-on-call"]);
      }),
  ),
);

it.live("disabling a server stops its child and withdraws its tools", () =>
  runTest([entry()], (servers) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const stopped = yield* watch(servers);
      yield* settings.updateSettings({
        registeredMcpServers: { fixture: entry({ enabled: false }) },
      });
      yield* Fiber.join(stopped);

      expect(yield* servers.states).toEqual([
        expect.objectContaining({ enabled: false, running: false, tools: [] }),
      ]);
      expect(yield* servers.tools).toEqual([]);
    }),
  ),
);

it.live("leaves a crashed server stopped until its settings change", () =>
  runTest([entry()], (servers) =>
    Effect.gen(function* () {
      const echo = (yield* servers.tools).find((tool) => tool.originalName === "crash-on-call")!;
      // The fixture exits when asked to.
      const crashed = yield* watch(servers);
      yield* servers.callTool(echo, {}).pipe(Effect.ignore);
      yield* Fiber.join(crashed);

      expect(yield* servers.states).toEqual([
        expect.objectContaining({ enabled: true, running: false }),
      ]);
      // No retry on its own, so the tools stay unavailable until a toggle or settings change.
      expect(yield* servers.tools).toEqual([]);

      // The crash closed the child's scope, so the same server is launched again from fresh state.
      const settings = yield* ServerSettings.ServerSettingsService;
      const restarted = yield* watch(servers);
      yield* settings.updateSettings({
        registeredMcpServers: { fixture: entry({ config: { RETRY: "1" } }) },
      });
      yield* Fiber.join(restarted);
      expect(yield* servers.states).toEqual([expect.objectContaining({ running: true })]);
      expect(yield* servers.tools).toHaveLength(3);
    }),
  ),
);

/** A child that fails while starting: present, then closed, with its state reported as failed. */
it.live("stops a child whose startup fails and launches it again once its config changes", () =>
  runTest([entry({ config: { FIXTURE_START_FAILURE: "missing token" } })], (servers) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      expect(yield* servers.states).toEqual([expect.objectContaining({ running: false })]);

      // Unchanged config is not a reason to try again.
      const unchanged = yield* watch(servers);
      yield* settings.updateSettings({
        registeredMcpServers: {
          fixture: entry({ config: { FIXTURE_START_FAILURE: "missing token" } }),
        },
      });
      yield* Fiber.join(unchanged);
      expect(yield* servers.states).toEqual([expect.objectContaining({ running: false })]);

      // Supplying the value the server asked for is what a failed start waits for.
      const started = yield* watch(servers);
      yield* settings.updateSettings({ registeredMcpServers: { fixture: entry() } });
      yield* Fiber.join(started);
      expect(yield* servers.states).toEqual([expect.objectContaining({ running: true })]);
    }),
  ),
);

it.live("decodes image content from the child's result", () =>
  runTest([entry()], (servers) =>
    Effect.gen(function* () {
      const image = (yield* servers.tools).find((tool) => tool.originalName === "image")!;
      const result = yield* servers.callTool(image, {});

      expect(result.isError).toBe(false);
      expect(result.content).toEqual([
        {
          type: "image",
          mimeType: "image/png",
          data: new Uint8Array(
            Buffer.from(
              "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
              "base64",
            ),
          ),
        },
      ]);
    }),
  ),
);

it.live("launches nothing for a document it cannot run", () =>
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
      Effect.gen(function* () {
        expect(yield* servers.states).toEqual([expect.objectContaining({ running: false })]);
        // A document T3 refuses to launch never produced a child, so it exposes no tools.
        expect(yield* servers.tools).toEqual([]);
      }),
  ),
);

/** A child killed by a signal has no exit code, which must still count as having exited. */
it.live("records a child killed by a signal as failed instead of leaving it running", () =>
  Effect.gen(function* () {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcp-signal-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    const pidFile = NodePath.join(directory, "fixture.pid");
    yield* Effect.gen(function* () {
      const servers = yield* ExternalMcpServers.ExternalMcpServers;
      yield* startServers(servers);
      yield* watcher(servers);
      const pid = Number(NodeFS.readFileSync(pidFile, "utf8"));
      const failed = yield* watch(servers);
      process.kill(pid, "SIGKILL");
      yield* Fiber.join(failed);

      expect(yield* servers.states).toEqual([
        expect.objectContaining({ running: false, tools: [] }),
      ]);
      expect(yield* servers.tools).toEqual([]);
    }).pipe(Effect.provide(layerTest([entry({ config: { FIXTURE_PID_FILE: pidFile } })])));
  }),
);

/** The service scope owns every child, so teardown reaches one that is still running. */
it.live("stops its child when the service scope closes", () =>
  Effect.gen(function* () {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcp-teardown-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    const pidFile = NodePath.join(directory, "fixture.pid");
    const serviceScope = yield* Scope.make("sequential");
    // The layer is built in its own scope, which is the service's: closing that is teardown.
    const context = yield* Layer.build(
      layerTest([entry({ config: { FIXTURE_PID_FILE: pidFile } })]),
    ).pipe(Scope.provide(serviceScope));
    yield* Effect.gen(function* () {
      const servers = yield* ExternalMcpServers.ExternalMcpServers;
      yield* startServers(servers);
      yield* watcher(servers);
      expect(yield* servers.states).toEqual([expect.objectContaining({ running: true })]);
    }).pipe(Effect.provide(context));

    const pid = Number(NodeFS.readFileSync(pidFile, "utf8"));
    expect(isRunning(pid)).toBe(true);
    // Closing waits for the child's own stop finalizer, so it has exited when this returns.
    yield* Scope.close(serviceScope, Exit.void);
    expect(isRunning(pid)).toBe(false);
  }),
);
