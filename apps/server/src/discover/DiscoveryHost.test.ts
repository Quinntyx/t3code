import {
  AuthStandardClientScopes,
  type ManagedPolicyDocument,
  EnvironmentId,
  ORCHESTRATION_PROTOCOL_VERSION,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as EnvironmentAuth from "../auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerConfig from "../config.ts";
import * as DirectEndpoints from "../environment/DirectEndpoints.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { ServerActivation } from "../serverActivation.ts";
import { fulfillPairingRequest, make } from "./DiscoveryHost.ts";

const environmentId = EnvironmentId.make("host-a");
const request = {
  requestId: "request-a",
  environmentId,
  transport: "lan" as const,
  expiresAt: 120_000,
};

const makeHarness = Effect.fn("DiscoveryHostTest.makeHarness")(function* (
  stallBody = false,
  policy?: ManagedPolicyDocument,
  restored = false,
) {
  const activated = yield* Deferred.make<void>();
  const firstHeartbeat = yield* Deferred.make<void>();
  const secondHeartbeat = yield* Deferred.make<void>();
  const workFinished = yield* Deferred.make<void>();
  const stalled = yield* Deferred.make<void>();
  const body = yield* Deferred.make<null>();
  const addresses: string[] = [];
  const requests: string[] = [];
  let address = "http://192.168.1.2:3773/";
  let removed = false;
  const http = HttpClient.make((req) =>
    Effect.gen(function* () {
      requests.push(req.url);
      if (req.url.endsWith("/hosts/heartbeat")) {
        addresses.push(address);
        const payload = req.body;
        if (payload._tag === "Uint8Array") {
          addresses[addresses.length - 1] = JSON.parse(
            new TextDecoder().decode(payload.body),
          ).endpoints[0].httpBaseUrl;
        }
        yield* Deferred.succeed(
          addresses.length === 1 ? firstHeartbeat : secondHeartbeat,
          undefined,
        );
      }
      const response = HttpClientResponse.fromWeb(
        req,
        Response.json(
          req.url.endsWith("/hosts/enroll")
            ? { hostToken: "host-token" }
            : req.url.endsWith("/work")
              ? { requests: [] }
              : { ok: true },
        ),
      );
      if (req.url.endsWith("/work")) {
        if (stallBody)
          return {
            ...response,
            json: Deferred.succeed(stalled, undefined).pipe(Effect.andThen(Deferred.await(body))),
          };
        yield* Deferred.succeed(workFinished, undefined);
      }
      return response;
    }),
  );
  const service = yield* make.pipe(
    Effect.provide(
      Layer.mergeAll(
        ManagedPolicy.layerTest(policy),
        Layer.succeed(HttpClient.HttpClient, http),
        Layer.mock(ChildProcessSpawner.ChildProcessSpawner)({}),
        Layer.mock(ServerSecretStore.ServerSecretStore)({
          get: () =>
            Effect.succeed(
              restored
                ? Option.some(
                    new TextEncoder().encode(
                      JSON.stringify({
                        brokerOrigin: "http://localhost:3775",
                        hostToken: "host-token",
                        transport: "lan",
                      }),
                    ),
                  )
                : Option.none(),
            ),
          set: () => Effect.void,
          remove: () =>
            Effect.sync(() => {
              removed = true;
            }),
        }),
        Layer.mock(EnvironmentAuth.EnvironmentAuth)({}),
        ServerConfig.layerTest(process.cwd(), { prefix: "t3-discovery-host-" }).pipe(
          Layer.provide(NodeServices.layer),
        ),
        Layer.mock(DirectEndpoints.DirectEndpoints)({
          resolve: () => Effect.succeed([{ kind: "lan", httpBaseUrl: address }]),
        }),
        Layer.mock(ServerEnvironment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId,
            label: "Host",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "test",
            orchestrationProtocolVersion: ORCHESTRATION_PROTOCOL_VERSION,
            capabilities: { repositoryIdentity: true },
          }),
        }),
      ),
    ),
    Effect.provideService(ServerActivation, Deferred.await(activated)),
  );
  if (!restored)
    yield* service.configure({
      brokerOrigin: "http://localhost:3775",
      memberToken: "member-token",
      transport: "lan",
    });
  yield* Deferred.succeed(activated, undefined);
  return {
    service,
    firstHeartbeat,
    secondHeartbeat,
    workFinished,
    stalled,
    addresses,
    requests,
    move: () => {
      address = "http://192.168.1.3:3773/";
    },
    removed: () => removed,
  };
});

describe("discovery host delegation", () => {
  it.effect(
    "denies discovery enrollment for local-only clients but not for Connect-only denial",
    () =>
      Effect.gen(function* () {
        const denied = yield* makeHarness(false, {
          schemaVersion: 1,
          organization: "Example",
          limits: { clients: ["desktop", "local-browser"] },
        }).pipe(Effect.flip);
        expect(denied.message).toContain("Example's policy does not allow remote clients");
        const restored = yield* makeHarness(
          false,
          {
            schemaVersion: 1,
            organization: "Example",
            limits: { clients: ["desktop", "local-browser"] },
          },
          true,
        );
        yield* TestClock.adjust("3 seconds");
        expect(restored.requests).toEqual([]);
        expect((yield* restored.service.status()).error).toContain("Example's policy");
        yield* restored.service.revoke();
        expect((yield* restored.service.status()).brokerOrigin).toBeNull();
        const allowed = yield* makeHarness(false, {
          schemaVersion: 1,
          organization: "Example",
          limits: { connect: false },
        });
        yield* Deferred.await(allowed.firstHeartbeat);
        expect((yield* allowed.service.status()).brokerOrigin).toBe("http://localhost:3775");
      }).pipe(Effect.scoped),
  );

  it.effect("refuses requests outside the enrolled environment, transport, or lifetime", () =>
    Effect.gen(function* () {
      let issued = 0;
      for (const invalid of [
        { ...request, environmentId: EnvironmentId.make("host-b") },
        { ...request, transport: "tailscale" as const },
        { ...request, expiresAt: 0 },
      ]) {
        const result = yield* fulfillPairingRequest({
          request: invalid,
          environmentId,
          transport: "lan",
          pairingBaseUrl: "http://192.168.1.2:3773/",
          createPairingLink: () => {
            issued++;
            return Effect.die("must not issue");
          },
        });
        expect(result.status).toBe("failed");
      }
      expect(issued).toBe(0);
    }),
  );

  it.effect("refreshes the advertised LAN address after the interface changes", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness();
      yield* Deferred.await(h.firstHeartbeat);
      yield* Deferred.await(h.workFinished);
      h.move();
      yield* TestClock.adjust("30 seconds");
      yield* Deferred.await(h.secondHeartbeat);
      expect([...new Set(h.addresses)]).toEqual([
        "http://192.168.1.2:3773/",
        "http://192.168.1.3:3773/",
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("bounds response body reads so stop sharing can remove credentials", () =>
    Effect.gen(function* () {
      const h = yield* makeHarness(true);
      yield* Deferred.await(h.stalled);
      const stopping = yield* h.service.revoke().pipe(Effect.forkChild);
      yield* TestClock.adjust("10 seconds");
      expect(h.removed()).toBe(true);
      yield* Fiber.join(stopping);
      expect((yield* h.service.status()).brokerOrigin).toBeNull();
    }).pipe(Effect.scoped),
  );

  it.effect("issues a fresh bounded credential through ordinary pairing", () =>
    Effect.gen(function* () {
      const result = yield* fulfillPairingRequest({
        request,
        environmentId,
        transport: "lan",
        pairingBaseUrl: "http://192.168.1.2:3773/",
        createPairingLink: (input) => {
          expect(input?.scopes).toEqual(AuthStandardClientScopes);
          expect(Duration.toMillis(input!.ttl!)).toBe(60_000);
          return Effect.succeed({
            id: "grant-a",
            credential: "one-time-secret",
            scopes: AuthStandardClientScopes,
            subject: "discover",
            createdAt: DateTime.makeUnsafe(0),
            expiresAt: DateTime.makeUnsafe(60_000),
          });
        },
      });
      expect(result).toMatchObject({ status: "ready", expiresAt: 60_000 });
      if (result.status === "ready") {
        expect(result.pairingUrl).toContain("one-time-secret");
        expect(new URL(result.pairingUrl).origin).toBe("http://192.168.1.2:3773");
      }
    }),
  );
});
