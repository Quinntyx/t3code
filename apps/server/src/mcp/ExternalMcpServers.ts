import { resolveMcpLaunch, type McpConfigValue } from "@t3tools/shared/mcpRegistration";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { type RegisteredMcpServerEntry } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FiberMap from "effect/FiberMap";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { McpSchema } from "effect/ai";

import * as ServerSettings from "../serverSettings.ts";
import { nativeToolNames } from "./nativeToolNames.ts";

// Long enough for a first `npx -y`, `uvx` or `docker run` to fetch the package or image.
const START_TIMEOUT = Duration.minutes(2);
const PROTOCOL_VERSION = "2025-06-18";

export interface ExternalMcpTool {
  readonly serverId: string;
  readonly serverName: string;
  /** The server's own tool name, used when forwarding the call. */
  readonly originalName: string;
  /** `<toolName>_<originalName>`, the name agents call. */
  readonly name: string;
  readonly descriptor: McpSchema.Tool;
}

export interface ExternalMcpToolResult {
  readonly content: ReadonlyArray<McpSchema.ContentBlock>;
  readonly structuredContent: unknown;
  readonly isError: boolean;
}

interface RunningServer {
  readonly entry: RegisteredMcpServerEntry;
  readonly tools: ReadonlyArray<ExternalMcpTool>;
  readonly call: (
    toolName: string,
    args: Readonly<Record<string, unknown>>,
  ) => Effect.Effect<McpSchema.CallToolResult, ExternalMcpServerError>;
  readonly scope: Scope.Closeable;
}

export interface ExternalMcpServerState {
  readonly name: string;
  readonly toolName: string;
  readonly enabled: boolean;
  readonly running: boolean;
  /** The proxied names agents call, in the server's own order. */
  readonly tools: ReadonlyArray<string>;
}

interface ServerRuntimeState {
  readonly running?: RunningServer | undefined;
  readonly starting?: RegisteredMcpServerEntry | undefined;
  /** What last failed, so an edited entry starts again and an unchanged one does not. */
  readonly failedEntry?: RegisteredMcpServerEntry | undefined;
}

/**
 * The local MCP servers a user registered in Settings → Capabilities. T3 owns their processes:
 * each runs while its entry is enabled, restarts when its settings change, stops when it is
 * disabled, and logs why it failed when it exits. Their tools are proxied into T3's MCP server.
 */
export class ExternalMcpServers extends Context.Service<
  ExternalMcpServers,
  {
    /** Reconciles once, then on every settings change, for the layer's lifetime. */
    readonly start: Effect.Effect<never>;
    readonly states: Effect.Effect<ReadonlyArray<ExternalMcpServerState>>;
    readonly tools: Effect.Effect<ReadonlyArray<ExternalMcpTool>>;
    readonly callTool: (
      tool: ExternalMcpTool,
      args: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<ExternalMcpToolResult, ExternalMcpServerError>;
    /** Emits after each change to what is running, including a crash. */
    readonly changes: Stream.Stream<void>;
  }
>()("t3/mcp/ExternalMcpServers") {}

/** A start, call or crash failure with a message a tool result can show. */
export class ExternalMcpServerError extends Schema.TaggedError<ExternalMcpServerError>()(
  "ExternalMcpServerError",
  { message: Schema.String },
) {}

const isExternalMcpServerError = Schema.is(ExternalMcpServerError);

const causeText = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return isExternalMcpServerError(error) || error instanceof Error
    ? error.message
    : Cause.pretty(cause);
};

const launchOf = (
  entry: RegisteredMcpServerEntry,
  host: { readonly home: string; readonly platform: string },
) =>
  resolveMcpLaunch(
    { source: entry.source, config: entry.config as Readonly<Record<string, McpConfigValue>> },
    host,
  );

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
/** Decodes the child's wire form, so base64 image and audio data comes back as bytes. */
const decodeCallToolResult = Schema.decodeUnknownSync(McpSchema.CallToolResult);
/** Settings round-trip through JSON, so a comparison on that form never sees a stale key order. */
const sameJson = (left: unknown, right: unknown) => encodeJson(left) === encodeJson(right);
/** What a server launches with: an edit to any of it is a reason to try a failed server again. */
const sameEntry = (left: RegisteredMcpServerEntry, right: RegisteredMcpServerEntry) =>
  left.toolName === right.toolName &&
  sameJson(left.config, right.config) &&
  sameJson(left.source, right.source);

// Providers cap a tool name at 64 characters, and Claude Code spends 14 on `mcp__t3-code__`.
const MAX_PROXIED_NAME_LENGTH = 50;

/** Providers accept letters, digits, `_` and `-`; anything else, in either part, becomes `_`. */
const proxiedToolName = (prefix: string, toolName: string) =>
  `${prefix}_${toolName}`.replaceAll(/[^a-zA-Z0-9_-]/gu, "_").slice(0, MAX_PROXIED_NAME_LENGTH);

/** Decides every proxied name once: native tools first, then servers in settings order. */
const exposeTools = (
  configured: ReadonlyArray<RegisteredMcpServerEntry>,
  runtime: ReadonlyMap<string, ServerRuntimeState>,
): ReadonlyArray<ExternalMcpTool> => {
  const claimed = new Set(nativeToolNames);
  return configured.flatMap((entry) =>
    (runtime.get(entry.id)?.running?.tools ?? []).filter((tool) => {
      if (claimed.has(tool.name)) return false;
      claimed.add(tool.name);
      return true;
    }),
  );
};

interface JsonRpcReply {
  readonly id?: string | number | undefined;
  readonly method?: string | undefined;
  readonly result?: unknown;
  readonly error?:
    | { readonly code?: number | undefined; readonly message?: string | undefined }
    | undefined;
}

const isJsonRpcReply = (value: unknown): value is JsonRpcReply =>
  typeof value === "object" && value !== null;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
/** A line that is not JSON is ignored: servers may log to stdout before they settle. */
const decodeJsonLine = (line: string) => Option.getOrUndefined(decodeJson(line.trim()));

/**
 * The child plus just enough JSON-RPC over stdio to initialize, list and call an MCP server.
 * T3 holds the handle, so a crash is visible here rather than only as a failed request.
 */
const connect = Effect.fn("ExternalMcpServers.connect")(function* (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
  launch: {
    readonly command: string;
    readonly args: ReadonlyArray<string>;
    readonly env: Readonly<Record<string, string>>;
    readonly cwd?: string | undefined;
  },
) {
  const child = yield* spawner
    .spawn(
      ChildProcess.make(launch.command, [...launch.args], {
        env: launch.env,
        extendEnv: true,
        ...(launch.cwd === undefined ? {} : { cwd: launch.cwd }),
        stdin: "pipe",
        stderr: "ignore",
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new ExternalMcpServerError({
            // The error's message quotes the command line, so only its reason (NotFound…) is kept.
            message: `Could not start ${launch.command} (${"reason" in cause ? String(cause.reason) : "unknown"}).`,
          }),
      ),
    );

  const replies = new Map<number, Deferred.Deferred<JsonRpcReply>>();
  const exited = yield* Deferred.make<string>();
  // Added first so it runs last: a stop that interrupts the exit watch still settles `exited`.
  yield* Effect.addFinalizer(() => Deferred.succeed(exited, `${launch.command} stopped.`));
  let nextId = 1;

  // One queued writer keeps stdin open for the child's lifetime. Ending the sink would close it.
  const input = yield* Queue.unbounded<string, Cause.Done>();
  yield* Stream.fromQueue(input).pipe(
    Stream.encodeText,
    Stream.run(child.stdin),
    Effect.ignore,
    Effect.forkScoped,
  );
  const write = (message: Readonly<Record<string, unknown>>) =>
    Queue.offer(input, `${JSON.stringify(message)}\n`).pipe(Effect.asVoid);

  // Untraced: one per JSON-RPC message, already inside the caller's span.
  const request = Effect.fnUntraced(function* (
    method: string,
    params: Readonly<Record<string, unknown>>,
  ) {
    const id = nextId++;
    const reply = yield* Deferred.make<JsonRpcReply>();
    replies.set(id, reply);
    yield* write({ jsonrpc: "2.0", id, method, params });
    return yield* Deferred.await(reply).pipe(
      Effect.ensuring(Effect.sync(() => replies.delete(id))),
      Effect.raceFirst(
        Deferred.await(exited).pipe(
          Effect.flatMap((message) => new ExternalMcpServerError({ message })),
        ),
      ),
    );
  });

  const settled = <A>(reply: JsonRpcReply, decode: (result: unknown) => A) =>
    reply.error === undefined
      ? Effect.try({
          try: () => decode(reply.result),
          catch: () =>
            new ExternalMcpServerError({ message: "The server returned an invalid result." }),
        })
      : Effect.fail(
          new ExternalMcpServerError({
            message: reply.error.message ?? `JSON-RPC error ${reply.error.code ?? "unknown"}`,
          }),
        );

  const decodeTool = (raw: unknown) =>
    McpSchema.Tool.make(raw as ConstructorParameters<typeof McpSchema.Tool>[0]);

  // Newline-delimited messages on stdout. A server can use our id for its own request, so only
  // a message without a method is a reply to ours; requests and notifications are answered here.
  yield* child.stdout.pipe(
    Stream.decodeText(),
    Stream.splitLines,
    Stream.runForEach((line) =>
      Effect.suspend(() => {
        const message = decodeJsonLine(line);
        if (!isJsonRpcReply(message) || message.id === undefined) return Effect.void;
        if (message.method !== undefined) {
          // T3 offers no client capabilities, so every request but `ping` is answered as unknown
          // rather than left to hang the server's call. Its id is whatever the server chose.
          return write(
            message.method === "ping"
              ? { jsonrpc: "2.0", id: message.id, result: {} }
              : {
                  jsonrpc: "2.0",
                  id: message.id,
                  error: { code: -32601, message: `Method not found: ${message.method}` },
                },
          );
        }
        // Only replies to T3's own requests are correlated, and T3 always uses numeric ids.
        const reply = typeof message.id === "number" ? replies.get(message.id) : undefined;
        if (reply === undefined) return Effect.void;
        Deferred.doneUnsafe(reply, Exit.succeed(message));
        return Effect.void;
      }),
    ),
    // A server that closes its output can answer nothing more, even if its process lingers.
    Effect.andThen(Deferred.succeed(exited, `${launch.command} closed its output.`)),
    Effect.forkScoped,
  );

  // Any exit is the crash signal; a signal termination fails `exitCode`, so both count. That
  // failure quotes the whole command line, which can carry a secret, so it is not passed on.
  yield* child.exitCode.pipe(
    Effect.matchEffect({
      onSuccess: (code) => Deferred.succeed(exited, `${launch.command} exited (${code}).`),
      onFailure: () => Deferred.succeed(exited, `${launch.command} was killed by a signal.`),
    }),
    Effect.forkScoped,
  );

  // Stopping closes stdin first, which ends a well-behaved server, then kills the handle.
  yield* Effect.addFinalizer(() =>
    Queue.end(input).pipe(
      Effect.andThen(child.kill({ killSignal: "SIGTERM", forceKillAfter: Duration.seconds(1) })),
      Effect.ignore,
    ),
  );

  const initialize = request("initialize", {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: "t3-code", version: "1" },
  });
  yield* initialize.pipe(
    Effect.flatMap((reply) => settled(reply, () => undefined)),
    Effect.mapError((cause) =>
      isExternalMcpServerError(cause)
        ? cause
        : new ExternalMcpServerError({ message: causeText(cause) }),
    ),
  );
  yield* write({ jsonrpc: "2.0", method: "notifications/initialized" });

  /** One `tools/list` page: its tools and the cursor for the next one, if the server has more. */
  const listToolsPage = (cursor: string | undefined) =>
    request("tools/list", cursor === undefined ? {} : { cursor }).pipe(
      Effect.flatMap((reply) =>
        settled(reply, (result) => {
          const page = result as
            | { readonly tools?: unknown; readonly nextCursor?: unknown }
            | undefined;
          const raw = page?.tools;
          if (!Array.isArray(raw)) throw new Error("missing tools");
          return {
            tools: raw.map(decodeTool),
            ...(typeof page?.nextCursor === "string" ? { nextCursor: page.nextCursor } : {}),
          };
        }),
      ),
      Effect.mapError((cause) =>
        isExternalMcpServerError(cause)
          ? cause
          : new ExternalMcpServerError({ message: causeText(cause) }),
      ),
    );

  // A paginated server lists a page at a time; the pages are appended in the order it gives them.
  const listTools = Effect.gen(function* () {
    const collected: Array<McpSchema.Tool> = [];
    let cursor: string | undefined;
    do {
      const page = yield* listToolsPage(cursor);
      collected.push(...page.tools);
      cursor = page.nextCursor;
    } while (cursor !== undefined);
    return collected;
  });

  const callTool = (toolName: string, args: Readonly<Record<string, unknown>>) =>
    request("tools/call", { name: toolName, arguments: args }).pipe(
      // Schema decoding converts wire base64 images, audio and blobs; `make` expects them already
      // decoded, so it rejects the child's raw content.
      Effect.flatMap((reply) => settled(reply, decodeCallToolResult)),
      Effect.mapError((cause) =>
        isExternalMcpServerError(cause)
          ? cause
          : new ExternalMcpServerError({ message: causeText(cause) }),
      ),
    );

  return { listTools, callTool, exited: Deferred.await(exited) };
});

const make = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  // A Reference: reading it falls back to its default, so nothing has to provide it.
  const host = {
    home: (yield* HostProcess.HomeDirectory) || HostProcess.HomeDirectory.defaultValue(),
    platform: yield* HostProcess.Platform,
  };
  // Every child scope hangs off this one, so service teardown stops children that never stopped.
  const serviceScope = yield* Effect.scope;

  const runtimeStates = yield* Ref.make<ReadonlyMap<string, ServerRuntimeState>>(new Map());
  const changes = yield* PubSub.unbounded<void>();
  const starts = yield* FiberMap.make<string>();

  const setState = (id: string, state: ServerRuntimeState) =>
    Ref.update(runtimeStates, (current) => new Map(current).set(id, state));

  const configuredEntries = settings.getSettings.pipe(
    Effect.map((current) => current.registeredMcpServers),
    Effect.orElseSucceed((): ReadonlyArray<RegisteredMcpServerEntry> => []),
  );

  const snapshot = Effect.gen(function* () {
    const configured = yield* configuredEntries;
    const runtime = yield* Ref.get(runtimeStates);
    const exposed = exposeTools(configured, runtime);
    return configured.map((entry): ExternalMcpServerState => ({
      name: entry.name,
      toolName: entry.toolName,
      enabled: entry.enabled,
      running: runtime.get(entry.id)?.running !== undefined,
      tools: exposed.flatMap((tool) => (tool.serverId === entry.id ? [tool.name] : [])),
    }));
  });

  const announce = PubSub.publish(changes, undefined);

  const stop = Effect.fn("ExternalMcpServers.stop")(function* (id: string) {
    const running = (yield* Ref.get(runtimeStates)).get(id)?.running;
    if (running === undefined) return;
    // Cleared first, so the child's exit from this stop is not taken for a crash.
    yield* setState(id, {});
    // Closing the child's scope closes its stdin, then kills it, and fails a waiting request.
    yield* Scope.close(running.scope, Exit.void);
    yield* Effect.logInfo("stopped registered MCP server", { server: running.entry.name });
  });

  const start = Effect.fn("ExternalMcpServers.start")(function* (entry: RegisteredMcpServerEntry) {
    const launch = launchOf(entry, host);
    if (!launch.ok) return yield* new ExternalMcpServerError({ message: launch.message });

    const scope = yield* Scope.fork(serviceScope, "sequential");
    // One deadline covers the handshake and every page of the listing. Until the child is
    // recorded as running, any way out, an interrupting reconcile included, closes its scope.
    const { connection, running } = yield* Effect.gen(function* () {
      const connection = yield* connect(spawner, launch.launch);
      return { connection, tools: yield* connection.listTools };
    }).pipe(
      Effect.timeoutOrElse({
        duration: START_TIMEOUT,
        orElse: () =>
          new ExternalMcpServerError({
            message: `${launch.launch.command} did not start in time.`,
          }),
      }),
      Effect.map(({ connection, tools }) => ({
        connection,
        running: {
          entry,
          tools: tools.map((descriptor) => ({
            serverId: entry.id,
            serverName: entry.name,
            originalName: descriptor.name,
            name: proxiedToolName(entry.toolName, descriptor.name),
            descriptor,
          })),
          call: connection.callTool,
          scope,
        } satisfies RunningServer,
      })),
      Effect.tap(({ running }) => setState(entry.id, { running })),
      Effect.provideService(Scope.Scope, scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    yield* Effect.logInfo("started registered MCP server", {
      server: entry.name,
      tools: running.tools.length,
    });

    // A child that exits on its own fails until a toggle or settings change restarts it. Forked
    // after the child's scope, so shutdown interrupts this first and logs no crash. A replacement
    // can start while cleanup yields, so the write re-checks that this child still owns the entry.
    yield* connection.exited.pipe(
      Effect.flatMap((message) =>
        Scope.close(scope, Exit.void).pipe(
          Effect.andThen(
            Ref.modify(runtimeStates, (states) =>
              states.get(entry.id)?.running?.scope === scope
                ? [true, new Map(states).set(entry.id, { failedEntry: entry })]
                : [false, states],
            ),
          ),
          Effect.flatMap((recorded) =>
            recorded
              ? Effect.logWarning("registered MCP server stopped unexpectedly", {
                  server: entry.name,
                  detail: message,
                })
              : Effect.void,
          ),
          Effect.andThen(announce),
        ),
      ),
      Effect.forkIn(serviceScope),
    );
  });

  // A start runs on its own fiber, so a slow first download never delays stopping another server.
  const forkStart = (entry: RegisteredMcpServerEntry) =>
    setState(entry.id, { starting: entry }).pipe(
      Effect.andThen(
        FiberMap.run(
          starts,
          entry.id,
          start(entry).pipe(
            // A start interrupted by a later reconcile is not a failure; that reconcile replaced it.
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (cause) =>
                setState(entry.id, { failedEntry: entry }).pipe(
                  Effect.andThen(
                    Effect.logWarning("registered MCP server failed to start", {
                      server: entry.name,
                      detail: causeText(cause),
                    }),
                  ),
                ),
            ),
            Effect.ensuring(announce),
          ),
        ),
      ),
    );

  /** Each settings value in turn, so an off-and-on pair is seen as such and retries a failure. */
  const reconcile = Effect.fn("ExternalMcpServers.reconcile")(function* (next: {
    readonly registeredMcpServers: ReadonlyArray<RegisteredMcpServerEntry>;
  }) {
    const desiredById = new Map(next.registeredMcpServers.map((entry) => [entry.id, entry]));
    let stopped = false;
    for (const [id, state] of yield* Ref.get(runtimeStates)) {
      const entry = desiredById.get(id);
      const current = state.running?.entry ?? state.starting;
      const removed = entry === undefined || !entry.enabled;
      if (!removed && (current === undefined || sameEntry(entry, current))) continue;
      yield* FiberMap.remove(starts, id);
      yield* stop(id);
      yield* Ref.update(runtimeStates, (states) => {
        const remaining = new Map(states);
        remaining.delete(id);
        return remaining;
      });
      stopped = true;
    }

    const states = yield* Ref.get(runtimeStates);
    const toStart = next.registeredMcpServers.filter((entry) => {
      const state = states.get(entry.id);
      // A failed server retries only once its entry changes, or after it is turned off and on.
      return (
        entry.enabled &&
        state?.running === undefined &&
        state?.starting === undefined &&
        (state?.failedEntry === undefined || !sameEntry(state.failedEntry, entry))
      );
    });
    yield* Effect.forEach(toStart, forkStart, { discard: true });
    // Each start announces itself when it settles.
    if (stopped || toStart.length === 0) yield* announce;
  });

  return ExternalMcpServers.of({
    start: Effect.scoped(
      Effect.gen(function* () {
        const settingsChanges = yield* settings.subscribeChanges;
        yield* reconcile(
          yield* configuredEntries.pipe(
            Effect.map((entries) => ({ registeredMcpServers: entries })),
          ),
        );
        yield* settingsChanges.pipe(Stream.tap(reconcile), Stream.runDrain);
        return yield* Effect.never;
      }),
    ).pipe(Effect.orDie),
    states: snapshot,
    tools: Effect.zipWith(configuredEntries, Ref.get(runtimeStates), exposeTools),
    callTool: Effect.fn("ExternalMcpServers.callTool")(function* (tool, args) {
      const running = (yield* Ref.get(runtimeStates)).get(tool.serverId)?.running;
      if (running === undefined) {
        return yield* new ExternalMcpServerError({
          message: `${tool.serverName} is not running. Enable it in Settings → Capabilities.`,
        });
      }
      const result = yield* running.call(tool.originalName, args);
      return {
        content: result.content,
        structuredContent: result.structuredContent,
        isError: result.isError === true,
      } satisfies ExternalMcpToolResult;
    }),
    changes: Stream.fromPubSub(changes),
  });
});

export const layer: Layer.Layer<
  ExternalMcpServers,
  never,
  ServerSettings.ServerSettingsService | ChildProcessSpawner.ChildProcessSpawner
> = Layer.effect(ExternalMcpServers, make);

/** Starts the reconciler for the scope's lifetime, over an already built service. */
export const layerReconciler: Layer.Layer<never, never, ExternalMcpServers> = Layer.effectDiscard(
  ExternalMcpServers.pipe(
    Effect.flatMap((servers) => Effect.forkScoped(servers.start)),
    Effect.asVoid,
  ),
);
