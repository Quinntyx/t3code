import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

import { readOpenCodeGoUsage } from "./opencodeGoUsage.ts";

const checkedAt = "2026-10-29T05:00:00.000Z";

const usageBody = (percent: number) => ({
  usage: {
    rolling: { percent, resetsAt: "2026-10-29T06:19:00.000Z" },
    weekly: { percent: 81, resetsAt: "2026-11-05T00:00:00.000Z" },
    monthly: { percent: 83, resetsAt: "2026-11-30T00:00:00.000Z" },
  },
});

/** Answers each request from the authorization header it carried. */
const zenClient = (
  answer: (authorization: string | null) => { readonly status: number; readonly body?: unknown },
) =>
  HttpClient.make((request) =>
    Effect.sync(() => {
      const result = answer(new Headers(request.headers).get("authorization"));
      return HttpClientResponse.fromWeb(
        request,
        Response.json(result.body ?? {}, { status: result.status }),
      );
    }),
  );

const read = (input: {
  readonly apiKey: string;
  readonly fallbackApiKey?: string;
  readonly client: HttpClient.HttpClient;
}) =>
  Effect.gen(function* () {
    const result = yield* readOpenCodeGoUsage({
      apiKey: input.apiKey,
      fallbackApiKey: input.fallbackApiKey,
      checkedAt,
    });
    return result;
  }).pipe(
    Effect.provideService(HttpClient.HttpClient, input.client),
    Effect.provide(NodeCrypto.layer),
  );

describe("OpenCode Go usage", () => {
  it.effect("reports session, weekly, and monthly windows from the Zen usage endpoint", () =>
    Effect.gen(function* () {
      const result = yield* read({
        apiKey: "oc_sk_session",
        client: zenClient(() => ({ status: 200, body: usageBody(7) })),
      });
      assert.strictEqual(result._tag, "limits");
      const limits = result._tag === "limits" ? result.limits : undefined;
      assert.deepStrictEqual(
        limits?.windows.map((window) => [window.id, window.kind, window.usedPercent]),
        [
          ["go_rolling", "session", 7],
          ["go_weekly", "weekly", 81],
          ["go_monthly", "monthly", 83],
        ],
      );
      assert.strictEqual(limits?.windows[0]?.resetsAt, "2026-10-29T06:19:00.000Z");
      assert.strictEqual(limits?.checkedAt, checkedAt);
      assert.isString(limits?.credentialFingerprint);
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("clamps percentages that drift outside the 0-100 range", () =>
    Effect.gen(function* () {
      const result = yield* read({
        apiKey: "oc_sk_session",
        client: zenClient(() => ({ status: 200, body: usageBody(140) })),
      });
      assert.strictEqual(result._tag, "limits");
      assert.strictEqual(
        result._tag === "limits" ? result.limits.windows[0]?.usedPercent : undefined,
        100,
      );
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("retries with the stored Go key when the Console key is rejected", () =>
    Effect.gen(function* () {
      const seen: Array<string | null> = [];
      const result = yield* read({
        apiKey: "console_key",
        fallbackApiKey: "oc_sk_stored",
        client: zenClient((authorization) => {
          seen.push(authorization);
          return authorization === "Bearer oc_sk_stored"
            ? { status: 200, body: usageBody(12) }
            : { status: 401, body: { code: "api_key_expired" } };
        }),
      });
      assert.deepStrictEqual(seen, ["Bearer console_key", "Bearer oc_sk_stored"]);
      assert.strictEqual(result._tag, "limits");
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("reports no subscription when a valid key has no Go allowance", () =>
    Effect.gen(function* () {
      const result = yield* read({
        apiKey: "oc_sk_zen_only",
        client: zenClient(() => ({ status: 403, body: { error: "forbidden" } })),
      });
      assert.strictEqual(result._tag, "noSubscription");
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );

  it.effect("reports failure when the endpoint errors", () =>
    Effect.gen(function* () {
      const result = yield* read({
        apiKey: "oc_sk_session",
        client: zenClient(() => ({ status: 500 })),
      });
      assert.strictEqual(result._tag, "failed");
    }).pipe(Effect.provide(NodeCrypto.layer)),
  );
});
