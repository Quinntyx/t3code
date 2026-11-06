import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as Broker from "./Broker.ts";
import { handle } from "./http.ts";

it.effect(
  "uses bearer-only JSON, supports cross-origin preflight and rejects minting and oversized bodies",
  () =>
    Effect.gen(function* () {
      const broker = yield* Broker.Broker;
      const origin = "http://localhost:3775";
      const preflight = yield* handle(
        new Request(`${origin}/api/discover/hosts`, {
          method: "OPTIONS",
          headers: {
            origin: "https://app.t3.codes",
            "access-control-request-headers": "authorization, content-type, b3, traceparent",
          },
        }),
      );
      assert.strictEqual(preflight.status, 200);
      assert.strictEqual(preflight.headers.get("access-control-allow-origin"), "*");
      assert.strictEqual(preflight.headers.get("access-control-allow-credentials"), null);
      for (const header of ["authorization", "content-type", "b3", "traceparent"]) {
        assert.include(
          preflight.headers.get("access-control-allow-headers")?.toLowerCase(),
          header,
        );
      }
      const code = yield* broker.pair();
      const enrolled = yield* handle(
        new Request(`${origin}/api/discover/enroll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code, label: "browser" }),
        }),
      );
      assert.strictEqual(enrolled.status, 200);
      const membership = yield* Effect.promise(() => enrolled.json() as Promise<{ token: string }>);
      for (const headers of [
        { cookie: `token=${membership.token}` },
        { authorization: `Bearer ${code}` },
      ]) {
        assert.strictEqual(
          (yield* handle(new Request(`${origin}/api/discover/hosts`, { headers }))).status,
          401,
        );
      }
      const authenticated = { authorization: `Bearer ${membership.token}` };
      const directory = yield* handle(
        new Request(`${origin}/api/discover/hosts`, { headers: authenticated }),
      );
      assert.strictEqual(directory.status, 200);
      assert.strictEqual(directory.headers.get("cache-control"), "no-store");
      const oversize = yield* handle(
        new Request(`${origin}/api/discover/enroll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: " ".repeat(65537),
        }),
      );
      assert.strictEqual(oversize.status, 413);
      const wrongType = yield* handle(
        new Request(`${origin}/api/discover/enroll`, { method: "POST", body: "{}" }),
      );
      assert.strictEqual(wrongType.status, 415);
      const badJson = yield* handle(
        new Request(`${origin}/api/discover/enroll`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{",
        }),
      );
      assert.strictEqual(badJson.status, 400);
      for (const path of ["/api/discover/pair", "/api/discover/mint"]) {
        const denied = yield* handle(
          new Request(`${origin}${path}`, { method: "POST", headers: authenticated }),
        );
        assert.strictEqual(denied.status, 404);
        assert.strictEqual(denied.headers.get("location"), null);
      }
    }).pipe(Effect.provide(Broker.layer(":memory:"))),
);

it.effect("links services only through the member's own bearer token", () =>
  Effect.gen(function* () {
    const broker = yield* Broker.Broker;
    const origin = "http://localhost:3775";
    const code = yield* broker.pair();
    const enrolled = yield* handle(
      new Request(`${origin}/api/discover/enroll`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code, label: "browser" }),
      }),
    );
    const membership = yield* Effect.promise(() => enrolled.json() as Promise<{ token: string }>);
    const authenticated = { authorization: `Bearer ${membership.token}` };
    const directory = yield* handle(
      new Request(`${origin}/api/discover/hosts`, { headers: authenticated }),
    );
    const body = yield* Effect.promise(
      () => directory.json() as Promise<{ services: ReadonlyArray<{ serviceId: string }> }>,
    );
    assert.deepEqual(body.services, []);
    const missing = yield* handle(
      new Request(`${origin}/api/discover/services/hub/link`, {
        method: "POST",
        headers: { ...authenticated, "content-type": "application/json" },
        body: "{}",
      }),
    );
    assert.strictEqual(missing.status, 404);
    const anonymous = yield* handle(
      new Request(`${origin}/api/discover/services/hub/link`, { method: "GET" }),
    );
    assert.strictEqual(anonymous.status, 401);
  }).pipe(Effect.provide(Broker.layer(":memory:"))),
);
