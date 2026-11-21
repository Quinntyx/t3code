import {
  EnvironmentId,
  EnvironmentAuthorizationError,
  authScopeRequiredResponse,
  ORCHESTRATION_PROTOCOL_VERSION,
  WS_METHODS,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as TestClock from "effect/testing/TestClock";

import { ConnectionOnboarding } from "../connection/onboarding.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionTarget,
  PrimaryConnectionTarget,
  ConnectionBlockedError,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { ConnectionWakeups } from "../connection/wakeups.ts";
import { ClientPresentation } from "../platform/capabilities.ts";
import { ConnectionPersistenceError, DiscoverMembershipStore } from "../platform/persistence.ts";
import type { StoredDiscoverMembership } from "../platform/storageDocument.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
import { RpcPermissionGuard } from "../rpc/client.ts";
import { make } from "./service.ts";
import { parseDiscoverEnrollmentUrl } from "./url.ts";

const id = EnvironmentId.make("discovered-environment");
const host = {
  descriptor: {
    environmentId: id,
    label: "Workstation",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "test",
    orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
    capabilities: { repositoryIdentity: true },
  },
  endpoints: [
    { transport: "lan", httpBaseUrl: "http://192.168.1.20:3773" },
    { transport: "tailscale", httpBaseUrl: "http://100.64.0.20:3773" },
  ],
  lastSeenAt: 1,
};
const enrollmentUrl = "https://directory.example/discover#token=enrollment-code";
const service = {
  serviceId: "hub",
  kind: "cliproxyapi",
  label: "Model hub",
  protocol: "openai",
  endpoints: [{ transport: "lan", httpBaseUrl: "http://192.168.1.30:8317" }],
  capabilities: ["key-exchange"],
  health: "online",
  lastSeenAt: 2,
  linkedAt: null,
};
const serviceCredential = {
  protocol: "openai",
  baseUrl: "http://192.168.1.30:8317/v1",
  apiKey: "t3d-minted",
};

const makeHarness = Effect.fn("DiscoverTest.makeHarness")(function* (
  surface: "desktop" | "mobile" | "web" = "web",
  initiallyRegistered = false,
) {
  let persisted: StoredDiscoverMembership | null = null;
  let pairingUrl = "http://100.64.0.20:3773/#token=fresh-code";
  let offline = false;
  let calls = 0;
  const requestedTransports: string[] = [];
  const imports: string[] = [];
  const hostCalls: Array<{ environmentId: EnvironmentId; method: string; input: unknown }> = [];
  let failHost = false;
  let registered = initiallyRegistered;
  let leftDirectory = false;
  let denyHost = false;
  let failSave = false;
  let serviceLinked = false;
  let serviceUnlinked = false;
  let serviceReads = 0;
  let serviceMints = 0;
  let stallCredentialBody = false;
  let gateLink = false;
  let signalLinkReached: () => void = () => {};
  let releaseLink: () => void = () => {};
  const linkReached = new Promise<void>((resolve) => {
    signalLinkReached = resolve;
  });
  const linkGate = new Promise<void>((resolve) => {
    releaseLink = resolve;
  });
  const authorized: string[] = [];
  const entries = yield* SubscriptionRef.make<ReadonlyMap<EnvironmentId, ConnectionCatalogEntry>>(
    new Map(),
  );
  const importReached = yield* Deferred.make<void>();
  const importRelease = yield* Deferred.make<void>();
  let gateImport = false;
  const fetchFn: typeof fetch = async (input, init) => {
    const url = String(input);
    calls++;
    if (offline) return Response.json({}, { status: 503 });
    if (url.endsWith("/enroll")) {
      expect(JSON.parse(String(init?.body))).toEqual({
        code: "enrollment-code",
        label: "Test client",
      });
      return Response.json({
        directoryId: "directory-1",
        label: "My devices",
        memberId: "member-1",
        token: "secret-member",
      });
    }
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-member");
    if (url.endsWith("/hosts"))
      return Response.json({
        hosts: [host],
        services: [{ ...service, linkedAt: serviceLinked ? 5 : null }],
      });
    if (url.endsWith("/services/hub/link")) {
      if (init?.method === "DELETE") {
        serviceUnlinked = true;
        serviceLinked = false;
        return Response.json({ ok: true });
      }
      if (init?.method !== "POST") {
        serviceReads += 1;
        if (stallCredentialBody)
          return new Response(
            new ReadableStream({
              start() {},
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        return serviceLinked
          ? Response.json({ serviceId: "hub", linkedAt: 5, credential: serviceCredential })
          : Response.json({ error: "Service is not linked." }, { status: 404 });
      }
      serviceLinked = true;
      serviceMints += 1;
      if (gateLink) {
        signalLinkReached();
        await linkGate;
      }
      return Response.json({ serviceId: "hub", linkedAt: 5, credential: serviceCredential });
    }
    if (url.endsWith("/requests")) {
      const body = JSON.parse(String(init?.body));
      requestedTransports.push(body.transport);
      return Response.json({
        requestId: "request-1",
        environmentId: id,
        transport: body.transport,
        expiresAt: Number.MAX_SAFE_INTEGER,
      });
    }
    if (url.endsWith("/result"))
      return Response.json({ status: "ready", pairingUrl, expiresAt: Number.MAX_SAFE_INTEGER });
    if (url.endsWith("/membership")) {
      leftDirectory = true;
      return Response.json({ ok: true });
    }
    throw new Error("Unexpected discovery request");
  };
  const client = {
    [WS_METHODS.discoverConfigure]: (input: unknown) =>
      Effect.gen(function* () {
        if (failHost)
          return yield* new ConnectionBlockedError({
            reason: "permission",
            detail: "Local host unavailable",
          });
        const supervisor = yield* EnvironmentSupervisor;
        hostCalls.push({
          environmentId: supervisor.target.environmentId,
          method: "configure",
          input,
        });
        registered = true;
        return { brokerOrigin: "https://directory.example", transport: "tailscale", error: null };
      }),
    [WS_METHODS.discoverRevoke]: () =>
      Effect.gen(function* () {
        const supervisor = yield* EnvironmentSupervisor;
        hostCalls.push({
          environmentId: supervisor.target.environmentId,
          method: "revoke",
          input: {},
        });
        registered = false;
        return { brokerOrigin: null, transport: null, error: null };
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.never,
    subscribeServerConfig: () => Stream.never,
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  const permissionGuard = {
    authorize: (_id: EnvironmentId, method: string) =>
      Effect.gen(function* () {
        authorized.push(method);
        if (denyHost)
          return yield* new EnvironmentAuthorizationError({
            ...authScopeRequiredResponse("orchestration:read"),
            message: "Not allowed",
          });
      }),
  };
  const dependencies = Layer.mergeAll(
    layerRemoteHttpClient(fetchFn),
    Layer.succeed(ClientPresentation, { metadata: { label: "Test client", surface } }),
    Layer.succeed(ConnectionWakeups, { changes: Stream.never }),
    Layer.succeed(DiscoverMembershipStore, {
      load: Effect.sync(() => persisted),
      save: (value) =>
        Effect.gen(function* () {
          if (failSave && value !== null)
            return yield* new ConnectionPersistenceError({
              operation: "save-discovery-membership",
              message: "Storage unavailable",
            });
          persisted = value;
        }),
    }),
    Layer.mock(EnvironmentRegistry)({
      entries,
      run: (environmentId, effect) =>
        Effect.gen(function* () {
          const target = (yield* SubscriptionRef.get(entries)).get(environmentId)!.target;
          const activeSession = yield* SubscriptionRef.make<Option.Option<RpcSession>>(
            Option.some(session),
          );
          const state = yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE);
          const prepared = yield* SubscriptionRef.make<Option.Option<PreparedConnection>>(
            Option.none(),
          );
          return yield* effect.pipe(
            Effect.provide(
              Layer.mock(EnvironmentSupervisor)({
                target,
                session: activeSession,
                state,
                prepared,
              }),
            ),
          );
        }),
      networkStatus: yield* SubscriptionRef.make<"online" | "offline" | "unknown">("online"),
    }),
    Layer.mock(ConnectionOnboarding)({
      registerPairing: (input) =>
        Effect.gen(function* () {
          expect(input.expectedEnvironmentId).toBe(id);
          if (gateImport) {
            yield* Deferred.succeed(importReached, undefined);
            yield* Deferred.await(importRelease);
          }
          imports.push(input.pairingUrl!);
          yield* SubscriptionRef.update(entries, (current) =>
            new Map(current).set(id, {
              target: new BearerConnectionTarget({
                environmentId: id,
                label: "Workstation",
                connectionId: "paired",
              }),
              profile: Option.none(),
              enabled: true,
            }),
          );
          return id;
        }),
    }),
  );
  return {
    create: make.pipe(Effect.provide(dependencies)),
    entries,
    imports,
    requestedTransports,
    hostCalls,
    authorized,
    permissionGuard,
    failSave: () => {
      failSave = true;
    },
    registered: () => registered,
    leftDirectory: () => leftDirectory,
    failHost: () => {
      failHost = true;
    },
    denyHost: () => {
      denyHost = true;
    },
    importReached,
    importRelease,
    gateImport: () => {
      gateImport = true;
    },
    setPairingUrl: (value: string) => {
      pairingUrl = value;
    },
    setOffline: () => {
      offline = true;
    },
    persisted: () => persisted,
    calls: () => calls,
    serviceUnlinked: () => serviceUnlinked,
    serviceReads: () => serviceReads,
    serviceMints: () => serviceMints,
    stallCredentialBody: () => {
      stallCredentialBody = true;
    },
    linkReached: Effect.promise(() => linkReached),
    releaseLink,
    gateLink: () => {
      gateLink = true;
    },
  };
});

describe("directory discovery", () => {
  it.effect(
    "enrolling a desktop registers only its local server, and disconnect unregisters it",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness("desktop");
        const localId = EnvironmentId.make("local-server");
        yield* SubscriptionRef.set(
          h.entries,
          new Map([
            [
              id,
              {
                target: new BearerConnectionTarget({
                  environmentId: id,
                  label: "Remote",
                  connectionId: "remote",
                }),
                profile: Option.none(),
                enabled: true,
              },
            ],
            [
              localId,
              {
                target: new PrimaryConnectionTarget({
                  environmentId: localId,
                  label: "Local",
                  httpBaseUrl: "http://localhost:3773",
                  wsBaseUrl: "ws://localhost:3773",
                }),
                profile: Option.none(),
                enabled: true,
              },
            ],
          ]),
        );
        const discovery = yield* h.create;
        yield* discovery
          .enroll({ enrollmentUrl, transport: "lan" })
          .pipe(Effect.provideService(RpcPermissionGuard, h.permissionGuard));
        expect(h.hostCalls).toEqual([
          {
            environmentId: localId,
            method: "configure",
            input: {
              brokerOrigin: "https://directory.example",
              memberToken: "secret-member",
              transport: "lan",
            },
          },
        ]);
        expect(h.registered()).toBe(true);
        expect(h.persisted()).not.toBeNull();
        yield* discovery
          .disconnect()
          .pipe(Effect.provideService(RpcPermissionGuard, h.permissionGuard));
        expect(h.hostCalls.map((call) => call.environmentId)).toEqual([localId, localId]);
        expect(h.hostCalls[1]?.method).toBe("revoke");
        expect(h.authorized).toEqual([WS_METHODS.discoverConfigure, WS_METHODS.discoverRevoke]);
        expect(h.registered()).toBe(false);
        expect(h.leftDirectory()).toBe(true);
        expect(h.persisted()).toBeNull();
        expect((yield* SubscriptionRef.get(h.entries)).has(id)).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "desktop enrollment fails safely without a local server and rolls back failed registration",
    () =>
      Effect.gen(function* () {
        for (const failure of [
          "missing-local",
          "host",
          "permission",
          "storage",
          "pre-existing",
        ] as const) {
          const h = yield* makeHarness("desktop", failure === "pre-existing");
          if (failure !== "missing-local") {
            const localId = EnvironmentId.make("local-server");
            yield* SubscriptionRef.set(
              h.entries,
              new Map([
                [
                  localId,
                  {
                    target: new PrimaryConnectionTarget({
                      environmentId: localId,
                      label: "Local",
                      httpBaseUrl: "http://localhost:3773",
                      wsBaseUrl: "ws://localhost:3773",
                    }),
                    profile: Option.none(),
                    enabled: true,
                  },
                ],
              ]),
            );
          }
          if (failure === "host" || failure === "pre-existing") h.failHost();
          if (failure === "permission") h.denyHost();
          if (failure === "storage") h.failSave();
          const discovery = yield* h.create;
          const result = yield* discovery
            .enroll({ enrollmentUrl })
            .pipe(Effect.provideService(RpcPermissionGuard, h.permissionGuard), Effect.result);
          expect(result._tag).toBe("Failure");
          expect(h.persisted()).toBeNull();
          expect(h.registered()).toBe(failure === "pre-existing");
          if (failure === "pre-existing") expect(h.hostCalls).toEqual([]);
          expect(h.leftDirectory()).toBe(failure !== "missing-local");
          if (failure === "missing-local") expect(h.calls()).toBe(0);
        }
      }).pipe(Effect.scoped),
  );

  it.effect("mobile and browser enrollment never registers a connected server", () =>
    Effect.gen(function* () {
      for (const surface of ["mobile", "web"] as const) {
        const h = yield* makeHarness(surface);
        yield* SubscriptionRef.set(
          h.entries,
          new Map([
            [
              id,
              {
                target: new PrimaryConnectionTarget({
                  environmentId: id,
                  label: "Remote primary",
                  httpBaseUrl: "https://remote.example",
                  wsBaseUrl: "wss://remote.example",
                }),
                profile: Option.none(),
                enabled: true,
              },
            ],
          ]),
        );
        const discovery = yield* h.create;
        yield* discovery.enroll({ enrollmentUrl });
        yield* discovery.disconnect();
        expect(h.hostCalls).toEqual([]);
      }
    }).pipe(Effect.scoped),
  );
  it("distinguishes enrollment from pairing links and rejects ambiguous origins and fragments", () => {
    expect(parseDiscoverEnrollmentUrl(enrollmentUrl)).toEqual({
      brokerOrigin: "https://directory.example",
      code: "enrollment-code",
    });
    for (const value of [
      "https://directory.example/#token=pairing",
      "https://directory.example/discover?token=leak",
      "https://user:password@directory.example/discover#token=code",
      "https://directory.example/discover#token=a&token=b",
      "https://directory.example/discover?host=other#token=code",
      "https://directory.example/discover#token=code&host=other",
      "ftp://directory.example/discover#token=code",
      "http://directory.example/discover#token=code",
    ])
      expect(parseDiscoverEnrollmentUrl(value)).toBeNull();
    expect(parseDiscoverEnrollmentUrl("http://localhost:8080/discover#token=code")).toEqual({
      brokerOrigin: "http://localhost:8080",
      code: "code",
    });
  });

  it.effect(
    "imports once, persists removal suppression, and retains direct connections on disconnect",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const discovery = yield* h.create;
        yield* discovery.enroll({ enrollmentUrl });
        yield* discovery.refresh();
        expect(h.imports).toHaveLength(1);
        expect(h.requestedTransports).toEqual(["tailscale"]);
        expect(h.persisted()?.seenEnvironmentIds).toEqual([id]);
        const state = yield* SubscriptionRef.get(discovery.state);
        expect(state.directory).toEqual({
          directoryId: "directory-1",
          label: "My devices",
          brokerOrigin: "https://directory.example",
        });
        expect(JSON.stringify(state)).not.toContain("secret-member");
        expect(h.hostCalls).toEqual([]);
        yield* SubscriptionRef.set(h.entries, new Map());
        const restarted = yield* h.create;
        yield* restarted.refresh();
        expect(h.imports).toHaveLength(1);
        yield* discovery.disconnect();
        expect(h.persisted()).toBeNull();
        expect((yield* SubscriptionRef.get(discovery.state)).directory).toBeNull();
      }).pipe(Effect.scoped),
  );

  it.effect(
    "does not reenable or replace existing manual entries and remembers them after removal",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        const saved = {
          target: new BearerConnectionTarget({
            environmentId: id,
            label: "Manual",
            connectionId: "manual",
          }),
          profile: Option.none(),
          enabled: false,
        };
        yield* SubscriptionRef.set(h.entries, new Map([[id, saved]]));
        const discovery = yield* h.create;
        yield* discovery.enroll({ enrollmentUrl });
        yield* discovery.refresh();
        expect(h.imports).toEqual([]);
        expect((yield* SubscriptionRef.get(h.entries)).get(id)).toBe(saved);
        yield* SubscriptionRef.set(h.entries, new Map());
        yield* discovery.refresh();
        expect(h.imports).toEqual([]);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "rejects mismatched endpoints before redemption and preserves state when the directory is offline",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.setPairingUrl("https://attacker.example/#token=code");
        const discovery = yield* h.create;
        yield* discovery.enroll({ enrollmentUrl });
        yield* discovery.refresh();
        expect(h.imports).toEqual([]);
        expect((yield* SubscriptionRef.get(discovery.state)).error).not.toBeNull();
        expect(h.persisted()?.seenEnvironmentIds).toEqual([]);
        h.setPairingUrl("http://100.64.0.20:3773/#token=fresh-code");
        yield* discovery.refresh();
        const before = yield* SubscriptionRef.get(discovery.state);
        h.setOffline();
        yield* discovery.refresh();
        expect((yield* SubscriptionRef.get(discovery.state)).hosts).toEqual(before.hosts);
        expect(h.persisted()).not.toBeNull();
        yield* discovery.disconnect();
        expect((yield* SubscriptionRef.get(h.entries)).has(id)).toBe(true);
      }).pipe(Effect.scoped),
  );

  it.effect(
    "disconnect cancels an in-flight import and prevents late membership resurrection",
    () =>
      Effect.gen(function* () {
        const h = yield* makeHarness();
        h.gateImport();
        const discovery = yield* h.create;
        const enrolling = yield* discovery.enroll({ enrollmentUrl }).pipe(Effect.forkChild);
        yield* Deferred.await(h.importReached);
        yield* discovery.disconnect();
        yield* Deferred.succeed(h.importRelease, undefined);
        yield* Fiber.await(enrolling);
        expect(h.imports).toEqual([]);
        expect(h.persisted()).toBeNull();
        expect((yield* SubscriptionRef.get(discovery.state)).directory).toBeNull();
      }).pipe(Effect.scoped),
  );
});

describe("discovered services", () => {
  it.effect("links only on request and clears the link when unlinked", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const discovery = yield* h.create;
      yield* discovery.enroll({ enrollmentUrl });
      const before = yield* SubscriptionRef.get(discovery.state);
      expect(before.services).toEqual([service]);
      expect(before.services[0]!.linkedAt).toBeNull();

      const link = yield* discovery.linkService({ serviceId: "hub" });
      expect(link.credential).toEqual(serviceCredential);
      expect((yield* SubscriptionRef.get(discovery.state)).services[0]!.linkedAt).toBe(5);

      yield* discovery.unlinkService("hub");
      expect(h.serviceUnlinked()).toBe(true);
      expect((yield* SubscriptionRef.get(discovery.state)).services[0]!.linkedAt).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("rejects a link for a different service than the one requested", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const discovery = yield* h.create;
      yield* discovery.enroll({ enrollmentUrl });
      const result = yield* discovery.linkService({ serviceId: "other" }).pipe(Effect.exit);
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.scoped),
  );
});

describe("reading a service link", () => {
  it.effect("returns the stored credential without minting a new one", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      const discovery = yield* h.create;
      yield* discovery.enroll({ enrollmentUrl });
      expect(yield* discovery.serviceLink("hub")).toBeNull();
      expect(h.serviceMints()).toBe(0);

      yield* discovery.linkService({ serviceId: "hub" });
      expect(h.serviceMints()).toBe(1);

      const stored = yield* discovery.serviceLink("hub");
      expect(stored?.credential).toEqual(serviceCredential);
      expect(h.serviceMints()).toBe(1);
      expect(h.serviceReads()).toBe(2);
    }).pipe(Effect.scoped),
  );
});

describe("service operations across membership changes", () => {
  it.effect("disconnect cancels an in-flight link instead of publishing its credential", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.gateLink();
      const discovery = yield* h.create;
      yield* discovery.enroll({ enrollmentUrl });
      const linking = yield* discovery.linkService({ serviceId: "hub" }).pipe(Effect.forkChild);
      yield* h.linkReached;
      yield* discovery.disconnect();
      h.releaseLink();
      const result = yield* Fiber.await(linking);
      expect(result._tag).toBe("Failure");
      expect((yield* SubscriptionRef.get(discovery.state)).services).toEqual([]);
      expect(h.persisted()).toBeNull();
    }).pipe(Effect.scoped),
  );
});

describe("credential reads", () => {
  it.effect("times out a stalled body instead of leaving the dialog pending", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      h.stallCredentialBody();
      const discovery = yield* h.create;
      yield* discovery.enroll({ enrollmentUrl });
      const reading = yield* discovery.serviceLink("hub").pipe(Effect.forkChild);
      yield* TestClock.adjust("16 seconds");
      const result = yield* Fiber.await(reading);
      expect(result._tag).toBe("Failure");
    }).pipe(Effect.scoped),
  );
});
