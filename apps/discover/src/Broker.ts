// @effect-diagnostics-next-line nodeBuiltinImport:off -- Synchronous cryptography keeps token generation inside the SQLite transaction.
import * as NodeCrypto from "node:crypto";

import * as Discover from "@t3tools/contracts/discover";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";

export class BrokerError extends Schema.TaggedError<BrokerError>()("BrokerError", {
  status: Schema.Int,
  message: Schema.String,
}) {}

export class DatabaseError extends Schema.TaggedError<DatabaseError>()("DatabaseError", {
  cause: Schema.Defect(),
}) {
  override get message() {
    return "Broker storage unavailable.";
  }
}

type Failure = BrokerError | DatabaseError;
type Enrollment = typeof Discover.DiscoverEnrollmentInput.Type;
type RequestInput = typeof Discover.DiscoverPairingRequestInput.Type;
type Completion = Exclude<Discover.DiscoverPairingResult, { status: "pending" }>;

export class Broker extends Context.Service<
  Broker,
  {
    readonly pair: () => Effect.Effect<string, Failure>;
    readonly members: () => Effect.Effect<ReadonlyArray<{ id: string; label: string }>, Failure>;
    readonly revoke: (memberId: string) => Effect.Effect<void, Failure>;
    readonly enroll: (input: Enrollment) => Effect.Effect<Discover.DiscoverMembership, Failure>;
    readonly directory: (
      token: string,
    ) => Effect.Effect<typeof Discover.DiscoverDirectory.Type, Failure>;
    readonly enrollHost: (
      token: string,
      input: Discover.DiscoverHostRegistration,
    ) => Effect.Effect<typeof Discover.DiscoverHostGrant.Type, Failure>;
    readonly heartbeat: (
      token: string,
      input: Discover.DiscoverHostRegistration,
    ) => Effect.Effect<void, Failure>;
    readonly work: (token: string) => Effect.Effect<typeof Discover.DiscoverWork.Type, Failure>;
    readonly request: (
      token: string,
      input: RequestInput,
    ) => Effect.Effect<Discover.DiscoverPairingRequest, Failure>;
    readonly result: (
      token: string,
      id: string,
    ) => Effect.Effect<Discover.DiscoverPairingResult, Failure>;
    readonly complete: (
      token: string,
      id: string,
      input: Completion,
    ) => Effect.Effect<void, Failure>;
    readonly leave: (token: string) => Effect.Effect<void, Failure>;
    readonly unregister: (token: string) => Effect.Effect<void, Failure>;
  }
>()("t3discover/Broker") {}

const hash = (value: string) => NodeCrypto.createHash("sha256").update(value).digest("hex");
const secret = () => NodeCrypto.randomBytes(32).toString("base64url");
const reject = (status: number, message: string) => new BrokerError({ status, message });
const unavailable = { status: "failed", error: "Request unavailable." } as const;
const requestLifetime = 120_000;
const jsonRegistration = Schema.fromJsonString(Discover.DiscoverHostRegistration);
const jsonResult = Schema.fromJsonString(Discover.DiscoverPairingResult);

const validUrl = (value: string, endpoint = false) => {
  try {
    const url = new URL(value);
    return (
      value.length <= 8192 &&
      (url.protocol === "http:" || url.protocol === "https:") &&
      !url.username &&
      !url.password &&
      (!endpoint || (!url.search && !url.hash))
    );
  } catch {
    return false;
  }
};

const validateRegistration = (input: Discover.DiscoverHostRegistration) => {
  if (
    input.endpoints.length < 1 ||
    input.endpoints.length > 4 ||
    input.descriptor.label.length > 256 ||
    input.descriptor.environmentId.length > 256 ||
    input.endpoints.some((endpoint) => !validUrl(endpoint.httpBaseUrl, true))
  ) {
    return Effect.fail(reject(400, "Invalid host registration."));
  }
  return Effect.void;
};

interface HostRow {
  environment_id: string;
  owner_id: string;
  registration: string;
  last_seen_at: number;
}
interface RequestRow {
  id: string;
  requester_id: string;
  environment_id: string;
  transport: Discover.DiscoverTransport;
  expires_at: number;
  result: string | null;
}
const toRequest = (row: RequestRow): Discover.DiscoverPairingRequest => ({
  requestId: row.id,
  environmentId: row.environment_id as Discover.DiscoverPairingRequest["environmentId"],
  transport: row.transport,
  expiresAt: row.expires_at,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`PRAGMA busy_timeout = 5000`;
  yield* sql`PRAGMA foreign_keys = ON`;
  yield* sql`PRAGMA journal_mode = WAL`;
  yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`CREATE TABLE IF NOT EXISTS directory (id TEXT PRIMARY KEY)`;
      yield* sql`INSERT INTO directory (id) SELECT ${NodeCrypto.randomUUID()} WHERE NOT EXISTS (SELECT 1 FROM directory)`;
      yield* sql`CREATE TABLE IF NOT EXISTS enrollment_codes (hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)`;
      yield* sql`CREATE INDEX IF NOT EXISTS codes_expiry ON enrollment_codes(expires_at)`;
      yield* sql`CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, label TEXT NOT NULL, token_hash TEXT NOT NULL UNIQUE)`;
      yield* sql`CREATE TABLE IF NOT EXISTS hosts (
      environment_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      token_hash TEXT UNIQUE, registration TEXT NOT NULL, last_seen_at INTEGER NOT NULL)`;
      yield* sql`CREATE INDEX IF NOT EXISTS hosts_owner ON hosts(owner_id)`;
      yield* sql`CREATE TABLE IF NOT EXISTS requests (
      id TEXT PRIMARY KEY, requester_id TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
      environment_id TEXT NOT NULL REFERENCES hosts(environment_id) ON DELETE CASCADE,
      transport TEXT NOT NULL, expires_at INTEGER NOT NULL, result TEXT)`;
      yield* sql`CREATE INDEX IF NOT EXISTS requests_expiry ON requests(expires_at)`;
      yield* sql`CREATE INDEX IF NOT EXISTS requests_host ON requests(environment_id, expires_at)`;
      yield* sql`CREATE INDEX IF NOT EXISTS requests_member ON requests(requester_id, expires_at)`;
    }),
  );

  const cleanup = Effect.fn("Discover.cleanup")(function* (now: number) {
    yield* sql`DELETE FROM enrollment_codes WHERE hash IN (SELECT hash FROM enrollment_codes WHERE expires_at <= ${now} LIMIT 256)`;
    yield* sql`DELETE FROM requests WHERE id IN (SELECT id FROM requests WHERE expires_at <= ${now} LIMIT 256)`;
  });
  const authenticateMember = Effect.fn("Discover.authenticateMember")(function* (token: string) {
    const rows = yield* sql<{
      id: string;
    }>`SELECT id FROM members WHERE token_hash = ${hash(token)}`;
    if (!rows[0]) return yield* reject(401, "Member authorization required.");
    return rows[0].id;
  });
  const authenticateHost = Effect.fn("Discover.authenticateHost")(function* (token: string) {
    const rows = yield* sql<HostRow>`SELECT * FROM hosts WHERE token_hash = ${hash(token)}`;
    if (!rows[0]) return yield* reject(401, "Host authorization required.");
    return rows[0];
  });
  const transaction = <A, R>(effect: Effect.Effect<A, Failure | SqlError, R>) =>
    sql
      .withTransaction(effect)
      .pipe(Effect.catchTags({ SqlError: (cause) => Effect.fail(new DatabaseError({ cause })) }));

  const pair = Effect.fn("Discover.pair")(function* () {
    const now = yield* Clock.currentTimeMillis;
    yield* cleanup(now);
    const codes = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM enrollment_codes`;
    if (codes[0]!.count >= 100) return yield* reject(429, "Too many enrollment codes.");
    const code = secret();
    yield* sql`INSERT INTO enrollment_codes VALUES (${hash(code)}, ${now + 300_000})`;
    return code;
  }, transaction);
  const enroll = Effect.fn("Discover.enroll")(function* (input: Enrollment) {
    if (!input.label.trim() || input.label.length > 256 || input.code.length > 256) {
      return yield* reject(400, "Invalid enrollment.");
    }
    const now = yield* Clock.currentTimeMillis;
    yield* cleanup(now);
    const used =
      yield* sql`DELETE FROM enrollment_codes WHERE hash = ${hash(input.code)} AND expires_at > ${now} RETURNING hash`;
    if (used.length !== 1) return yield* reject(401, "Enrollment code invalid or expired.");
    const count = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM members`;
    if (count[0]!.count >= 1024) return yield* reject(429, "Directory member limit reached.");
    const memberId = NodeCrypto.randomUUID();
    const token = secret();
    const label = input.label.trim();
    yield* sql`INSERT INTO members VALUES (${memberId}, ${label}, ${hash(token)})`;
    const directory = yield* sql<{ id: string }>`SELECT id FROM directory`;
    return { directoryId: directory[0]!.id, label: "T3 Discover", memberId, token };
  }, transaction);
  const directory = Effect.fn("Discover.directory")(function* (token: string) {
    yield* authenticateMember(token);
    yield* cleanup(yield* Clock.currentTimeMillis);
    const rows =
      yield* sql<HostRow>`SELECT * FROM hosts WHERE token_hash IS NOT NULL ORDER BY environment_id LIMIT 1024`;
    const hosts = yield* Effect.forEach(rows, (row) =>
      Schema.decodeEffect(jsonRegistration)(row.registration).pipe(
        Effect.map((registration) => ({ ...registration, lastSeenAt: row.last_seen_at })),
        Effect.mapError((cause) => new DatabaseError({ cause })),
      ),
    );
    return { hosts };
  }, transaction);
  const enrollHost = Effect.fn("Discover.enrollHost")(function* (
    token: string,
    input: Discover.DiscoverHostRegistration,
  ) {
    const owner = yield* authenticateMember(token);
    yield* validateRegistration(input);
    const id = input.descriptor.environmentId;
    const existing = yield* sql<HostRow>`SELECT * FROM hosts WHERE environment_id = ${id}`;
    if (existing[0] && existing[0].owner_id !== owner)
      return yield* reject(403, "Environment belongs to another member.");
    if (!existing[0]) {
      const count = yield* sql<{ count: number }>`SELECT COUNT(*) AS count FROM hosts`;
      if (count[0]!.count >= 1024) return yield* reject(429, "Directory host limit reached.");
    }
    const now = yield* Clock.currentTimeMillis;
    yield* cleanup(now);
    const hostToken = secret();
    const encoded = yield* Schema.encodeEffect(jsonRegistration)(input).pipe(
      Effect.mapError((cause) => new DatabaseError({ cause })),
    );
    yield* sql`DELETE FROM requests WHERE environment_id = ${id}`;
    yield* sql`INSERT INTO hosts VALUES (${id}, ${owner}, ${hash(hostToken)}, ${encoded}, ${now})
      ON CONFLICT(environment_id) DO UPDATE SET token_hash = excluded.token_hash, registration = excluded.registration, last_seen_at = excluded.last_seen_at`;
    return { hostToken };
  }, transaction);
  const heartbeat = Effect.fn("Discover.heartbeat")(function* (
    token: string,
    input: Discover.DiscoverHostRegistration,
  ) {
    const host = yield* authenticateHost(token);
    yield* validateRegistration(input);
    if (input.descriptor.environmentId !== host.environment_id)
      return yield* reject(403, "Environment mismatch.");
    const now = yield* Clock.currentTimeMillis;
    yield* cleanup(now);
    const encoded = yield* Schema.encodeEffect(jsonRegistration)(input).pipe(
      Effect.mapError((cause) => new DatabaseError({ cause })),
    );
    yield* sql`UPDATE hosts SET registration = ${encoded}, last_seen_at = ${now} WHERE environment_id = ${host.environment_id}`;
  }, transaction);
  const work = Effect.fn("Discover.work")(function* (token: string) {
    const host = yield* authenticateHost(token);
    const now = yield* Clock.currentTimeMillis;
    yield* cleanup(now);
    const rows =
      yield* sql<RequestRow>`SELECT * FROM requests WHERE environment_id = ${host.environment_id} AND expires_at > ${now} AND result IS NULL ORDER BY expires_at, id LIMIT 32`;
    return { requests: rows.map(toRequest) };
  }, transaction);
  const request = Effect.fn("Discover.request")(function* (token: string, input: RequestInput) {
    const requester = yield* authenticateMember(token);
    const now = yield* Clock.currentTimeMillis;
    yield* cleanup(now);
    const hosts =
      yield* sql<HostRow>`SELECT * FROM hosts WHERE environment_id = ${input.environmentId} AND token_hash IS NOT NULL`;
    if (!hosts[0]) return yield* reject(404, "Environment unavailable.");
    const registration = yield* Schema.decodeEffect(jsonRegistration)(hosts[0].registration).pipe(
      Effect.mapError((cause) => new DatabaseError({ cause })),
    );
    if (!registration.endpoints.some((endpoint) => endpoint.transport === input.transport))
      return yield* reject(400, "Transport unavailable.");
    const counts = yield* sql<{ member_count: number; host_count: number }>`SELECT
      (SELECT COUNT(*) FROM requests WHERE requester_id = ${requester}) AS member_count,
      (SELECT COUNT(*) FROM requests WHERE environment_id = ${input.environmentId}) AS host_count`;
    if (counts[0]!.member_count >= 32 || counts[0]!.host_count >= 64)
      return yield* reject(429, "Too many pairing requests.");
    const id = NodeCrypto.randomUUID();
    const expiresAt = now + requestLifetime;
    yield* sql`INSERT INTO requests VALUES (${id}, ${requester}, ${input.environmentId}, ${input.transport}, ${expiresAt}, NULL)`;
    return {
      requestId: id,
      environmentId: input.environmentId,
      transport: input.transport,
      expiresAt,
    };
  }, transaction);
  const result = Effect.fn("Discover.result")(function* (token: string, id: string) {
    const requester = yield* authenticateMember(token);
    const now = yield* Clock.currentTimeMillis;
    yield* cleanup(now);
    const rows =
      yield* sql<RequestRow>`SELECT * FROM requests WHERE id = ${id} AND expires_at > ${now}`;
    if (!rows[0]) return unavailable;
    const row = rows[0];
    if (row.requester_id !== requester)
      return yield* reject(403, "Request belongs to another member.");
    if (row.result === null) return { status: "pending" as const };
    const value = yield* Schema.decodeEffect(jsonResult)(row.result).pipe(
      Effect.mapError((cause) => new DatabaseError({ cause })),
    );
    yield* sql`DELETE FROM requests WHERE id = ${id}`;
    return value.status === "ready" && value.expiresAt <= now ? unavailable : value;
  }, transaction);
  const complete = Effect.fn("Discover.complete")(function* (
    token: string,
    id: string,
    input: Completion,
  ) {
    const host = yield* authenticateHost(token);
    const now = yield* Clock.currentTimeMillis;
    yield* cleanup(now);
    const rows =
      yield* sql<RequestRow>`SELECT * FROM requests WHERE id = ${id} AND expires_at > ${now}`;
    const row = rows[0];
    if (!row) return yield* reject(404, "Request unavailable.");
    if (row.environment_id !== host.environment_id)
      return yield* reject(403, "Request belongs to another host.");
    if (row.result !== null) return yield* reject(409, "Request already completed.");
    if (
      input.status === "ready" &&
      (!validUrl(input.pairingUrl) ||
        !Number.isFinite(input.expiresAt) ||
        input.expiresAt > row.expires_at ||
        input.expiresAt <= now)
    )
      return yield* reject(400, "Invalid pairing result.");
    if (input.status === "failed" && input.error.length > 1024)
      return yield* reject(400, "Invalid pairing result.");
    const encoded = yield* Schema.encodeEffect(jsonResult)(input).pipe(
      Effect.mapError((cause) => new DatabaseError({ cause })),
    );
    yield* sql`UPDATE requests SET result = ${encoded} WHERE id = ${id}`;
  }, transaction);
  const leave = Effect.fn("Discover.leave")(function* (token: string) {
    const member = yield* authenticateMember(token);
    yield* sql`DELETE FROM members WHERE id = ${member}`;
  }, transaction);
  const unregister = Effect.fn("Discover.unregister")(function* (token: string) {
    const host = yield* authenticateHost(token);
    yield* sql`DELETE FROM requests WHERE environment_id = ${host.environment_id}`;
    yield* sql`UPDATE hosts SET token_hash = NULL WHERE environment_id = ${host.environment_id}`;
  }, transaction);
  const members = Effect.fn("Discover.members")(function* () {
    return yield* sql<{
      id: string;
      label: string;
    }>`SELECT id, label FROM members ORDER BY label, id`;
  }, transaction);
  const revoke = Effect.fn("Discover.revoke")(function* (memberId: string) {
    yield* sql`DELETE FROM members WHERE id = ${memberId}`;
  }, transaction);
  return Broker.of({
    pair,
    members,
    revoke,
    enroll,
    directory,
    enrollHost,
    heartbeat,
    work,
    request,
    result,
    complete,
    leave,
    unregister,
  });
});

export const layer = (filename: string) =>
  Layer.effect(Broker, make).pipe(Layer.provideMerge(NodeSqliteClient.layer({ filename })));
