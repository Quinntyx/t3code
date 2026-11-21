import {
  decodeMcpConfigValue,
  parseMcpRegistration,
  resolveMcpLaunch,
  type McpConfigValue,
} from "@t3tools/shared/mcpRegistration";
import * as HostProcess from "@t3tools/shared/HostProcess";
import {
  type RegisteredMcpServerEntry,
  type RegisteredMcpServerState,
  type RegisteredMcpServersState,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Schema from "effect/Schema";

import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import { McpSchema } from "effect/ai";

import * as ServerSettings from "../serverSettings.ts";
import { SECRET_REDACTED } from "../settingsSecrets.ts";
import { nativeToolNames } from "./nativeToolNames.ts";

const START_TIMEOUT = Duration.seconds(30);
const CALL_TIMEOUT = Duration.seconds(60);
/** Enough stderr to explain a failure without holding a chatty server's whole output. */
const STDERR_TAIL_BYTES = 2_000;
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
  readonly redact: (text: string) => string;
  readonly scope: Scope.Closeable;
}

interface ServerRuntimeState {
  readonly status: RegisteredMcpServerState["status"];
  readonly stderrTail?: string | undefined;
  readonly running?: RunningServer | undefined;
  /** What last failed, so an edited entry starts again and an unchanged one does not. */
  readonly failedEntry?: RegisteredMcpServerEntry | undefined;
}

/**
 * The local MCP servers a user registered in Settings → Capabilities. T3 owns their processes:
 * each runs while its entry is enabled, restarts when its settings change, stops when it is
 * disabled, and records why it failed when it exits. Their tools are proxied into T3's MCP server.
 */
export class ExternalMcpServers extends Context.Service<
  ExternalMcpServers,
  {
    /** Reconciles once, then on every settings change, for the layer's lifetime. */
    readonly start: Effect.Effect<never>;
    readonly states: Effect.Effect<RegisteredMcpServersState>;
    readonly tools: Effect.Effect<ReadonlyArray<ExternalMcpTool>>;
    readonly callTool: (
      tool: ExternalMcpTool,
      args: Readonly<Record<string, unknown>>,
    ) => Effect.Effect<ExternalMcpToolResult, ExternalMcpServerError>;
    /** Emits the current state after each change, including a crash. */
    readonly changes: Stream.Stream<RegisteredMcpServersState>;
  }
>()("t3/mcp/ExternalMcpServers") {}

/** A start, call or crash failure with a message a tool result or status page can show. */
export class ExternalMcpServerError extends Schema.TaggedError<ExternalMcpServerError>()(
  "ExternalMcpServerError",
  { message: Schema.String },
) {}

const stderrTailOf = (text: string) => {
  const trimmed = text.trim();
  return trimmed.length > STDERR_TAIL_BYTES ? `…${trimmed.slice(-STDERR_TAIL_BYTES)}` : trimmed;
};

const isExternalMcpServerError = Schema.is(ExternalMcpServerError);

/** Anything an entry declares secret can reappear in a child's stderr or a JSON-RPC error. */
const redactorFor = (entry: RegisteredMcpServerEntry) => {
  const parsed = parseMcpRegistration(
    entry.source.kind === "server.json" ? entry.source.document : entry.source.manifest,
  );
  const values = parsed.ok
    ? parsed.registration.fields.flatMap((field) => {
        if (!field.secret) return [];
        const raw = entry.config[field.key];
        if (raw === undefined) return [];
        const value = typeof raw === "string" ? decodeMcpConfigValue(raw) : raw;
        const parts = Array.isArray(value) ? value : [value];
        return [...parts, ...(Array.isArray(value) ? [value.join(","), JSON.stringify(value)] : [])]
          .map(String)
          .filter((part) => part !== "");
      })
    : [];
  const secrets = [...new Set(values)].sort((left, right) => right.length - left.length);
  return (text: string) =>
    secrets.reduce((redacted, secret) => redacted.replaceAll(secret, SECRET_REDACTED), text);
};

const causeText = (cause: Cause.Cause<unknown>): string => {
  const error = Cause.squash(cause);
  return isExternalMcpServerError(error)
    ? error.message
    : error instanceof Error
      ? error.message
      : stderrTailOf(Cause.pretty(cause));
};

const launchOf = (entry: RegisteredMcpServerEntry, home: string, platform: string) =>
  resolveMcpLaunch(
    { source: entry.source, config: entry.config as Readonly<Record<string, McpConfigValue>> },
    { home, platform },
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

/** T3 and a server both accept letters, digits, `_` and `-`; anything else in a tool name becomes `_`. */
const proxiedToolName = (prefix: string, toolName: string) =>
  `${prefix}_${toolName.replaceAll(/[^a-zA-Z0-9_-]/gu, "_").slice(0, 60)}`;

interface ExposedTools {
  readonly tools: ReadonlyArray<ExternalMcpTool>;
  readonly byServer: ReadonlyMap<
    string,
    { readonly tools: ReadonlyArray<ExternalMcpTool>; readonly skipped: ReadonlyArray<string> }
  >;
}

/** Decides every emitted name once: native tools first, then servers in settings order. */
const exposeTools = (
  configured: ReadonlyArray<RegisteredMcpServerEntry>,
  runtime: ReadonlyMap<string, ServerRuntimeState>,
): ExposedTools => {
  const claimed = new Set(nativeToolNames);
  const byServer = new Map<string, { tools: Array<ExternalMcpTool>; skipped: Array<string> }>();
  const tools: Array<ExternalMcpTool> = [];
  for (const entry of configured) {
    const running = runtime.get(entry.id)?.running;
    if (running === undefined) continue;
    const exposed = { tools: [] as Array<ExternalMcpTool>, skipped: [] as Array<string> };
    byServer.set(entry.id, exposed);
    for (const tool of running.tools) {
      if (claimed.has(tool.name)) {
        exposed.skipped.push(`as ${tool.name}, which another tool uses`);
        continue;
      }
      claimed.add(tool.name);
      exposed.tools.push(tool);
      tools.push(tool);
    }
  }
  return { tools, byServer };
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
  },
  redact: (text: string) => string,
) {
  const child = yield* spawner
    .spawn(
      ChildProcess.make(launch.command, [...launch.args], {
        env: launch.env,
        extendEnv: true,
        stdin: "pipe",
      }),
    )
    .pipe(
      Effect.mapError(
        (cause) =>
          new ExternalMcpServerError({
            message: redact(
              `Could not start ${launch.command}: ${cause instanceof Error ? cause.message : String(cause)}`,
            ),
          }),
      ),
    );

  const replies = new Map<number, Deferred.Deferred<JsonRpcReply>>();
  const stderrTail = yield* Ref.make("");
  const exited = yield* Deferred.make<string>();
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
            message: redact(
              reply.error.message ?? `JSON-RPC error ${reply.error.code ?? "unknown"}`,
            ),
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
          // `ping` is the one request a server sends us; its id is whatever the server chose.
          return message.method === "ping"
            ? write({ jsonrpc: "2.0", id: message.id, result: {} })
            : Effect.void;
        }
        // Only replies to T3's own requests are correlated, and T3 always uses numeric ids.
        const reply = typeof message.id === "number" ? replies.get(message.id) : undefined;
        if (reply === undefined) return Effect.void;
        Deferred.doneUnsafe(reply, Exit.succeed(message));
        return Effect.void;
      }),
    ),
    Effect.forkScoped,
  );

  // Keep the end of stderr for a crash report.
  yield* child.stderr.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) => Ref.update(stderrTail, (text) => stderrTailOf(`${text}${chunk}`))),
    Effect.forkScoped,
  );

  // Any exit is the crash signal; a signal termination fails `exitCode`, so both count. Requests
  // still waiting fail with the stderr tail.
  const recordExit = (detail: string) =>
    Ref.get(stderrTail).pipe(
      Effect.flatMap((tail) =>
        Deferred.succeed(exited, redact(`${launch.command} ${detail}. ${tail}`.trim())),
      ),
    );
  yield* child.exitCode.pipe(
    Effect.matchCauseEffect({
      onSuccess: (code) => recordExit(`exited (${code})`),
      onFailure: (cause) => recordExit(`stopped (${causeText(cause)})`),
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
  }).pipe(
    Effect.timeoutOrElse({
      duration: START_TIMEOUT,
      orElse: () =>
        Ref.get(stderrTail).pipe(
          Effect.flatMap(
            (tail) =>
              new ExternalMcpServerError({
                message: redact(`${launch.command} did not answer initialize. ${tail}`.trim()),
              }),
          ),
        ),
    }),
  );
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
      Effect.timeoutOrElse({
        duration: START_TIMEOUT,
        orElse: () =>
          new ExternalMcpServerError({
            message: redact(`${launch.command} did not list its tools in time.`),
          }),
      }),
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
      Effect.timeoutOrElse({
        duration: CALL_TIMEOUT,
        orElse: () =>
          new ExternalMcpServerError({
            message: redact(`${launch.command} did not finish the call in time.`),
          }),
      }),
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
  const home = (yield* HostProcess.HomeDirectory) || HostProcess.HomeDirectory.defaultValue();
  const platform = yield* HostProcess.Platform;
  // Every child scope hangs off this one, so service teardown stops children that never stopped.
  const serviceScope = yield* Effect.scope;

  const runtimeStates = yield* Ref.make<ReadonlyMap<string, ServerRuntimeState>>(new Map());
  const changes = yield* PubSub.unbounded<RegisteredMcpServersState>();
  // One reconcile at a time: a settings change and a crash must not start or stop the same child.
  const reconcileLock = yield* Semaphore.make(1);

  const setState = (id: string, state: ServerRuntimeState) =>
    Ref.update(runtimeStates, (current) => new Map(current).set(id, state));

  const exposureOf = Effect.gen(function* () {
    const configured = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
    return exposeTools(configured?.registeredMcpServers ?? [], yield* Ref.get(runtimeStates));
  });

  const snapshot = Effect.fn("ExternalMcpServers.states")(function* () {
    const configured = yield* settings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
    const runtime = yield* Ref.get(runtimeStates);
    const exposure = exposeTools(configured?.registeredMcpServers ?? [], runtime);
    const servers = (configured?.registeredMcpServers ?? []).map((entry) => {
      const state = runtime.get(entry.id);
      const stderrTail = state?.stderrTail && redactorFor(entry)(state.stderrTail);
      const skipped = exposure.byServer.get(entry.id)?.skipped;
      return {
        id: entry.id,
        name: entry.name,
        toolName: entry.toolName,
        enabled: entry.enabled,
        status: state?.status ?? "stopped",
        ...(stderrTail === undefined || stderrTail === "" ? {} : { stderrTail }),
        tools: (exposure.byServer.get(entry.id)?.tools ?? []).map((tool) => tool.name),
        ...(skipped === undefined || skipped.length === 0 ? {} : { skippedTools: skipped }),
      } satisfies RegisteredMcpServerState;
    });
    return { servers } satisfies RegisteredMcpServersState;
  });

  // A subscriber sees every change; the state itself says what changed.
  const announce = snapshot().pipe(Effect.flatMap((state) => PubSub.publish(changes, state)));

  const stop = Effect.fn("ExternalMcpServers.stop")(function* (id: string) {
    const state = (yield* Ref.get(runtimeStates)).get(id);
    if (state?.running === undefined) return false;
    // Cleared first, so the child's exit from this stop is not taken for a crash.
    yield* setState(id, { status: "stopped" });
    // Closing the child's scope closes its stdin, then kills it, and fails a waiting request.
    yield* Scope.close(state.running.scope, Exit.void);
    yield* Effect.logInfo("stopped registered MCP server", { server: state.running.entry.name });
    return true;
  });

  const start = Effect.fn("ExternalMcpServers.start")(function* (entry: RegisteredMcpServerEntry) {
    yield* setState(entry.id, { status: "starting" });
    const redact = redactorFor(entry);
    const launch = launchOf(entry, home, platform);
    if (!launch.ok) return yield* new ExternalMcpServerError({ message: redact(launch.message) });

    const scope = yield* Scope.fork(serviceScope, "sequential");
    // The child's scope closes on every way out before the child is recorded as running.
    const connection = yield* connect(spawner, launch.launch, redact).pipe(
      Effect.provideService(Scope.Scope, scope),
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    const tools = yield* connection.listTools.pipe(
      Effect.onError(() => Scope.close(scope, Exit.void)),
    );
    const running: RunningServer = {
      entry,
      tools: tools.map((descriptor) => ({
        serverId: entry.id,
        serverName: entry.name,
        originalName: descriptor.name,
        name: proxiedToolName(entry.toolName, descriptor.name),
        descriptor,
      })),
      call: connection.callTool,
      redact,
      scope,
    };
    yield* setState(entry.id, { status: "running", running });
    yield* announce;
    yield* Effect.logInfo("started registered MCP server", {
      server: entry.name,
      tools: running.tools.length,
    });

    // A child that exits on its own is a failure until a toggle or settings change restarts it.
    // Detached so it outlives the start scope, which closes when the server is stopped. Cleanup
    // yields, so a settings change can start a replacement meanwhile; the write re-checks that this
    // child still owns the entry, or it would report the replacement failed and withdraw its tools.
    yield* connection.exited.pipe(
      Effect.flatMap((message) =>
        Scope.close(scope, Exit.void).pipe(
          Effect.andThen(
            Ref.modify(runtimeStates, (states) =>
              states.get(entry.id)?.running?.scope === scope
                ? [
                    true,
                    new Map(states).set(entry.id, {
                      status: "failed",
                      stderrTail: stderrTailOf(message),
                      failedEntry: entry,
                    } satisfies ServerRuntimeState),
                  ]
                : [false, states],
            ),
          ),
          Effect.flatMap((recorded) =>
            recorded
              ? Effect.logWarning("registered MCP server stopped unexpectedly", {
                  server: entry.name,
                  detail: stderrTailOf(message),
                }).pipe(Effect.andThen(announce))
              : Effect.void,
          ),
        ),
      ),
      Effect.forkDetach,
    );
  });

  const reconcile = Effect.gen(function* () {
    const next = yield* settings.getSettings.pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("could not read settings for registered MCP servers", { cause }).pipe(
          Effect.as(undefined),
        ),
      ),
    );
    if (next === undefined) return;
    const desired = next.registeredMcpServers;
    const desiredById = new Map(desired.map((entry) => [entry.id, entry]));
    let changed = false;

    for (const [id, state] of yield* Ref.get(runtimeStates)) {
      const entry = desiredById.get(id);
      const running = state.running;
      if (running === undefined) {
        if (state.status === "failed" && (entry === undefined || !entry.enabled)) {
          yield* setState(id, { status: "stopped" });
          changed = true;
        }
        continue;
      }
      const unchanged =
        entry !== undefined &&
        entry.enabled &&
        entry.toolName === running.entry.toolName &&
        sameJson(entry.config, running.entry.config) &&
        sameJson(entry.source, running.entry.source);
      if (unchanged) continue;
      if (yield* stop(id)) changed = true;
    }

    for (const entry of desired) {
      const state = (yield* Ref.get(runtimeStates)).get(entry.id);
      if (state?.running !== undefined) continue;
      if (!entry.enabled) {
        if (state?.status !== "failed" && state?.status !== "stopped") {
          yield* setState(entry.id, { status: "stopped" });
          changed = true;
        }
        continue;
      }
      // A failed server retries only once its entry changes; unchanged, it never retries itself.
      if (state?.status === "failed") {
        if (state.failedEntry === undefined || sameEntry(state.failedEntry, entry)) continue;
      }
      yield* start(entry).pipe(
        Effect.catchCause((cause) =>
          setState(entry.id, {
            status: "failed",
            stderrTail: redactorFor(entry)(causeText(cause)),
            failedEntry: entry,
          }).pipe(Effect.andThen(announce)),
        ),
      );
      changed = true;
    }

    for (const id of (yield* Ref.get(runtimeStates)).keys()) {
      if (desiredById.has(id)) continue;
      yield* Ref.update(runtimeStates, (states) => {
        const nextStates = new Map(states);
        nextStates.delete(id);
        return nextStates;
      });
      changed = true;
    }
    if (changed) yield* announce;
  }).pipe(reconcileLock.withPermits(1));

  return ExternalMcpServers.of({
    start: Effect.scoped(
      Effect.gen(function* () {
        const settingsChanges = yield* settings.subscribeChanges;
        yield* reconcile;
        yield* settingsChanges.pipe(
          Stream.tap(() => reconcile),
          Stream.runDrain,
        );
        return yield* Effect.never;
      }),
    ).pipe(Effect.orDie),
    // `reconcile` already holds the lock, so re-acquiring it here would deadlock.
    states: reconcile.pipe(Effect.andThen(snapshot())),
    tools: exposureOf.pipe(Effect.map((exposure) => exposure.tools)),
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
