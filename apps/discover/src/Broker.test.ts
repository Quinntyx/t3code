// @effect-diagnostics-next-line nodeBuiltinImport:off -- Inspect the exact persisted token digest in this boundary test.
import * as NodeCrypto from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Inspect real SQLite bytes after closing all connections.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Construct a real temporary SQLite filename.
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { EnvironmentId } from "@t3tools/contracts";
import type { DiscoverHostRegistration } from "@t3tools/contracts/discover";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as TestClock from "effect/testing/TestClock";
import * as SqlClient from "effect/sql/SqlClient";

import * as Broker from "./Broker.ts";
import type { DiscoverableService } from "./services/index.ts";

const registration = (id: string): DiscoverHostRegistration => ({
  descriptor: {
    environmentId: EnvironmentId.make(id),
    label: id,
    platform: { os: "linux", arch: "x64" },
    serverVersion: "1.0.0",
    capabilities: { repositoryIdentity: false },
  },
  endpoints: [{ transport: "lan", httpBaseUrl: "http://192.168.1.2:3773" }],
});

const member = Effect.fn("test.member")(function* (broker: Broker.Broker["Service"]) {
  const code = yield* broker.pair();
  return yield* broker.enroll({ code, label: "device" });
});

it.effect("atomically consumes enrollment codes and persists only token hashes", () =>
  Effect.gen(function* () {
    const broker = yield* Broker.Broker;
    const code = yield* broker.pair();
    const results = yield* Effect.forEach(
      ["one", "two"],
      (label) => Effect.exit(broker.enroll({ code, label })),
      { concurrency: "unbounded" },
    );
    assert.strictEqual(results.filter(Exit.isSuccess).length, 1);
    const success = results.find(Exit.isSuccess);
    assert.isDefined(success);
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ token_hash: string }>`SELECT token_hash FROM members`;
    assert.deepEqual(rows, [
      { token_hash: NodeCrypto.createHash("sha256").update(success.value.token).digest("hex") },
    ]);
    assert.deepEqual(yield* sql`SELECT * FROM enrollment_codes`, []);
    const expired = yield* broker.pair();
    yield* TestClock.adjust("5 minutes");
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(broker.enroll({ code: expired, label: "late" }))),
    );
  }).pipe(Effect.provide(Broker.layer(":memory:"))),
);

it.effect("isolates roles, stable host owners, assigned work and one-time requester results", () =>
  Effect.gen(function* () {
    const broker = yield* Broker.Broker;
    const owner = yield* member(broker);
    const guest = yield* member(broker);
    const host = registration("host-one");
    const other = registration("host-two");
    const grant = yield* broker.enrollHost(owner.token, host);
    const otherGrant = yield* broker.enrollHost(guest.token, other);
    const denied = [
      broker.directory(grant.hostToken),
      broker.work(owner.token),
      broker.enrollHost(guest.token, host),
      broker.heartbeat(grant.hostToken, other),
    ];
    for (const operation of denied) assert.isTrue(Exit.isFailure(yield* Effect.exit(operation)));
    assert.strictEqual((yield* broker.directory(guest.token)).hosts.length, 2);
    const request = yield* broker.request(guest.token, {
      environmentId: host.descriptor.environmentId,
      transport: "lan",
    });
    assert.deepEqual((yield* broker.work(grant.hostToken)).requests, [request]);
    assert.deepEqual((yield* broker.work(otherGrant.hostToken)).requests, []);
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(broker.result(owner.token, request.requestId))),
    );
    const ready = {
      status: "ready" as const,
      pairingUrl: "http://192.168.1.2:3773/#token=one-time",
      expiresAt: request.expiresAt,
    };
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(broker.complete(otherGrant.hostToken, request.requestId, ready)),
      ),
    );
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(broker.complete(owner.token, request.requestId, ready))),
    );
    yield* broker.complete(grant.hostToken, request.requestId, ready);
    assert.deepEqual(yield* broker.result(guest.token, request.requestId), ready);
    assert.deepEqual(yield* broker.result(guest.token, request.requestId), {
      status: "failed",
      error: "Request unavailable.",
    });
    const pending = yield* broker.request(guest.token, {
      environmentId: host.descriptor.environmentId,
      transport: "lan",
    });
    yield* broker.unregister(grant.hostToken);
    assert.deepEqual(yield* broker.result(guest.token, pending.requestId), {
      status: "failed",
      error: "Request unavailable.",
    });
    assert.isTrue(Exit.isFailure(yield* Effect.exit(broker.work(grant.hostToken))));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(broker.enrollHost(guest.token, host))));
    const renewed = yield* broker.enrollHost(owner.token, host);
    yield* broker.leave(owner.token);
    assert.isTrue(Exit.isFailure(yield* Effect.exit(broker.work(renewed.hostToken))));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(broker.directory(owner.token))));
    assert.strictEqual((yield* broker.directory(guest.token)).hosts.length, 1);
    assert.deepEqual(yield* broker.members(), [{ id: guest.memberId, label: "device" }]);
    yield* broker.revoke(guest.memberId);
    assert.isTrue(Exit.isFailure(yield* Effect.exit(broker.directory(guest.token))));
    assert.isTrue(Exit.isFailure(yield* Effect.exit(broker.work(otherGrant.hostToken))));
    assert.deepEqual(yield* broker.members(), []);
  }).pipe(Effect.provide(Broker.layer(":memory:"))),
);

it.effect(
  "expires work and results within two minutes while retaining offline directory entries",
  () =>
    Effect.gen(function* () {
      const broker = yield* Broker.Broker;
      const owner = yield* member(broker);
      const host = registration("host");
      const grant = yield* broker.enrollHost(owner.token, host);
      const request = yield* broker.request(owner.token, {
        environmentId: host.descriptor.environmentId,
        transport: "lan",
      });
      const initial = (yield* broker.directory(owner.token)).hosts[0]!;
      yield* TestClock.adjust("2 minutes");
      assert.deepEqual((yield* broker.work(grant.hostToken)).requests, []);
      assert.deepEqual(yield* broker.result(owner.token, request.requestId), {
        status: "failed",
        error: "Request unavailable.",
      });
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            broker.complete(grant.hostToken, request.requestId, {
              status: "failed",
              error: "late",
            }),
          ),
        ),
      );
      assert.deepEqual((yield* broker.directory(owner.token)).hosts, [initial]);
      yield* broker.heartbeat(grant.hostToken, host);
      assert.isAbove(
        (yield* broker.directory(owner.token)).hosts[0]!.lastSeenAt,
        initial.lastSeenAt,
      );
    }).pipe(Effect.provide(Broker.layer(":memory:"))),
);

it.effect("retains directory, enrollment and pending work across a durable restart", () =>
  Effect.gen(function* () {
    const path = NodePath.join(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3discover-")),
      "state.sqlite",
    );
    const state = yield* Effect.gen(function* () {
      const broker = yield* Broker.Broker;
      const owner = yield* member(broker);
      const host = registration("durable-host");
      const grant = yield* broker.enrollHost(owner.token, host);
      const code = yield* broker.pair();
      const request = yield* broker.request(owner.token, {
        environmentId: host.descriptor.environmentId,
        transport: "lan",
      });
      return { owner, grant, code, request };
    }).pipe(Effect.provide(Broker.layer(path)), Effect.scoped);
    yield* Effect.gen(function* () {
      const broker = yield* Broker.Broker;
      assert.strictEqual((yield* broker.directory(state.owner.token)).hosts.length, 1);
      assert.deepEqual((yield* broker.work(state.grant.hostToken)).requests, [state.request]);
      yield* broker.enroll({ code: state.code, label: "after restart" });
      assert.isTrue(
        Exit.isFailure(yield* Effect.exit(broker.enroll({ code: state.code, label: "replay" }))),
      );
    }).pipe(Effect.provide(Broker.layer(path)), Effect.scoped);
    const disk = NodeFS.readFileSync(path).toString("latin1");
    for (const secret of [state.owner.token, state.grant.hostToken, state.code])
      assert.notInclude(disk, secret);
  }),
);

const fakeService = (input: {
  readonly serviceId: string;
  readonly capabilities: ReadonlyArray<"key-exchange">;
  readonly minted: Array<string>;
  readonly revoked: Array<string>;
}): DiscoverableService => ({
  serviceId: input.serviceId,
  kind: "cliproxyapi",
  label: input.serviceId,
  protocol: "openai",
  endpoints: [{ transport: "lan", httpBaseUrl: "http://192.168.1.9:8317" }],
  capabilities: input.capabilities,
  health: Effect.succeed("online"),
  issueCredential: (member) =>
    Effect.sync(() => {
      const apiKey = `key-${member.label}-${input.minted.length}`;
      input.minted.push(apiKey);
      return {
        protocol: "openai" as const,
        baseUrl: "http://192.168.1.9:8317/v1",
        apiKey,
      };
    }),
  revokeCredential: (_member, credential) =>
    Effect.sync(() => {
      input.revoked.push(credential.apiKey);
    }),
});

const hubMinted: Array<string> = [];
const hubRevoked: Array<string> = [];

it.effect("lists services with per-member link state and mints one credential per member", () =>
  Effect.gen(function* () {
    const broker = yield* Broker.Broker;
    const owner = yield* broker.enroll({ code: yield* broker.pair(), label: "owner" });
    const guest = yield* broker.enroll({ code: yield* broker.pair(), label: "guest" });
    const initial = yield* broker.directory(owner.token);
    assert.deepEqual(initial.services, [
      {
        serviceId: "hub",
        kind: "cliproxyapi",
        label: "hub",
        protocol: "openai",
        endpoints: [{ transport: "lan", httpBaseUrl: "http://192.168.1.9:8317" }],
        capabilities: ["key-exchange"],
        health: "online",
        lastSeenAt: 0,
        linkedAt: null,
      },
    ]);
    const first = yield* broker.link(owner.token, { serviceId: "hub" });
    assert.strictEqual(first.credential?.apiKey, "key-owner-0");
    assert.deepEqual(hubMinted, ["key-owner-0"]);
    const again = yield* broker.link(owner.token, { serviceId: "hub" });
    assert.deepEqual(again, first);
    assert.deepEqual(hubMinted, ["key-owner-0"]);
    assert.strictEqual(
      (yield* broker.serviceLink(owner.token, "hub")).credential?.apiKey,
      "key-owner-0",
    );
    assert.isTrue(Exit.isFailure(yield* Effect.exit(broker.serviceLink(guest.token, "hub"))));
    assert.strictEqual((yield* broker.directory(guest.token)).services[0]!.linkedAt, null);
    const guestLink = yield* broker.link(guest.token, { serviceId: "hub" });
    assert.strictEqual(guestLink.credential?.apiKey, "key-guest-1");
    assert.strictEqual((yield* broker.directory(owner.token)).services[0]!.health, "online");
    yield* broker.unlink(owner.token, "hub");
    assert.deepEqual(hubRevoked, ["key-owner-0"]);
    assert.isTrue(Exit.isFailure(yield* Effect.exit(broker.serviceLink(owner.token, "hub"))));
    assert.strictEqual((yield* broker.directory(guest.token)).services[0]!.linkedAt !== null, true);
    yield* broker.leave(guest.token);
    assert.isTrue(Exit.isFailure(yield* Effect.exit(broker.serviceLink(guest.token, "hub"))));
    // Leaving must not strand a hub key the member can still use.
    assert.deepEqual(hubRevoked, ["key-owner-0", "key-guest-1"]);
  }).pipe(
    Effect.provide(
      Broker.layer(":memory:", [
        fakeService({
          serviceId: "hub",
          capabilities: ["key-exchange"],
          minted: hubMinted,
          revoked: hubRevoked,
        }),
      ]),
    ),
  ),
);

it.effect("links a service without key exchange and rejects unknown services", () =>
  Effect.gen(function* () {
    const broker = yield* Broker.Broker;
    const owner = yield* member(broker);
    const link = yield* broker.link(owner.token, { serviceId: "plain" });
    assert.strictEqual(link.credential, null);
    assert.strictEqual(link.serviceId, "plain");
    assert.isTrue(
      Exit.isFailure(yield* Effect.exit(broker.link(owner.token, { serviceId: "missing" }))),
    );
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          broker.link(owner.token, { serviceId: "plain", transport: "tailscale" }),
        ),
      ),
    );
    yield* broker.unlink(owner.token, "missing");
  }).pipe(
    Effect.provide(
      Broker.layer(":memory:", [
        fakeService({ serviceId: "plain", capabilities: [], minted: [], revoked: [] }),
      ]),
    ),
  ),
);
