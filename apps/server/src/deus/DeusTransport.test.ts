import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { expect, it } from "@effect/vitest";
import {
  AuthStandardClientScopes,
  clientRpcRequiredScopes,
  DEFAULT_SERVER_SETTINGS,
  DeusInputId,
  DeusMemoryId,
  DeusRpcGroup,
  EnvironmentId,
  ProjectId,
  RpcScopeAuthorization,
  SecretRef,
  WS_METHODS,
  WsSubscribeServerConfigRpc,
  WsRpcGroup,
  type ServerConfig,
  type AuthEnvironmentScope,
  type DeusSubscriptionInput,
  type DeusSubscriptionEvent,
} from "@t3tools/contracts";
import { deusJson } from "@t3tools/shared/deusMediaWire";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as Clock from "effect/Clock";
import * as HttpServer from "effect/http/HttpServer";
import * as HttpServerRequest from "effect/http/HttpServerRequest";
import * as NetAddress from "effect/net/NetAddress";
import * as SqlClient from "effect/sql/SqlClient";
import { RpcGroup, RpcServer, RpcSerialization } from "effect/rpc";
import * as Socket from "effect/socket/Socket";
import { NodeWS } from "@effect/platform-node/NodeSocket";
import * as ClientSession from "../../../../packages/client-runtime/src/rpc/session.ts";
import * as ClientRpc from "../../../../packages/client-runtime/src/rpc/client.ts";
import * as ClientMedia from "../../../../packages/client-runtime/src/rpc/deusMedia.ts";
import { deusMetadata } from "../../../../packages/client-runtime/src/rpc/deus.ts";
import { LiveServerMessage } from "@google/genai";
import * as Supervisor from "../../../../packages/client-runtime/src/connection/supervisor.ts";
import * as Driver from "../../../../packages/client-runtime/src/connection/driver.ts";
import * as Connectivity from "../../../../packages/client-runtime/src/connection/connectivity.ts";
import * as Wakeups from "../../../../packages/client-runtime/src/connection/wakeups.ts";
import {
  PrimaryConnectionTarget,
  RelayConnectionTarget,
  type PreparedConnection,
} from "../../../../packages/client-runtime/src/connection/model.ts";
import * as Auth from "../auth/EnvironmentAuth.ts";
import * as AuthSessions from "../auth/SessionStore.ts";
import * as Authorization from "../auth/RpcAuthorization.ts";
import * as Secrets from "../auth/ServerSecretStore.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as Config from "../config.ts";
import * as Settings from "../serverSettings.ts";
import * as Identity from "../environment/ServerEnvironment.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as Events from "../persistence/OrchestrationEventStore.ts";
import * as Receipts from "../orchestration-v2/CommandReceiptStore.ts";
import * as Threads from "../orchestration-v2/ThreadManagementService.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Providers from "../provider/testUtils/providerRegistryMock.ts";
import * as Repository from "./DeusRepository.ts";
import * as Sessions from "./DeusSessionService.ts";
import * as Authority from "./DeusAuthority.ts";
import * as Human from "./DeusHumanAuthority.ts";
import * as Lease from "./DeusMediaLease.ts";
import * as Configuration from "./DeusConfiguration.ts";
import * as Working from "./DeusContextService.ts";
import * as Memory from "./DeusMemoryService.ts";
import * as Bridge from "./DeusThreadBridge.ts";
import * as Tools from "./DeusTools.ts";
import * as Coordinator from "./DeusCoordinator.ts";
import * as Text from "./GeminiTextAdapter.ts";
import * as Adapter from "./GeminiLiveAdapter.ts";
import * as Live from "./DeusLiveService.ts";
import * as Transport from "./DeusTransport.ts";

const environmentId = EnvironmentId.make("transport-fixture");
const projectId = ProjectId.make("transport-project");
const authority = {
  runtimeMode: "approval-required",
  interactionMode: "plan",
  allowWorktree: false,
} as const;
const probe = WsRpcGroup.requests.get(WS_METHODS.serverProbe);
if (!probe || probe._tag !== WS_METHODS.serverProbe) throw new Error("Missing server probe RPC");
const group = DeusRpcGroup.merge(RpcGroup.make(WsSubscribeServerConfigRpc, probe)).middleware(
  RpcScopeAuthorization,
);
const base = Layer.mergeAll(
  Auth.layer,
  Settings.layer,
  Repository.layer,
  Events.layer,
  Receipts.layer,
).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
  Layer.provideMerge(Secrets.layer),
  Layer.provideMerge(
    Layer.succeed(Identity.ServerEnvironmentIdentity, {
      getEnvironmentId: Effect.succeed(environmentId),
    }),
  ),
  Layer.provideMerge(Config.layerTest(process.cwd(), { prefix: "deus-transport-test-" })),
  Layer.provideMerge(NodeServices.layer),
);
const fixture = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES (${projectId},'Transport fixture','/test/transport','[]','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`;
  const incoming = yield* Queue.unbounded<Adapter.LiveEvent>();
  const opened = yield* Queue.unbounded<void>();
  const realtime = yield* Queue.unbounded<void>();
  const stopped = yield* Queue.unbounded<void>();
  const ready = yield* Deferred.make<void>();
  const sendGate = yield* Deferred.make<void>();
  let neverReady = false;
  let textCalls = 0;
  let openedCount = 0;
  const human = Human.layer;
  const leases = Lease.layer.pipe(Layer.provideMerge(human));
  const grants = Layer.effect(
    Authority.DeusAuthority,
    Effect.map(Lease.DeusMediaLease, (service) => ({ authorize: service.authorize })),
  ).pipe(Layer.provideMerge(leases));
  const liveAuthority = Layer.effect(
    Live.DeusLiveAuthority,
    Effect.map(Lease.DeusMediaLease, (service) => ({
      validate: (attachment) =>
        service
          .validate(attachment)
          .pipe(
            Effect.mapError(
              () =>
                new Adapter.DeusLiveError({ code: "authority", message: "Fixture lease ended" }),
            ),
          ),
    })),
  );
  const dependencies = Layer.mergeAll(
    grants,
    Sessions.layer,
    Configuration.layer,
    Memory.layer.pipe(Layer.provide(Git.layer)),
    SecretRequests.layer.pipe(Layer.provide(Layer.mock(Threads.ThreadManagementService)({}))),
    Layer.mock(Bridge.DeusThreadBridge)({}),
    Layer.mock(Threads.ThreadManagementService)({}),
    Providers.layer([]),
    Layer.succeed(Text.GeminiTextAdapter, {
      generate: () =>
        Effect.sync(() => {
          textCalls++;
          return { parts: [{ text: "A scripted answer without a microphone." }] };
        }),
    }),
    Layer.succeed(Adapter.GeminiLiveAdapter, {
      connect: () =>
        Effect.gen(function* () {
          openedCount++;
          yield* Queue.offer(opened, undefined);
          if (neverReady) yield* Deferred.await(ready);
          return {
            events: incoming,
            respond: () => Effect.void,
            context: () => Effect.void,
            realtime: (input: Parameters<Adapter.LiveConnection["realtime"]>[0]) =>
              input.audio
                ? Queue.offer(realtime, undefined).pipe(Effect.andThen(Deferred.await(sendGate)))
                : Effect.void,
            close: Queue.offer(stopped, undefined).pipe(Effect.asVoid),
          };
        }).pipe(Effect.onInterrupt(() => Queue.offer(stopped, undefined))),
    }),
  );
  const services = yield* Layer.build(
    Transport.layer.pipe(
      Layer.provideMerge(Layer.merge(Coordinator.layer, Live.layer)),
      Layer.provide(liveAuthority),
      Layer.provideMerge(Tools.layer),
      Layer.provideMerge(Working.layer),
      Layer.provideMerge(dependencies),
    ),
  );
  const transport = Context.get(services, Transport.DeusTransport);
  const configuration = Context.get(services, Configuration.DeusConfiguration);
  const sessions = Context.get(services, Sessions.DeusSessionService);
  const store = yield* Secrets.ServerSecretStore;
  const ref = SecretRef.make(`secret-ref:${"b".repeat(32)}`);
  const synthetic = "synthetic-local-intake-only-not-an-api-credential";
  yield* store.set(
    `secret-request-${"b".repeat(32)}`,
    new TextEncoder().encode(
      JSON.stringify({ projectId, value: synthetic, savedAt: yield* Clock.currentTimeMillis }),
    ),
  );
  yield* configuration.setCredential({ secretRef: ref, projectId }).pipe(Effect.provide(services));
  yield* configuration.update({
    enabled: true,
    textModel: "scripted-text",
    liveModel: "scripted-live",
    voice: "scripted-voice",
  });
  const auth = yield* Auth.EnvironmentAuth;
  const authSessions = yield* AuthSessions.SessionStore;
  const issued = yield* authSessions.issue({
    subject: "human",
    method: "bearer-access-token",
    scopes: AuthStandardClientScopes,
  });
  const principal = yield* auth.authenticateWebSocketUpgrade(
    HttpServerRequest.fromWeb(
      new Request("http://fixture.invalid/ws", {
        headers: { Authorization: `Bearer ${issued.token}` },
      }),
    ),
    "rpc",
  );
  const snapshot = yield* sessions.open({
    environmentId,
    projectId,
    inputId: DeusInputId.make("open"),
  });
  return {
    sql,
    services,
    transport,
    sessions,
    auth,
    authSessions,
    issued,
    principal,
    snapshot,
    incoming,
    opened,
    realtime,
    stopped,
    sendGate,
    synthetic,
    textCalls: () => textCalls,
    openedCount: () => openedCount,
    holdSetup: () => {
      neverReady = true;
    },
  };
});

it.effect("takeover fails a pending old attach instead of leaving its RPC waiting forever", () =>
  Effect.gen(function* () {
    const h = yield* fixture;
    h.holdSetup();
    const first = yield* h.transport.connect(h.principal);
    const second = yield* h.transport.connect(h.principal);
    const input = {
      ...h.snapshot.session,
      inputId: DeusInputId.make("pending-first"),
      takeover: false,
      authority,
    };
    const old = yield* first[WS_METHODS.deusAttach](input).pipe(Effect.forkScoped);
    yield* Queue.take(h.opened);
    const replacement = yield* second[WS_METHODS.deusAttach]({
      ...input,
      inputId: DeusInputId.make("pending-takeover"),
      takeover: true,
    }).pipe(Effect.forkScoped);
    yield* Queue.take(h.opened);
    const result = yield* Fiber.await(old);
    expect(Exit.isFailure(result)).toBe(true);
    yield* Fiber.interrupt(replacement);
  }).pipe(Effect.provide(base), Effect.scoped),
);

const serve = Effect.fn("DeusTransport.test.serve")(function* (h: Effect.Success<typeof fixture>) {
  const server = yield* HttpServer.HttpServer;
  yield* server.serve(
    Effect.gen(function* () {
      const request = yield* HttpServerRequest.HttpServerRequest;
      yield* Effect.logInfo("wire fixture incoming upgrade");
      const principal = yield* h.auth.authenticateWebSocketUpgrade(request, "rpc");
      const handlers = yield* h.transport.connect(principal);
      const config: ServerConfig = {
        environment: {
          environmentId,
          label: "Fixture",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0-test",
          capabilities: { repositoryIdentity: true },
        },
        auth: {
          policy: "loopback-browser",
          bootstrapMethods: ["one-time-token"],
          sessionMethods: ["browser-session-cookie", "bearer-access-token"],
          sessionCookieName: "fixture",
        },
        cwd: "/test/transport",
        keybindingsConfigPath: "/test/keybindings.json",
        keybindings: [],
        issues: [],
        providers: [],
        availableEditors: [],
        observability: {
          logsDirectoryPath: "/test/logs",
          localTracingEnabled: false,
          otlpTracesEnabled: false,
          otlpMetricsEnabled: false,
          otlpLogsEnabled: false,
        },
        settings: DEFAULT_SERVER_SETTINGS,
        deus: yield* h.transport.capabilities,
      };
      const { protocol, httpEffect } = yield* RpcServer.makeProtocolWithHttpEffectWebsocket;
      yield* RpcServer.make(group, { disableTracing: true, disableFatalDefects: true }).pipe(
        Effect.provideService(RpcServer.Protocol, protocol),
        Effect.provide(
          Layer.mergeAll(
            group.toLayer({
              ...handlers,
              [WS_METHODS.serverProbe]: () => Effect.succeed({}),
              [WS_METHODS.subscribeServerConfig]: () =>
                Stream.concat(
                  Stream.succeed({ version: 1 as const, type: "snapshot" as const, config }),
                  Stream.never,
                ),
            }),
            Authorization.layer(principal.scopes),
          ),
        ),
        Effect.forkScoped,
      );
      return yield* httpEffect;
    }).pipe(
      Effect.tapCause((cause) => Effect.logError("wire fixture server failure", cause)),
      Effect.provideService(RpcSerialization.RpcSerialization, deusJson),
    ),
  );
  if (!NetAddress.isInetAddress(server.address))
    return yield* Effect.die("Expected a loopback test server");
  return `ws://127.0.0.1:${server.address.port}/ws`;
});

const connect = Effect.fn("DeusTransport.test.connect")(function* (
  url: string,
  token: string,
  route: "direct" | "relay" | "tunnel",
  scopes: ReadonlyArray<AuthEnvironmentScope> = AuthStandardClientScopes,
) {
  const frames: string[] = [];
  const receivedFrames: string[] = [];
  let corrupt: ((frame: Record<string, unknown>) => unknown) | undefined;
  const construct: Socket.WebSocketConstructor["Service"] = (address) => {
    const socket = new NodeWS.WebSocket(address, { headers: { Authorization: `Bearer ${token}` } });
    socket.on("message", (data) => receivedFrames.push(data.toString()));
    const send = socket.send.bind(socket);
    Object.defineProperty(socket, "send", {
      value: (data: Parameters<typeof socket.send>[0]) => {
        if (typeof data === "string") {
          frames.push(data);
          const frame: Record<string, unknown> = JSON.parse(data);
          if (corrupt && frame.tag === WS_METHODS.deusMediaPush) {
            const change = corrupt;
            corrupt = undefined;
            return send(JSON.stringify(change(frame)));
          }
        }
        return send(data);
      },
    });
    return socket;
  };
  const factory = yield* ClientSession.make().pipe(
    Effect.provideService(Socket.WebSocketConstructor, construct),
  );
  const target =
    route === "relay"
      ? new RelayConnectionTarget({ environmentId, label: "Fixture relay" })
      : new PrimaryConnectionTarget({
          environmentId,
          label: `Fixture ${route}`,
          httpBaseUrl: url.replace("ws:", "http:"),
          wsBaseUrl: url,
        });
  const entry = { target, profile: Option.none(), enabled: true };
  const driver = Driver.ConnectionDriver.of({
    checkRoute: () => Effect.succeed("answered"),
    preflight: () => Effect.succeed(true),
    checkHost: () => Effect.succeed("answered"),
    connect: (selected, progress) =>
      Driver.connectOverRoutes(
        selected,
        () => Effect.succeed("answered"),
        (selectedRoute) =>
          Effect.gen(function* () {
            const prepared: PreparedConnection = {
              environmentId,
              label: target.label,
              httpBaseUrl: url.replace("ws:", "http:"),
              socketUrl: url,
              httpAuthorization: null,
              target: selectedRoute.target,
            };
            yield* progress({ stage: "opening", prepared });
            const session = yield* factory.connect(prepared);
            yield* progress({ stage: "synchronizing", prepared });
            yield* session.ready.pipe(
              Effect.tapCause((cause) => Effect.logError("wire fixture ready failure", cause)),
            );
            return { prepared, session };
          }),
      ),
  });
  const supervisor = yield* Supervisor.make(entry, { initiallyDesired: true }).pipe(
    Effect.provideService(Driver.ConnectionDriver, driver),
    Effect.provideService(Connectivity.Connectivity, {
      status: Effect.succeed("online" as const),
      changes: Stream.never,
    }),
    Effect.provideService(Wakeups.ConnectionWakeups, { changes: Stream.never }),
  );
  const settled = yield* SubscriptionRef.changes(supervisor.state).pipe(
    Stream.filter(
      (state) =>
        state.phase === "connected" || state.phase === "blocked" || state.phase === "backoff",
    ),
    Stream.runHead,
  );
  yield* Effect.logInfo("wire fixture connection settled", { settled });
  expect(Option.isSome(settled) && settled.value.phase).toBe("connected");
  const permission = {
    authorize: (_environment: EnvironmentId, method: string, input: unknown) => {
      const missing = clientRpcRequiredScopes(method, input).find(
        (scope) => !scopes.includes(scope),
      );
      return missing ? Effect.fail(Authorization.rpcAuthorizationError(missing)) : Effect.void;
    },
  };
  const call = <M extends Parameters<typeof ClientRpc.requestGuarded>[0]>(
    method: M,
    input: ClientRpc.EnvironmentRpcInput<M>,
  ) =>
    ClientRpc.requestGuarded(method, input).pipe(
      Effect.provideService(Supervisor.EnvironmentSupervisor, supervisor),
      Effect.provideService(ClientRpc.RpcPermissionGuard, permission),
    );
  const metadata = (input: DeusSubscriptionInput) =>
    deusMetadata(input).pipe(
      Stream.provideService(Supervisor.EnvironmentSupervisor, supervisor),
      Stream.provideService(ClientRpc.RpcPermissionGuard, permission),
    );
  return {
    supervisor,
    call,
    frames,
    receivedFrames,
    permission,
    metadata,
    corruptNext: (change: (frame: Record<string, unknown>) => unknown) => {
      corrupt = change;
    },
  };
});

it.live("isolates malformed authenticated media to its request on the same supervised socket", () =>
  Effect.gen(function* () {
    const h = yield* fixture;
    const owner = yield* connect(yield* serve(h), h.issued.token, "direct");
    const ref = h.snapshot.session;
    const attachment = yield* owner.call(WS_METHODS.deusAttach, {
      ...ref,
      inputId: DeusInputId.make("malformed-owner"),
      authority,
      takeover: false,
    });
    const observed = yield* Queue.unbounded<DeusSubscriptionEvent>();
    const subscription = yield* owner.metadata({ ...ref, after: h.snapshot.cursor }).pipe(
      Stream.runForEach((event) => Queue.offer(observed, event)),
      Effect.forkScoped,
    );
    expect((yield* Queue.take(observed)).type).toBe("snapshot");
    const originalSession = yield* SubscriptionRef.get(owner.supervisor.session);
    const pcm = {
      ...attachment,
      type: "pcm" as const,
      encoding: "pcm16le" as const,
      channels: 1 as const,
      sampleRate: 16000 as const,
      sequence: 1,
      data: "AAA=",
    };
    for (const patch of [
      { data: "AAAA" },
      { data: "AAB=" },
      { data: "not-base64" },
      { sampleRate: 24000 },
      { channels: 2 },
      { sequence: -1 },
      { generation: 0 },
      { data: "AAAA".repeat(11000) },
    ]) {
      owner.corruptNext((frame) => ({ ...frame, payload: { ...pcm, ...patch } }));
      const failure = yield* owner.call(WS_METHODS.deusMediaPush, pcm).pipe(Effect.flip);
      expect(failure._tag).toBe("DeusTransportError");
      const request = JSON.parse(owner.frames.at(-1)!);
      expect(
        owner.receivedFrames.some((frame) => {
          const response = JSON.parse(frame);
          return response._tag === "Exit" && response.requestId === request.id;
        }),
      ).toBe(true);
      expect(yield* owner.call(WS_METHODS.serverProbe, {})).toEqual({});
    }
    owner.corruptNext((frame) => ({ ...frame, headers: [["oversize", "x".repeat(48000)]] }));
    expect((yield* owner.call(WS_METHODS.deusMediaPush, pcm).pipe(Effect.flip))._tag).toBe(
      "DeusTransportError",
    );
    expect(Queue.sizeUnsafe(h.realtime)).toBe(0);
    yield* owner.call(WS_METHODS.deusSendInput, {
      ...ref,
      authority,
      inputId: DeusInputId.make("after-malformed"),
      conversation: ref.conversation,
      text: "Still connected",
    });
    expect((yield* Queue.take(observed)).type).toBe("delta");
    expect((yield* owner.call(WS_METHODS.deusGetSnapshot, ref)).transcripts.length).toBeGreaterThan(
      0,
    );
    expect(yield* SubscriptionRef.get(owner.supervisor.session)).toBe(originalSession);
    yield* Deferred.succeed(h.sendGate, undefined);
    yield* owner.call(WS_METHODS.deusMediaPush, pcm);
    yield* Queue.take(h.realtime);
    expect((yield* owner.call(WS_METHODS.deusMediaPush, pcm).pipe(Effect.flip))._tag).toBe(
      "DeusTransportError",
    );
    expect(yield* owner.call(WS_METHODS.serverProbe, {})).toEqual({});
    yield* owner.call(WS_METHODS.deusDetach, attachment);
    yield* Fiber.interrupt(subscription);
    yield* owner.supervisor.disconnect;
    yield* Effect.logInfo(
      "malformed media: 9 correlated PCM/envelope failures; same socket probe, snapshot, durable delta and valid PCM survived; duplicate sequence rejected",
    );
  }).pipe(Effect.provide(Layer.mergeAll(base, NodeHttpServer.layerTest)), Effect.scoped),
);

const forward = Effect.fn("DeusTransport.test.forward")(function* (origin: string) {
  const listening = yield* Deferred.make<void>();
  const sockets = new Set<NodeWS.WebSocket>();
  const stats = { forwardedBytes: 0, maxPendingFrames: 0 };
  const server = yield* Effect.acquireRelease(
    Effect.sync(() => new NodeWS.WebSocketServer({ host: "127.0.0.1", port: 0 })),
    (owned) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            for (const socket of sockets) socket.terminate();
            owned.close(() => resolve());
          }),
      ),
  );
  server.on("listening", () => Deferred.doneUnsafe(listening, Exit.void));
  server.on("connection", (client, request) => {
    const upstream = new NodeWS.WebSocket(origin, {
      headers: { Authorization: request.headers.authorization ?? "" },
    });
    sockets.add(client);
    sockets.add(upstream);
    const pending: Array<{ readonly data: NodeWS.RawData; readonly binary: boolean }> = [];
    client.on("message", (data, binary) => {
      stats.forwardedBytes += Array.isArray(data)
        ? data.reduce((total, part) => total + part.byteLength, 0)
        : data.byteLength;
      if (upstream.readyState === NodeWS.WebSocket.OPEN) upstream.send(data, { binary });
      else if (pending.length < 4) {
        pending.push({ data, binary });
        stats.maxPendingFrames = Math.max(stats.maxPendingFrames, pending.length);
      } else {
        client.terminate();
        upstream.terminate();
      }
    });
    upstream.on("open", () => {
      for (const frame of pending.splice(0)) upstream.send(frame.data, { binary: frame.binary });
    });
    upstream.on("message", (data, binary) => {
      if (client.readyState === NodeWS.WebSocket.OPEN) client.send(data, { binary });
    });
    client.on("close", () => {
      sockets.delete(client);
      upstream.terminate();
    });
    upstream.on("close", () => {
      sockets.delete(upstream);
      client.terminate();
    });
    client.on("error", () => upstream.terminate());
    upstream.on("error", () => client.terminate());
  });
  yield* Deferred.await(listening);
  const address = server.address();
  if (typeof address === "string" || address === null)
    return yield* Effect.die("Expected a fixture forwarder port");
  return { url: `ws://127.0.0.1:${address.port}/ws`, stats };
});

it.live.each(["direct", "relay", "tunnel"] as const)(
  "uses authenticated %s JSON RPC and the real shared supervisor without giving observers media",
  (route) =>
    Effect.gen(function* () {
      const h = yield* fixture;
      yield* Effect.logInfo("wire fixture services built");
      const origin = yield* serve(h);
      const forwarder = route === "direct" ? null : yield* forward(origin);
      const url = forwarder?.url ?? origin;
      yield* Effect.logInfo("wire fixture serving");
      const owner = yield* connect(url, h.issued.token, route);
      const observerToken = yield* h.authSessions.issue({
        subject: "observer",
        method: "bearer-access-token",
        scopes: ["orchestration:read"],
      });
      const observer = yield* connect(url, observerToken.token, route, ["orchestration:read"]);
      yield* Effect.logInfo("wire fixture clients ready");
      const ref = h.snapshot.session;
      expect((yield* observer.call(WS_METHODS.deusGetSnapshot, ref)).session.sessionId).toBe(
        ref.sessionId,
      );
      yield* Effect.logInfo("wire fixture snapshot read");
      const denied = yield* observer
        .call(WS_METHODS.deusAttach, {
          ...ref,
          inputId: DeusInputId.make("observer"),
          authority,
          takeover: true,
        })
        .pipe(Effect.flip);
      expect(denied._tag).toBe("EnvironmentAuthorizationError");
      yield* owner.call(WS_METHODS.deusSendInput, {
        ...ref,
        inputId: DeusInputId.make("text"),
        conversation: h.snapshot.session.conversation,
        text: "Text without a microphone",
        authority,
      });
      yield* Context.get(h.services, Coordinator.DeusCoordinator).recover;
      expect(h.textCalls()).toBe(1);
      const observed = yield* Queue.unbounded<DeusSubscriptionEvent>();
      const metadataSubscription = yield* observer
        .metadata({ ...ref, after: h.snapshot.cursor })
        .pipe(
          Stream.runForEach((event) => Queue.offer(observed, event)),
          Effect.forkScoped,
        );
      expect((yield* Queue.take(observed)).type).toBe("snapshot");
      const attachment = yield* owner.call(WS_METHODS.deusAttach, {
        ...ref,
        inputId: DeusInputId.make("audio"),
        authority,
        takeover: false,
      });
      const transport = yield* ClientMedia.makeDeusMediaTransport(attachment).pipe(
        Effect.provideService(Supervisor.EnvironmentSupervisor, owner.supervisor),
        Effect.provideService(ClientRpc.RpcPermissionGuard, owner.permission),
      );
      const controller = yield* ClientMedia.makeDeusMediaController(attachment, transport);
      yield* Effect.addFinalizer(() => Deferred.succeed(h.sendGate, undefined).pipe(Effect.asVoid));
      expect(yield* controller.offer(new Uint8Array(32000))).toBe(true);
      yield* Queue.take(h.realtime);
      for (let index = 0; index < 20; index++) yield* controller.offer(new Uint8Array(32000));
      const events = yield* Queue.unbounded<string>();
      const metadata = yield* observer.call(WS_METHODS.deusGetSnapshot, ref);
      expect(yield* owner.call(WS_METHODS.serverProbe, {})).toEqual({});
      yield* Queue.offer(events, "metadata-before-blocked-media");
      expect(metadata.transcripts.some((entry) => entry.role === "assistant")).toBe(true);
      yield* owner.call(WS_METHODS.deusSendInput, {
        ...ref,
        inputId: DeusInputId.make("metadata-while-media-blocked"),
        conversation: ref.conversation,
        text: "A durable metadata event while media is blocked",
        authority,
      });
      expect((yield* Queue.take(observed)).type).toBe("delta");
      expect(yield* controller.control("mute")).toBe(true);
      const message = new LiveServerMessage();
      message.serverContent = {
        modelTurn: { parts: [{ inlineData: { mimeType: "audio/pcm;rate=24000", data: "AAA=" } }] },
        turnComplete: true,
      };
      yield* Queue.offer(h.incoming, { type: "message", message });
      expect(yield* controller.takeAudio).toEqual(new Uint8Array(2));
      expect(owner.receivedFrames.some((frame) => frame.includes('"type":"pcm"'))).toBe(true);
      expect(observer.receivedFrames.some((frame) => frame.includes('"type":"pcm"'))).toBe(false);
      expect(controller.stats().maxInputInFlight).toBe(1);
      expect(controller.stats().inputHighWater).toBeLessThanOrEqual(4);
      const requestBytes = owner.frames
        .filter((frame) => frame.includes('"tag":"deus.mediaPush"'))
        .map((frame) => new TextEncoder().encode(frame).length);
      expect(requestBytes).toHaveLength(1);
      expect(requestBytes[0]).toBeLessThanOrEqual(48 * 1024);
      expect(JSON.stringify(metadata)).not.toContain(h.synthetic);
      expect(JSON.stringify(yield* owner.call(WS_METHODS.deusGetSettings, ref))).not.toContain(
        h.synthetic,
      );
      expect(
        (yield* owner
          .call(WS_METHODS.deusMemoryCorrect, {
            ...ref,
            inputId: DeusInputId.make("correction"),
            memoryId: DeusMemoryId.make("missing"),
            expectedRevision: 1,
            correction: "not implemented",
          })
          .pipe(Effect.flip))._tag,
      ).toBe("DeusUnavailableError");
      expect(yield* Queue.take(events)).toBe("metadata-before-blocked-media");
      yield* Effect.logInfo("deus-authenticated-wire fixture", {
        requestBytes,
        stats: controller.stats(),
        route: `${route}-selected-loopback-fixture`,
        forwarder: forwarder?.stats ?? null,
        metadataOrder:
          "snapshot, standard server probe, input delta and mute completed while media provider send remained blocked; PCM reached only owner",
      });
      yield* Deferred.succeed(h.sendGate, undefined);
      yield* controller.dispose;
      expect((yield* owner.call(WS_METHODS.deusRenew, attachment).pipe(Effect.flip))._tag).toBe(
        "DeusLeaseError",
      );
      yield* Fiber.interrupt(metadataSubscription);
      const reset = yield* owner.call(WS_METHODS.deusResetConversation, {
        ...ref,
        inputId: DeusInputId.make("reset"),
        conversation: ref.conversation,
      });
      expect(reset.session.conversation).toBe(ref.conversation + 1);
      yield* owner.supervisor.disconnect;
      yield* SubscriptionRef.changes(owner.supervisor.session).pipe(
        Stream.filter(Option.isNone),
        Stream.runHead,
      );
      yield* owner.supervisor.connect;
      yield* SubscriptionRef.changes(owner.supervisor.session).pipe(
        Stream.filter(Option.isSome),
        Stream.runHead,
      );
      expect((yield* owner.call(WS_METHODS.deusGetSnapshot, ref)).session.conversation).toBe(
        reset.session.conversation,
      );
      expect(h.openedCount()).toBe(1);
      expect(yield* controller.offer(new Uint8Array(2))).toBe(false);
      const count = yield* h.sql<{
        count: number;
      }>`SELECT count(*) AS count FROM orchestration_v2_projection_threads`;
      expect(count[0]?.count).toBe(0);
      yield* owner.supervisor.disconnect;
      yield* observer.supervisor.disconnect;
    }).pipe(
      Effect.tapCause((cause) => Effect.logError("wire fixture body failed", cause)),
      Effect.provide(Layer.mergeAll(base, NodeHttpServer.layerTest)),
      Effect.scoped,
    ),
);
