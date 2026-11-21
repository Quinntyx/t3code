// @effect-diagnostics nodeBuiltinImport:off - The teardown test reads the child's PID file it wrote.
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  type RegisteredMcpServersState,
  type ServerSettings as ServerSettingsType,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/process";
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
            { name: "FIXTURE_STRING_ID_PING" },
            { name: "FIXTURE_PAGINATE" },
            { name: "FIXTURE_TOOL_NAMES" },
            { name: "FIXTURE_LABEL" },
            { name: "FIXTURE_ERROR_DETAIL" },
          ],
        },
      ],
    },
  },
  config: {},
  ...overrides,
});

/** A server whose start failure echoes its secret config value to stderr. */
const secretFailureEntry = (secret: string): Entry => {
  const source = entry().source;
  if (source.kind !== "server.json") throw new Error("unreachable");
  const document = source.document as {
    packages: ReadonlyArray<{
      environmentVariables: ReadonlyArray<unknown>;
    }>;
  };
  return entry({
    config: { FIXTURE_START_FAILURE: secret },
    source: {
      kind: "server.json",
      document: {
        ...document,
        packages: document.packages.map((pkg) => ({
          ...pkg,
          environmentVariables: [
            ...pkg.environmentVariables,
            { name: "FIXTURE_START_FAILURE", isSecret: true },
          ],
        })),
      },
    },
  });
};

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
  options: {
    /** Wraps every spawned child, so a test can hold one where it needs it. */
    readonly wrapHandle?:
      | ((handle: ChildProcessSpawner.ChildProcessHandle) => ChildProcessSpawner.ChildProcessHandle)
      | undefined;
  } = {},
): Layer.Layer<ExternalMcpServers.ExternalMcpServers | ServerSettings.ServerSettingsService> => {
  // One settings instance, so a test's write is the change the reconciler sees.
  const settings = layerTestSettings(initial);
  const layerSpawner: Layer.Layer<ChildProcessSpawner.ChildProcessSpawner> =
    options.wrapHandle === undefined
      ? NodeServices.layer
      : Layer.effect(
          ChildProcessSpawner.ChildProcessSpawner,
          Effect.gen(function* () {
            const platform = yield* ChildProcessSpawner.ChildProcessSpawner;
            return ChildProcessSpawner.ChildProcessSpawner.of({
              ...platform,
              spawn: (command) => platform.spawn(command).pipe(Effect.map(options.wrapHandle!)),
            });
          }),
        ).pipe(Layer.provide(NodeServices.layer));
  return Layer.merge(
    ExternalMcpServers.layer.pipe(Layer.provide(Layer.merge(settings, layerSpawner))),
    settings,
  ).pipe(Layer.provideMerge(Layer.merge(layerSpawner, NodeCrypto.layer))) as unknown as Layer.Layer<
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
const runTestWith = <A, E>(entries: ReadonlyArray<Entry>, announces: number, body: Body<A, E>) =>
  Effect.gen(function* () {
    const servers = yield* ExternalMcpServers.ExternalMcpServers;
    yield* startServers(servers);
    // Each desired server announces once, so two servers are both started before the body runs.
    yield* servers.changes.pipe(
      Stream.take(announces),
      Stream.runDrain,
      Effect.timeout("20 seconds"),
    );
    return yield* body(servers);
  }).pipe(Effect.scoped, Effect.provide(layerTest(entries)));

const runTest = <A, E>(entries: ReadonlyArray<Entry>, body: Body<A, E>) =>
  runTestWith(entries, 1, body);

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
        expect((yield* servers.states).servers).toEqual([
          expect.objectContaining({ status: "running" }),
        ]);
      }),
  ),
);

it.live("answers a server ping whose id is a string", () =>
  runTest([entry({ config: { FIXTURE_STRING_ID_PING: "1" } })], (servers) =>
    Effect.gen(function* () {
      expect(yield* servers.tools).toHaveLength(3);
      expect((yield* servers.states).servers).toEqual([
        expect.objectContaining({ status: "running" }),
      ]);
    }),
  ),
);

it.live("gives a colliding tool name to the first server and reports the loser", () =>
  runTestWith(
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
    2,
    (servers) =>
      Effect.gen(function* () {
        const tools = yield* servers.tools;
        expect(
          tools.filter((tool) => tool.name === "notes_team_search").map((tool) => tool.serverId),
        ).toEqual(["first"]);

        const states = (yield* servers.states).servers;
        expect(states[0]?.tools).toContain("notes_team_search");
        expect(states[1]?.tools).not.toContain("notes_team_search");
        expect(states[1]?.tools).toContain("notes_team_image");
        expect(states[1]?.skippedTools).toEqual(["as notes_team_search, which another tool uses"]);

        const winner = tools.find((tool) => tool.name === "notes_team_search")!;
        const result = yield* servers.callTool(winner, { text: "hi" });
        expect(result.structuredContent).toEqual({ echoed: "hi", label: "first" });
      }),
  ),
);

it.live.each([
  {
    label: "replacement",
    names: ["a.b", "a_b", "crash-on-call"],
    emitted: "fixture_a_b",
    winner: "a.b",
  },
  {
    label: "truncation",
    names: ["x".repeat(60) + "a", "x".repeat(60) + "b", "crash-on-call"],
    emitted: `fixture_${"x".repeat(60)}`,
    winner: "x".repeat(60) + "a",
  },
])("skips one server's duplicate emitted name: $label", ({ names, emitted, winner }) =>
  runTest([entry({ config: { FIXTURE_TOOL_NAMES: names.join(",") } })], (servers) =>
    Effect.gen(function* () {
      const tools = yield* servers.tools;
      expect(tools.map((tool) => tool.name)).toEqual([emitted, "fixture_crash-on-call"]);
      expect(tools[0]?.originalName).toBe(winner);
      const state = (yield* servers.states).servers[0]!;
      expect(state.tools).toEqual([emitted, "fixture_crash-on-call"]);
      expect(state.skippedTools).toEqual([`as ${emitted}, which another tool uses`]);
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
        const state = (yield* servers.states).servers[0]!;
        expect(state.tools).toEqual(["html_image", "html_crash-on-call"]);
        expect(state.skippedTools).toEqual(["as html_render, which another tool uses"]);
      }),
  ),
);

it.live("redacts a single element of a secret list echoed by the child", () => {
  const failure = secretFailureEntry("on");
  if (failure.source.kind !== "server.json") throw new Error("unreachable");
  const document = failure.source.document as { packages: ReadonlyArray<object> };
  const withSecretList: Entry = {
    ...failure,
    source: {
      kind: "server.json",
      document: {
        ...document,
        packages: document.packages.map((pkg) => ({
          ...pkg,
          packageArguments: [{ type: "named", name: "--label", isRepeated: true, isSecret: true }],
        })),
      },
    },
    // The secret store hands a list secret back as JSON text.
    config: { ...failure.config, label: '["alpha,one","beta"]', FIXTURE_ERROR_DETAIL: "beta" },
  };
  return runTest([withSecretList], (servers) =>
    Effect.gen(function* () {
      const state = (yield* servers.states).servers[0]!;
      expect(state.status).toBe("failed");
      expect(state.stderrTail).toContain("fixture cannot start");
      expect(state.stderrTail).not.toContain("beta");
      expect(state.stderrTail).toContain("••••••");
    }),
  );
});

it.live("disabling a server stops its child and withdraws its tools", () =>
  runTest([entry()], (servers) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const stopped = yield* Effect.forkScoped(watcher(servers));
      yield* settings.updateSettings({
        registeredMcpServers: { fixture: entry({ enabled: false }) },
      });
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

      // The crash closed the child's scope, so the same server is launched again from fresh state.
      const settings = yield* ServerSettings.ServerSettingsService;
      const restarted = yield* Effect.forkScoped(watcher(servers));
      yield* settings.updateSettings({
        registeredMcpServers: { fixture: entry({ config: { RETRY: "1" } }) },
      });
      yield* Fiber.join(restarted);
      expect((yield* servers.states).servers).toEqual([
        expect.objectContaining({ id: "fixture", status: "running" }),
      ]);
      expect(yield* servers.tools).toHaveLength(3);
    }),
  ),
);

it.live("redacts secret launch values from the state sent to clients", () =>
  runTest([secretFailureEntry("fixture-secret-value")], (servers) =>
    Effect.gen(function* () {
      const state = (yield* servers.states).servers[0]!;
      expect(state.status).toBe("failed");
      expect(state.stderrTail).toContain("fixture cannot start");
      expect(state.stderrTail).not.toContain("fixture-secret-value");
      expect(state.stderrTail).toContain("••••••");
    }),
  ),
);

/** A child that fails while starting: present, then closed, with its state reported as failed. */
it.live("stops a child whose startup fails and launches it again once its config changes", () =>
  runTest([entry({ config: { FIXTURE_START_FAILURE: "missing token" } })], (servers) =>
    Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      expect((yield* servers.states).servers).toEqual([
        expect.objectContaining({
          status: "failed",
          stderrTail: expect.stringContaining("fixture cannot start"),
        }),
      ]);

      // Unchanged config is not a reason to try again, and nothing changes, so nothing is announced.
      yield* settings.updateSettings({
        registeredMcpServers: {
          fixture: entry({ config: { FIXTURE_START_FAILURE: "missing token" } }),
        },
      });
      expect((yield* servers.states).servers).toEqual([
        expect.objectContaining({ status: "failed" }),
      ]);

      // Supplying the value the server asked for is what a failed start waits for.
      const started = yield* Effect.forkScoped(watcher(servers));
      yield* settings.updateSettings({ registeredMcpServers: { fixture: entry() } });
      yield* Fiber.join(started);
      expect((yield* servers.states).servers).toEqual([
        expect.objectContaining({ id: "fixture", status: "running" }),
      ]);
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
      Effect.gen(function* () {
        expect((yield* servers.states).servers).toEqual([
          expect.objectContaining({
            id: "fixture",
            status: "failed",
            stderrTail: expect.stringContaining("remote servers are not supported"),
          }),
        ]);
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
      const failed = yield* Effect.forkScoped(watcher(servers));
      process.kill(pid, "SIGKILL");
      yield* Fiber.join(failed);

      expect((yield* servers.states).servers).toEqual([
        expect.objectContaining({ id: "fixture", status: "failed", tools: [] }),
      ]);
      expect(yield* servers.tools).toEqual([]);
    }).pipe(Effect.provide(layerTest([entry({ config: { FIXTURE_PID_FILE: pidFile } })])));
  }),
);

/**
 * A crashing child's cleanup yields, and a settings change during it starts a replacement. The
 * failed write must not land on the replacement: it would report the running server failed and
 * withdraw its tools.
 */
it.live("leaves a replacement's state alone when the crashed child's cleanup outlasts it", () =>
  Effect.gen(function* () {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-mcp-race-"));
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
    );
    const pidFile = NodePath.join(directory, "fixture.pid");
    // The crashing child's stop waits here, so a settings change arrives mid-cleanup.
    const holdStop = yield* Deferred.make<void>();
    const stopHeld = yield* Deferred.make<void>();
    let firstChild = true;
    yield* Effect.gen(function* () {
      const servers = yield* ExternalMcpServers.ExternalMcpServers;
      const settings = yield* ServerSettings.ServerSettingsService;
      yield* startServers(servers);
      yield* watcher(servers);
      const crash = (yield* servers.tools).find((tool) => tool.originalName === "crash-on-call")!;

      // Read from the announcement stream rather than `states`, which reconciles again and would
      // hide a stale write behind a fresh snapshot.
      const announced = yield* Queue.unbounded<RegisteredMcpServersState>();
      yield* servers.changes.pipe(
        Stream.tap((state) => Queue.offer(announced, state)),
        Stream.runDrain,
        Effect.forkScoped,
      );

      // The fixture exits when asked to, and the crash handler's cleanup waits on the held stop.
      yield* servers.callTool(crash, {}).pipe(Effect.ignore);
      yield* Deferred.await(stopHeld);

      // A settings change arrives while that cleanup waits. Its reconcile may not replace the
      // child behind the crash handler's back, so the crash's own state is what lands first.
      yield* settings.updateSettings({
        registeredMcpServers: { fixture: entry({ config: { RETRY: "1" } }) },
      });
      yield* Deferred.succeed(holdStop, undefined);

      // Two announcements arrive: the reconciler's snapshot of the replacement, and the crash's.
      // A `failed` snapshot here means the crash's write landed on the child that replaced it.
      const first = yield* Queue.take(announced);
      const last = yield* Queue.take(announced);
      expect([first, last].map((state) => state.servers[0]?.status)).not.toContain("failed");
      expect(last.servers).toEqual([expect.objectContaining({ id: "fixture", status: "running" })]);
      expect(last.servers[0]?.tools).toHaveLength(3);
    }).pipe(
      Effect.provide(
        layerTest([entry({ config: { FIXTURE_PID_FILE: pidFile } })], {
          wrapHandle: (handle) => {
            if (!firstChild) return handle;
            firstChild = false;
            return {
              ...handle,
              kill: (options) =>
                Deferred.succeed(stopHeld, undefined).pipe(
                  Effect.andThen(Deferred.await(holdStop)),
                  Effect.andThen(handle.kill(options)),
                ),
            };
          },
        }),
      ),
    );
  }),
);

/** The service scope owns every child, so teardown reaches one that is still running. */ it.live(
  "stops its child when the service scope closes",
  () =>
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
        expect((yield* servers.states).servers).toEqual([
          expect.objectContaining({ status: "running" }),
        ]);
      }).pipe(Effect.provide(context));

      const pid = Number(NodeFS.readFileSync(pidFile, "utf8"));
      expect(isRunning(pid)).toBe(true);
      // Closing waits for the child's own stop finalizer, so it has exited when this returns.
      yield* Scope.close(serviceScope, Exit.void);
      expect(isRunning(pid)).toBe(false);
    }),
);
