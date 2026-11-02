import { EnvironmentId, ORCHESTRATION_PROTOCOL_VERSION } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ConnectionOnboarding } from "../connection/onboarding.ts";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { BearerConnectionTarget } from "../connection/model.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import { ConnectionWakeups } from "../connection/wakeups.ts";
import { ClientPresentation } from "../platform/capabilities.ts";
import { DiscoverMembershipStore } from "../platform/persistence.ts";
import type { StoredDiscoverMembership } from "../platform/storageDocument.ts";
import { layerRemoteHttpClient } from "../rpc/http.ts";
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

const makeHarness = Effect.fn("DiscoverTest.makeHarness")(function* () {
  let persisted: StoredDiscoverMembership | null = null;
  let pairingUrl = "http://100.64.0.20:3773/#token=fresh-code";
  let offline = false;
  let calls = 0;
  const requestedTransports: string[] = [];
  const imports: string[] = [];
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
    if (url.endsWith("/hosts")) return Response.json({ hosts: [host] });
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
    if (url.endsWith("/membership")) return Response.json({ ok: true });
    throw new Error("Unexpected discovery request");
  };
  const dependencies = Layer.mergeAll(
    layerRemoteHttpClient(fetchFn),
    Layer.succeed(ClientPresentation, { metadata: { label: "Test client" } }),
    Layer.succeed(ConnectionWakeups, { changes: Stream.never }),
    Layer.succeed(DiscoverMembershipStore, {
      load: Effect.sync(() => persisted),
      save: (value) =>
        Effect.sync(() => {
          persisted = value;
        }),
    }),
    Layer.mock(EnvironmentRegistry)({
      entries,
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
  };
});

describe("directory discovery", () => {
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
        expect(yield* discovery.getHostConfiguration("lan")).toEqual({
          brokerOrigin: "https://directory.example",
          memberToken: "secret-member",
          transport: "lan",
        });
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
