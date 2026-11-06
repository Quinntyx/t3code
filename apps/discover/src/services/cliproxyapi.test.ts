import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import { makeCliProxyService } from "./cliproxyapi.ts";
import { ServiceError, type DiscoverableService } from "./types.ts";

interface Recorded {
  readonly method: string;
  readonly pathname: string;
  readonly query: string;
  readonly authorization: string | null;
  readonly body: string;
}

const withServer = (
  handler: (request: Recorded, keys: Array<string>) => Response,
  body: (input: {
    readonly service: DiscoverableService;
    readonly calls: ReadonlyArray<Recorded>;
    readonly keys: ReadonlyArray<string>;
  }) => Effect.Effect<void, ServiceError>,
) => {
  const calls: Array<Recorded> = [];
  const keys = ["existing-key"];
  const fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const recorded: Recorded = {
      method: request.method,
      pathname: url.pathname,
      query: url.search,
      authorization: request.headers.get("authorization"),
      body: await request.text(),
    };
    calls.push(recorded);
    return handler(recorded, keys);
  };
  return Effect.gen(function* () {
    const service = yield* makeCliProxyService({
      serviceId: "hub",
      label: "Hub",
      endpoints: [{ transport: "lan", httpBaseUrl: "http://hub.example:8317" }],
      managementKey: "management-secret",
      protocol: "openai",
      basePath: "/v1",
    });
    yield* body({ service, calls, keys });
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        FetchHttpClient.layer,
        Layer.succeed(FetchHttpClient.Fetch, fetch as typeof globalThis.fetch),
      ),
    ),
  );
};

const keyList = (request: Recorded, keys: Array<string>) => {
  if (request.method === "GET") return Response.json({ "api-keys": [...keys] });
  const next = JSON.parse(request.body) as Array<string>;
  keys.splice(0, keys.length, ...next);
  return Response.json({ status: "ok" });
};

it.effect("mints a client key by appending to the existing list", () =>
  withServer(keyList, ({ service, calls, keys }) =>
    Effect.gen(function* () {
      const credential = yield* service.issueCredential(
        { id: "member-1", label: "desktop" },
        undefined,
      );
      assert.strictEqual(credential.protocol, "openai");
      assert.strictEqual(credential.baseUrl, "http://hub.example:8317/v1");
      assert.match(credential.apiKey, /^t3d-/);
      assert.deepEqual(keys, ["existing-key", credential.apiKey]);
      assert.deepEqual(
        calls.map((call) => [call.method, call.pathname]),
        [
          ["GET", "/v0/management/api-keys"],
          ["PUT", "/v0/management/api-keys"],
        ],
      );
      for (const call of calls) assert.strictEqual(call.authorization, "Bearer management-secret");
    }),
  ),
);

it.effect("revokes one key with a single request so a concurrent mint cannot resurrect it", () =>
  withServer(
    (request, keys) => {
      if (request.method !== "DELETE") return keyList(request, keys);
      const value = new URL(
        `http://hub.example${request.pathname}${request.query}`,
      ).searchParams.get("value");
      const index = keys.indexOf(value ?? "");
      if (index < 0) return Response.json({ error: "not found" }, { status: 404 });
      keys.splice(index, 1);
      return Response.json({ status: "ok" });
    },
    ({ service, calls, keys }) =>
      Effect.gen(function* () {
        yield* service.revokeCredential(
          { id: "member-1", label: "desktop" },
          { protocol: "openai", baseUrl: "http://hub.example:8317/v1", apiKey: "existing-key" },
        );
        assert.deepEqual(keys, []);
        yield* service.revokeCredential(
          { id: "member-1", label: "desktop" },
          { protocol: "openai", baseUrl: "http://hub.example:8317/v1", apiKey: "never-there" },
        );
        assert.deepEqual(keys, []);
        assert.deepEqual(
          calls.map((call) => call.method),
          ["DELETE", "DELETE"],
        );
      }),
  ),
);

it.effect("reports a rejected management key instead of inventing a credential", () =>
  withServer(
    () => Response.json({ error: "unauthorized" }, { status: 401 }),
    ({ service }) =>
      Effect.gen(function* () {
        const result = yield* Effect.exit(
          service.issueCredential({ id: "member-1", label: "desktop" }, undefined),
        );
        assert.strictEqual(result._tag, "Failure");
      }),
  ),
);

it.effect("treats any HTTP answer as reachable", () =>
  withServer(
    () => Response.json({ error: "unauthorized" }, { status: 401 }),
    ({ service }) =>
      Effect.gen(function* () {
        assert.strictEqual(yield* service.health, "online");
      }),
  ),
);
