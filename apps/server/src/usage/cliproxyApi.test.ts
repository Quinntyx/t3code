import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import { makeCliproxyApi } from "./cliproxyApi.ts";
// Bodies the built CLIProxyAPI served for its own Go fixtures (feat/alias-model-routes).
import v8Management from "./testFixtures/cliproxyV8Management.json" with { type: "json" };

const config = {
  kind: "cliproxy",
  url: "http://hub.test:8317",
  managementKey: "management-secret",
  enabled: true,
} as const;
const accounts = [
  {
    id: "first.json",
    auth_index: "a",
    provider: "codex",
    email: "first@example.com",
    id_token: { chatgpt_account_id: "account-a" },
  },
  {
    id: "second.json",
    auth_index: "b",
    provider: "codex",
    email: "second@example.com",
    id_token: { chatgpt_account_id: "account-b" },
  },
];
const credit = (id: string, expires_at = "2099-01-01T00:00:00Z") => ({
  id,
  expires_at,
  status: "available",
  reset_type: "codex_rate_limits",
});
const RequestBody = Schema.Struct({
  auth_index: Schema.String,
  method: Schema.optional(Schema.String),
  url: Schema.optional(Schema.String),
  header: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  data: Schema.optional(Schema.String),
});
type RequestBody = typeof RequestBody.Type;
const decodeRequest = Schema.decodeUnknownSync(Schema.fromJsonString(RequestBody));
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

function fixture(
  options: {
    accounts?: Array<
      (typeof accounts)[number] & {
        disabled?: boolean;
        id_token: { chatgpt_account_id: string; plan_type?: string; chatgpt_plan_type?: string };
      }
    >;
    upstream?: (request: RequestBody) => { status: number; body: unknown };
    cooldownStatus?: number;
    cooldownStatuses?: Record<string, number>;
    authFilesStatus?: number;
    /** Omitted for a hub without v8 discovery, which answers 404. */
    v8?: {
      readonly providersStatus?: number;
      readonly providers: unknown;
      readonly usage: Record<string, unknown>;
      readonly usageStatus?: Record<string, number>;
    };
  } = {},
) {
  const requests: Array<{ path: string; body?: RequestBody }> = [];
  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      expect(request.headers.authorization).toBe("Bearer management-secret");
      const path = new URL(request.url).pathname;
      const body =
        request.body._tag === "Uint8Array"
          ? decodeRequest(new TextDecoder().decode(request.body.body))
          : undefined;
      requests.push({ path, ...(body ? { body } : {}) });
      const v8 = path.match(/\/v8\/management\/providers(?:\/([^/]+)\/usage)?$/);
      if (v8) {
        const usage = v8[1] === undefined ? undefined : decodeURIComponent(v8[1]);
        if (!options.v8)
          return HttpClientResponse.fromWeb(request, Response.json({}, { status: 404 }));
        return HttpClientResponse.fromWeb(
          request,
          usage === undefined
            ? Response.json(options.v8.providers, { status: options.v8.providersStatus ?? 200 })
            : Response.json(options.v8.usage[usage] ?? { error: "unknown provider" }, {
                status: options.v8.usageStatus?.[usage] ?? (usage in options.v8.usage ? 200 : 404),
              }),
        );
      }
      if (path.endsWith("/auth-files"))
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            { files: options.accounts ?? accounts },
            { status: options.authFilesStatus ?? 200 },
          ),
        );
      if (path.endsWith("/reset-quota"))
        return HttpClientResponse.fromWeb(
          request,
          Response.json(
            {},
            {
              status: options.cooldownStatuses?.[body!.auth_index] ?? options.cooldownStatus ?? 200,
            },
          ),
        );
      expect(path).toMatch(/\/v0\/management\/api-call$/);
      expect(body?.header?.Authorization).toBe("Bearer $TOKEN$");
      const upstream = options.upstream?.(body!) ?? {
        status: 200,
        body: body?.url?.endsWith("/consume")
          ? { code: "reset" }
          : body?.url?.endsWith("/rate-limit-reset-credits")
            ? {
                credits: [
                  credit("later", "2099-02-01T00:00:00Z"),
                  credit("first"),
                  credit("expired", "2000-01-01T00:00:00Z"),
                  { ...credit("used"), status: "redeemed" },
                ],
              }
            : {
                plan_type: "pro",
                rate_limit: {
                  secondary_window: {
                    used_percent: 78,
                    reset_at: 4070908800,
                    limit_window_seconds: 604800,
                  },
                },
              },
      };
      return HttpClientResponse.fromWeb(
        request,
        Response.json({ status_code: upstream.status, body: encodeJson(upstream.body) }),
      );
    }),
  );
  return {
    requests,
    api: makeCliproxyApi.pipe(
      Effect.provideService(HttpClient.HttpClient, http),
      Effect.provide(NodeCrypto.layer),
    ),
  };
}

const unreachableHub = (
  fail: (
    request: Parameters<Parameters<typeof HttpClient.make>[0]>[0],
  ) => HttpClientError.HttpClientError,
) =>
  makeCliproxyApi.pipe(
    Effect.provideService(
      HttpClient.HttpClient,
      HttpClient.make((request) => Effect.fail(fail(request))),
    ),
    Effect.provide(NodeCrypto.layer),
  );

describe("CLIProxyAPI hub failures", () => {
  it.effect("names the TLS code when the hub's certificate is not trusted", () =>
    Effect.gen(function* () {
      const api = yield* unreachableHub(
        (request) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              // Node's fetch wraps the TLS error, which carries the code, in a generic TypeError.
              cause: new TypeError("fetch failed", {
                cause: Object.assign(new Error("unable to get local issuer certificate"), {
                  code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
                }),
              }),
            }),
          }),
      );
      const error = yield* Effect.flip(api.readAccounts(config));
      expect(error.detail).toContain("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
      expect(error.detail).toContain("NODE_EXTRA_CA_CERTS");
    }),
  );

  // regression: #18168 Limits hub failures name their TLS, HTTP, or timeout cause
  it.effect("ignores a transport code that is not a short Node error code", () =>
    Effect.gen(function* () {
      const api = yield* unreachableHub(
        (request) =>
          new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request,
              cause: Object.assign(new Error("odd"), { code: "X".repeat(200) }),
            }),
          }),
      );
      const error = yield* Effect.flip(api.readAccounts(config));
      expect(error.detail).toBe("The hub management request failed.");
    }),
  );

  it.effect("names the status, not the body, when the hub rejects the request", () =>
    Effect.gen(function* () {
      const test = HttpClient.make((request) =>
        Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({ error: "management-secret is wrong" }, { status: 401 }),
          ),
        ),
      );
      const api = yield* makeCliproxyApi.pipe(
        Effect.provideService(HttpClient.HttpClient, test),
        Effect.provide(NodeCrypto.layer),
      );
      const error = yield* Effect.flip(api.readAccounts(config));
      expect(error.detail).toContain("401");
      expect(error.detail).not.toContain("management-secret");
    }),
  );
});

describe("CLIProxyAPI built-in management API", () => {
  it.effect(
    "reads both accounts and their earliest unexpired credits without plugin endpoints",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(1788710400000);
        const test = fixture();
        const api = yield* test.api;
        const result = yield* api.readAccounts(config);
        expect(result.map((account) => account.usageLimits.resetCredits)).toEqual([
          { availableCount: 2, nextCreditId: "first", nextExpiresAt: "2099-01-01T00:00:00.000Z" },
          { availableCount: 2, nextCreditId: "first", nextExpiresAt: "2099-01-01T00:00:00.000Z" },
        ]);
        expect(result[0]?.usageLimits.windows).toMatchObject([
          { id: "secondary", usedPercent: 78, kind: "weekly" },
        ]);
        const calls = test.requests.filter((request) => request.body?.url);
        expect(calls.map((request) => request.body?.auth_index).sort()).toEqual([
          "a",
          "a",
          "b",
          "b",
        ]);
        expect(
          calls.find((request) => request.body?.auth_index === "b")?.body?.header?.[
            "Chatgpt-Account-Id"
          ],
        ).toBe("account-b");
      }),
  );

  it.effect("resolves a missing usage plan from current, then legacy, token plans", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [
          { ...accounts[0]!, id_token: { chatgpt_account_id: "account-a", plan_type: "free" } },
          {
            ...accounts[1]!,
            id_token: {
              chatgpt_account_id: "account-b",
              plan_type: "go",
              chatgpt_plan_type: "plus",
            },
          },
          {
            ...accounts[1]!,
            id: "third.json",
            auth_index: "c",
            id_token: { chatgpt_account_id: "account-c", chatgpt_plan_type: "free" },
          },
        ],
        upstream: (request) => ({
          status: 200,
          body: {
            ...(request.auth_index === "a" ? { plan_type: "plus" } : {}),
            rate_limit: { primary_window: { used_percent: 12 } },
          },
        }),
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result.map((account) => [account.plan, account.usageLimits.windows[0]?.kind])).toEqual(
        [
          ["ChatGPT Plus Subscription", "session"],
          ["ChatGPT Go Subscription", "monthly"],
          ["ChatGPT Free Subscription", "monthly"],
        ],
      );
    }),
  );

  it.effect.each([
    "https://tools.test/cliproxy",
    "https://tools.test/cliproxy/",
    "https://tools.test/cliproxy/management.html",
    "https://tools.test/cliproxy/management.html/",
    "https://tools.test/cliproxy/MANAGEMENT.HTML",
    "https://tools.test/cliproxy/management.html?tab=accounts",
    "https://tools.test/cliproxy/management.html#accounts",
    "https://tools.test/cliproxy/management.html/?tab=accounts",
    "https://tools.test/cliproxy/management.html/#accounts",
  ])("keeps the path of a hub served under a prefix: %s", (url) =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      yield* api.readAccounts({ ...config, url });
      expect(test.requests.length).toBeGreaterThan(0);
      expect(test.requests[0]?.path).toBe("/cliproxy/v8/management/providers");
      expect(
        test.requests
          .slice(1)
          .every((request) => request.path.startsWith("/cliproxy/v0/management/")),
      ).toBe(true);
    }),
  );

  it.effect("preserves a hub path that only ends with the panel filename", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      yield* api.readAccounts({ ...config, url: "https://tools.test/team-management.html" });
      expect(test.requests.length).toBeGreaterThan(0);
      expect(
        test.requests.every((request) =>
          /^\/team-management\.html\/v[08]\/management\//.test(request.path),
        ),
      ).toBe(true);
    }),
  );

  it.effect("keeps usage when the credits endpoint fails", () =>
    Effect.gen(function* () {
      const test = fixture({
        upstream: (request) =>
          request.url?.endsWith("rate-limit-reset-credits")
            ? { status: 503, body: { token: "do-not-publish" } }
            : { status: 200, body: { rate_limit: { primary_window: { used_percent: 12 } } } },
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.usageLimits.windows[0]?.usedPercent).toBe(12);
      expect(result[0]?.usageLimits.resetCredits).toBeUndefined();
    }),
  );

  it.effect("isolates a failed account and never publishes upstream error bodies", () =>
    Effect.gen(function* () {
      const test = fixture({
        upstream: (request) =>
          request.auth_index === "a"
            ? { status: 401, body: { token: "do-not-publish" } }
            : {
                status: 200,
                body: request.url?.endsWith("rate-limit-reset-credits")
                  ? { credits: [] }
                  : { rate_limit: { primary_window: { used_percent: 12 } } },
              },
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(result[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(result[1]?.usageLimits.windows[0]?.usedPercent).toBe(12);
      expect(encodeJson(result)).not.toContain("do-not-publish");
    }),
  );

  it.effect("maps Claude scoped windows without a scheduler plugin", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [{ ...accounts[0]!, provider: "claude" }],
        // The usage endpoint answers 429 to requests without a Claude Code user agent.
        upstream: (request) => ({
          status: request.header?.["User-Agent"]?.startsWith("claude-code/") ? 200 : 429,
          body: {
            five_hour: { utilization: 10, resets_at: null },
            seven_day: { utilization: 50, resets_at: "2099-01-01T00:00:00Z" },
            limits: [
              {
                kind: "weekly_scoped",
                percent: 80,
                resets_at: null,
                scope: { model: { display_name: "Fable" } },
              },
            ],
          },
        }),
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(
        result[0]?.usageLimits.windows.map((window) => [window.id, window.usedPercent]),
      ).toEqual([
        ["five_hour", 10],
        ["seven_day", 50],
        ["seven_day_fable", 80],
      ]);
    }),
  );

  it.effect.each([
    {
      name: "spend budget",
      budget: {
        spend: {
          enabled: true,
          used: { amount_minor: 4_631, currency: "USD", exponent: 2 },
          limit: { amount_minor: 50_000, currency: "USD", exponent: 2 },
        },
      },
    },
    {
      name: "extra usage",
      budget: {
        extra_usage: {
          is_enabled: true,
          used_credits: 4_631,
          monthly_limit: 50_000,
          utilization: 9,
        },
      },
    },
  ])("keeps Claude monthly spend from $name beside rolling windows", ({ budget }) =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [{ ...accounts[0]!, provider: "claude" }],
        upstream: () => ({
          status: 200,
          body: { five_hour: { utilization: 10, resets_at: null }, ...budget },
        }),
      });
      const result = yield* (yield* test.api).readAccounts(config);
      expect(
        result[0]?.usageLimits.windows.map((window) => [window.id, window.usedPercent]),
      ).toEqual([
        ["five_hour", 10],
        ["monthly_spend", expect.closeTo(9.262, 10)],
      ]);
    }),
  );

  it.effect("omits disabled Claude budgets without losing rolling windows", () =>
    Effect.gen(function* () {
      const test = fixture({
        accounts: [{ ...accounts[0]!, provider: "claude" }],
        upstream: () => ({
          status: 200,
          body: {
            five_hour: { utilization: 10, resets_at: null },
            spend: { enabled: false, used: null, limit: null },
            extra_usage: {
              is_enabled: false,
              used_credits: null,
              monthly_limit: null,
              utilization: null,
            },
          },
        }),
      });
      const result = yield* (yield* test.api).readAccounts(config);
      expect(result[0]?.usageLimits.windows.map((window) => window.id)).toEqual(["five_hour"]);
    }),
  );

  it.effect("pins redemption to the displayed credit and clears only that account's cooldown", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      expect(yield* api.consume(config, "second.json", "credit-b")).toEqual({ outcome: "reset" });
      expect(yield* api.consume(config, "second.json", "credit-b")).toEqual({ outcome: "reset" });
      const redemptions = test.requests.filter((request) =>
        request.body?.url?.endsWith("/consume"),
      );
      expect(redemptions).toHaveLength(2);
      expect(redemptions[0]?.body?.data).toBe(redemptions[1]?.body?.data);
      expect(redemptions[0]?.body?.data).toBe(
        encodeJson({
          redeem_request_id: "519d5243-011a-5b7b-91f3-44d85f095705",
          credit_id: "credit-b",
        }),
      );
      expect(
        test.requests
          .filter((request) => request.path.endsWith("/reset-quota"))
          .map((request) => request.body?.auth_index),
      ).toEqual(["b", "b"]);
    }),
  );

  it.effect(
    "clears matching Codex accounts after a native redemption without consuming again",
    () =>
      Effect.gen(function* () {
        for (const status of [200, 404]) {
          const test = fixture({
            accounts: [
              ...accounts,
              { ...accounts[1]!, id: "alias.json", auth_index: "alias" },
              { ...accounts[1]!, id: "disabled.json", auth_index: "disabled", disabled: true },
              { ...accounts[1]!, id: "claude.json", auth_index: "claude", provider: "claude" },
            ],
            cooldownStatuses: { b: status },
          });
          const api = yield* test.api;
          const result = yield* api.clearAccountCooldowns(config, "account-b").pipe(Effect.result);
          expect(result._tag).toBe(status === 200 ? "Success" : "Failure");
          expect(test.requests).toEqual([
            { path: "/v0/management/auth-files" },
            { path: "/v0/management/reset-quota", body: { auth_index: "b" } },
            { path: "/v0/management/reset-quota", body: { auth_index: "alias" } },
          ]);
          test.requests.length = 0;
          yield* api.clearAccountCooldowns(config, "unknown-account");
          expect(test.requests).toEqual([{ path: "/v0/management/auth-files" }]);
        }
      }),
  );

  it.effect("reports redemption success even if cooldown clearing fails", () =>
    Effect.gen(function* () {
      const api = yield* fixture({ cooldownStatus: 404 }).api;
      const result = yield* api.consume(config, "first.json", "credit");
      expect(result.outcome).toBe("reset");
      expect(result.warning).toContain("cooldown");
    }),
  );

  it.effect("skips disabled accounts and rejects redemption on them", () =>
    Effect.gen(function* () {
      const test = fixture({ accounts: [{ ...accounts[0]!, disabled: true }] });
      const api = yield* test.api;
      expect(yield* api.readAccounts(config)).toEqual([]);
      expect((yield* api.consume(config, "first.json", "credit").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(
        test.requests.every(
          (request) =>
            request.path.endsWith("/auth-files") || request.path === "/v8/management/providers",
        ),
      ).toBe(true);
    }),
  );

  it.effect("keeps the same redemption id after an uncertain upstream failure", () =>
    Effect.gen(function* () {
      let attempts = 0;
      const test = fixture({
        upstream: () =>
          ++attempts === 1
            ? { status: 503, body: {} }
            : { status: 200, body: { code: "already_redeemed" } },
      });
      const api = yield* test.api;
      expect((yield* api.consume(config, "first.json", "credit").pipe(Effect.result))._tag).toBe(
        "Failure",
      );
      expect(yield* api.consume(config, "first.json", "credit")).toEqual({
        outcome: "alreadyRedeemed",
      });
      const data = test.requests
        .filter((request) => request.body?.url?.endsWith("/consume"))
        .map((request) => request.body?.data);
      expect(data[0]).toBe(data[1]);
      expect(test.requests.filter((request) => request.path.endsWith("/reset-quota"))).toHaveLength(
        1,
      );
    }),
  );

  it.effect("rejects unknown accounts without forwarding a redemption", () =>
    Effect.gen(function* () {
      const test = fixture();
      const api = yield* test.api;
      const result = yield* api.consume(config, "missing.json", "credit").pipe(Effect.result);
      expect(result._tag).toBe("Failure");
      expect(test.requests).toHaveLength(1);
    }),
  );
});

describe("CLIProxyAPI v8 provider discovery", () => {
  const codexProvider = {
    id: "codex",
    name: "Codex",
    disabled: false,
    model_ids: ["gpt-6.1-sol"],
    usage_supported: true,
  };
  const disabledProvider = {
    id: "bitdeer",
    name: "bitdeer",
    disabled: true,
    model_ids: [],
    usage_supported: true,
  };
  const v8 = {
    providers: {
      providers: [...v8Management.providers.providers, codexProvider, disabledProvider],
    },
    usage: v8Management.usage,
  };

  it.effect("reads every enabled hub provider and keeps unknown allowances out of the bars", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(1788710400000);
      const test = fixture({ v8 });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      const byId = new Map(result.map((account) => [account.id, account]));

      expect(
        test.requests.map((request) => request.path).filter((path) => path.includes("/v8/")),
      ).toEqual([
        "/v8/management/providers",
        "/v8/management/providers/mistral/usage",
        "/v8/management/providers/opencode-go/usage",
        "/v8/management/providers/openrouter/usage",
      ]);
      expect(byId.get("mistral:a795820cc0757f8a")).toEqual({
        id: "mistral:a795820cc0757f8a",
        driver: "mistral",
        label: "mistral",
        plan: "Pro",
        usageLimits: {
          checkedAt: "2026-11-14T04:04:28.000Z",
          windows: [
            {
              id: "vibe",
              kind: "other",
              label: "Vibe",
              usedPercent: 40,
              resetsAt: "2026-12-01T00:00:00.000Z",
            },
            {
              id: "api",
              kind: "other",
              label: "API",
              usedPercent: 25,
              resetsAt: "2026-12-01T00:00:00.000Z",
            },
          ],
        },
      });
      expect(
        byId
          .get("opencode-go:a66e73f8b1866a2b")
          ?.usageLimits.windows.map((window) => [window.id, window.kind, window.usedPercent]),
      ).toEqual([
        ["rolling", "session", 12.5],
        ["weekly", "weekly", 50],
        ["monthly", "monthly", 75],
      ]);
      // OpenRouter reports spend with no cap: no bar, never 0% or unlimited.
      expect(byId.get("openrouter:2982a7cb4bdfb064")?.usageLimits).toMatchObject({
        windows: [],
        unavailable: { reason: "unsupported" },
      });
      expect(byId.get("openrouter:0e843b7e13496218")?.usageLimits).toMatchObject({
        windows: [],
        unavailable: { reason: "probeFailed", message: "usage endpoint returned HTTP 401" },
      });
      expect(
        [...byId.keys()].some((id) => id.startsWith("inco:") || id.startsWith("bitdeer:")),
      ).toBe(false);
      // Codex keeps its native reader, so reset credits stay redeemable.
      expect(byId.get("first.json")).toMatchObject({
        driver: "codex",
        email: "first@example.com",
        usageLimits: { resetCredits: { availableCount: 2, nextCreditId: "first" } },
      });
    }),
  );

  it.effect.each([401, 403, 500])(
    "reports a HTTP %i provider list instead of falling back to the legacy reader",
    (status) =>
      Effect.gen(function* () {
        const test = fixture({ v8: { ...v8, providersStatus: status } });
        const api = yield* test.api;
        const error = yield* Effect.flip(api.readAccounts(config));
        expect(error.detail).toBe(`The hub answered with HTTP ${status}.`);
        expect(test.requests.map((request) => request.path)).toEqual(["/v8/management/providers"]);
      }),
  );

  it.effect("isolates a provider whose usage read fails without publishing its body", () =>
    Effect.gen(function* () {
      const test = fixture({
        v8: {
          ...v8,
          usage: { ...v8.usage, mistral: { token: "sk-do-not-publish" } },
          usageStatus: { mistral: 502 },
        },
        authFilesStatus: 500,
      });
      const api = yield* test.api;
      const result = yield* api.readAccounts(config);
      expect(JSON.stringify(result)).not.toContain("sk-do-not-publish");
      expect(result.find((account) => account.id === "mistral")?.usageLimits).toMatchObject({
        windows: [],
        unavailable: { reason: "probeFailed" },
      });
      expect(
        result.find((account) => account.id === "opencode-go:a66e73f8b1866a2b")?.usageLimits
          .windows,
      ).toHaveLength(3);
      // Without the native account list, Codex still reads through the hub's own adapter.
      expect(test.requests.map((request) => request.path)).toContain(
        "/v8/management/providers/codex/usage",
      );
    }),
  );
});
