import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  SecretProviderId,
  ServerConfigStreamEvent,
  UsageLimitSourceId,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse } from "effect/http";

import * as BackgroundPolicy from "../background/BackgroundPolicy.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as UsageLimitSources from "./UsageLimitSources.ts";

const encodeConfigEvent = Schema.encodeSync(ServerConfigStreamEvent);
const layerSecrets = (keys: Record<string, string> = {}) =>
  Layer.succeed(SecretResolver.SecretResolver, {
    label: (provider) => Effect.succeed(provider),
    read: (references) => Effect.succeed(references.map((entry) => keys[entry.reference])),
    invalidate: () => Effect.void,
  });

it.effect("notifies enabled hubs after native resets and preserves success on hub failures", () =>
  Effect.gen(function* () {
    for (const failHub of [false, true]) {
      const resets: string[] = [];
      const config = (host: string, enabled = true) => ({
        kind: "cliproxy" as const,
        url: `https://${host}`,
        managementKey: "secret",
        enabled,
      });
      yield* Effect.gen(function* () {
        const sources = yield* UsageLimitSources.make;
        yield* sources.refresh;
        const provider = {
          driver: ProviderDriverKind.make("codex"),
          auth: { status: "authenticated" as const, workspaceId: "account-a" },
        };
        for (const outcome of ["reset", "alreadyRedeemed", "nothingToReset", "noCredit"] as const) {
          const result = yield* sources.notifyResetCreditConsumed(provider, outcome);
          expect(result.outcome).toBe(outcome);
          expect(Boolean(result.warning)).toBe(
            failHub && (outcome === "reset" || outcome === "alreadyRedeemed"),
          );
        }
        yield* sources.notifyResetCreditConsumed(
          { ...provider, auth: { status: "unknown" } },
          "reset",
        );
        yield* sources.notifyResetCreditConsumed(
          { ...provider, driver: ProviderDriverKind.make("claudeAgent") },
          "reset",
        );
        expect(resets).toEqual(["first.test", "second.test", "first.test", "second.test"]);
      }).pipe(
        Effect.provide([
          layerSecrets({ "cliproxy#key": "secret" }),
          ServerSettings.layerTest({
            usageLimitSources: {
              [UsageLimitSourceId.make("first")]: config("first.test"),
              // A key kept in a secret provider still clears that hub's cooldowns.
              [UsageLimitSourceId.make("second")]: {
                ...config("second.test"),
                managementKey: {
                  provider: SecretProviderId.make("homelab"),
                  reference: "cliproxy#key",
                },
              },
              [UsageLimitSourceId.make("disabled")]: config("disabled.test", false),
              [UsageLimitSourceId.make("unconfigured")]: {
                ...config("unconfigured.test"),
                managementKey: "",
              },
            },
          }),
          Layer.mock(BackgroundPolicy.BackgroundPolicy)({
            shouldRunScopeWork: () => Effect.succeed(false),
          }),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.sync(() => {
                const url = new URL(request.url);
                if (url.pathname.startsWith("/v8/")) {
                  return HttpClientResponse.fromWeb(request, Response.json({}, { status: 404 }));
                }
                if (url.pathname.endsWith("/auth-files")) {
                  return HttpClientResponse.fromWeb(
                    request,
                    Response.json({
                      files: [
                        {
                          id: "account.json",
                          auth_index: "a",
                          provider: "codex",
                          id_token: { chatgpt_account_id: "account-a" },
                        },
                      ],
                    }),
                  );
                }
                if (url.pathname.endsWith("/reset-quota")) {
                  resets.push(url.host);
                  return HttpClientResponse.fromWeb(
                    request,
                    Response.json({}, { status: failHub && url.host === "first.test" ? 503 : 200 }),
                  );
                }
                expect(url.pathname).toBe("/v0/management/api-call");
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({ status_code: 503, body: "{}" }),
                );
              }),
            ),
          ),
          NodeCrypto.layer,
        ]),
        Effect.scoped,
      );
    }
  }),
);

it.effect("keeps malformed source URLs encodable for config subscribers", () =>
  Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    yield* sources.refresh;
    const snapshots = yield* sources.current;
    expect(snapshots.map((source) => source.label)).toEqual([
      "local-hub",
      "opaque-hub",
      "Named hub",
      "hub.test:8317",
      "Usage limit source",
    ]);
    // Only an http(s) hub URL names an endpoint an agent can be sent to.
    expect(snapshots.map((source) => source.origin)).toEqual([
      undefined,
      undefined,
      undefined,
      "https://hub.test:8317",
      undefined,
    ]);
    expect(snapshots[3]?.endpoint).toBe("https://hub.test:8317/team-a");
    expect(() =>
      encodeConfigEvent({
        version: 1,
        type: "usageLimitSourcesUpdated",
        payload: { sources: snapshots },
      }),
    ).not.toThrow();
    expect(snapshots.every((source) => source.error === "No management key configured.")).toBe(
      true,
    );
  }).pipe(
    Effect.provide([
      layerSecrets(),
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("local-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("opaque-hub")]: {
            kind: "cliproxy",
            url: "file:///tmp/hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("named-hub")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            label: "Named hub",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make("valid-hub")]: {
            kind: "cliproxy",
            url: "https://hub.test:8317/team-a/management.html",
            managementKey: "",
            enabled: true,
          },
          [UsageLimitSourceId.make(" ")]: {
            kind: "cliproxy",
            url: "localhost:8317",
            managementKey: "",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() => Effect.die("Unexpected network request")),
      ),
      NodeCrypto.layer,
    ]),
  ),
);

it.effect("reads a management key from its secret provider", () => {
  const authorizations: Array<string | undefined> = [];
  const keySource = (reference: string) => ({
    provider: SecretProviderId.make("homelab"),
    reference,
  });
  return Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    const snapshots = yield* sources.streamChanges.pipe(
      Stream.filter((next) => next.length > 0),
      Stream.runHead,
      Effect.flatMap(Effect.fromOption),
    );
    expect(snapshots.map(({ id, error }) => ({ id, error }))).toEqual([
      { id: "resolved-hub", error: undefined },
      {
        id: "unresolved-hub",
        error: "Could not read the management key from its secret provider.",
      },
    ]);
    expect(authorizations).toEqual(["Bearer resolved-key", "Bearer resolved-key"]);
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("resolved-hub")]: {
            kind: "cliproxy",
            url: "https://resolved.test",
            managementKey: keySource("cliproxy#key"),
            enabled: true,
          },
          [UsageLimitSourceId.make("unresolved-hub")]: {
            kind: "cliproxy",
            url: "https://unresolved.test",
            managementKey: keySource("missing#key"),
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      Layer.succeed(SecretResolver.SecretResolver, {
        label: (provider) => Effect.succeed(provider),
        read: (references) =>
          Effect.succeed(
            references.map((reference) =>
              reference.reference === "cliproxy#key" ? "resolved-key" : undefined,
            ),
          ),
        invalidate: () => Effect.void,
      }),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            authorizations.push(request.headers.authorization);
            // A hub without v8 discovery answers 404 there and is read through the legacy API.
            return HttpClientResponse.fromWeb(
              request,
              new URL(request.url).pathname.startsWith("/v8/")
                ? Response.json({}, { status: 404 })
                : Response.json({ files: [] }),
            );
          }),
        ),
      ),
      NodeCrypto.layer,
    ]),
  );
});

it.effect("keeps an account's last good reading when the hub's next read of it is refused", () => {
  let refused = true;
  let workspace = "account-a";
  let listsIdentity = true;
  const readAccount = Effect.gen(function* () {
    const sources = yield* UsageLimitSources.make;
    return Effect.gen(function* () {
      yield* sources.refresh;
      const [source] = yield* sources.current;
      return source?.accounts[0]?.usageLimits;
    });
  });
  return Effect.gen(function* () {
    const read = yield* readAccount;
    // Nothing to keep yet: the account stays listed as unreadable.
    expect(yield* read).toMatchObject({ windows: [], unavailable: { reason: "probeFailed" } });
    refused = false;
    const good = yield* read;
    expect(good?.windows.map((window) => window.usedPercent)).toEqual([78]);
    expect(good?.unavailable).toBeUndefined();
    refused = true;
    expect(yield* read).toEqual(good);
    // The same auth file now holds another login, whose reading is unknown.
    workspace = "account-b";
    expect(yield* read).toMatchObject({ windows: [], unavailable: { reason: "probeFailed" } });
    // A file that lists no login cannot show whether the next one is the same.
    listsIdentity = false;
    refused = false;
    yield* read;
    refused = true;
    expect(yield* read).toMatchObject({ windows: [], unavailable: { reason: "probeFailed" } });
  }).pipe(
    Effect.provide([
      ServerSettings.layerTest({
        usageLimitSources: {
          [UsageLimitSourceId.make("hub")]: {
            kind: "cliproxy",
            url: "http://hub.test:8317",
            managementKey: "management-secret",
            enabled: true,
          },
        },
      }),
      Layer.mock(BackgroundPolicy.BackgroundPolicy)({
        shouldRunScopeWork: () => Effect.succeed(false),
      }),
      layerSecrets(),
      Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make((request) =>
          Effect.sync(() => {
            const path = new URL(request.url).pathname;
            if (path.startsWith("/v8/")) {
              return HttpClientResponse.fromWeb(request, Response.json({}, { status: 404 }));
            }
            if (path.endsWith("/auth-files")) {
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  files: [
                    {
                      id: "first.json",
                      auth_index: "a",
                      provider: "codex",
                      ...(listsIdentity
                        ? {
                            email: "first@example.com",
                            id_token: { chatgpt_account_id: workspace },
                          }
                        : {}),
                    },
                  ],
                }),
              );
            }
            const usage = {
              plan_type: "pro",
              rate_limit: {
                secondary_window: {
                  used_percent: 78,
                  reset_at: 4070908800,
                  limit_window_seconds: 604800,
                },
              },
            };
            return HttpClientResponse.fromWeb(
              request,
              Response.json(
                refused
                  ? { status_code: 429, body: "{}" }
                  : { status_code: 200, body: JSON.stringify(usage) },
              ),
            );
          }),
        ),
      ),
      NodeCrypto.layer,
    ]),
  );
});

const NOW = Date.parse("2026-11-13T12:00:00.000Z");
const at = (hours: number) => DateTime.formatIso(DateTime.makeUnsafe(NOW + hours * 3_600_000));
const spent = (id: string, hours: number): ServerProviderUsageWindow => ({
  id,
  kind: "weekly",
  label: id,
  usedPercent: 100,
  resetsAt: at(hours),
});
const hub = (
  accounts: ReadonlyArray<{
    driver?: string;
    models?: ReadonlyArray<string>;
    windows?: ReadonlyArray<ServerProviderUsageWindow>;
    unavailable?: true;
  }>,
): UsageLimitSourceSnapshot => ({
  id: UsageLimitSourceId.make("hub"),
  kind: "cliproxy",
  label: "hub",
  checkedAt: at(0),
  accounts: accounts.map((account, index) => ({
    id: `account-${index}`,
    driver: ProviderDriverKind.make(account.driver ?? "claudeAgent"),
    ...(account.models ? { models: account.models } : {}),
    usageLimits: {
      checkedAt: at(0),
      windows: account.windows ?? [],
      ...(account.unavailable ? { unavailable: { reason: "probeFailed" as const } } : {}),
    },
  })),
});

it.each([
  {
    name: "earliest refill when every account is spent, each at its latest spent window",
    accounts: [
      { windows: [spent("five_hour", 1), spent("seven_day", 3)] },
      { windows: [spent("five_hour", 2)] },
      { driver: "codex", windows: [] },
    ],
    model: "claude-haiku-5-5",
    expected: at(2),
  },
  {
    name: "unknown while an account still has room",
    accounts: [{ windows: [spent("five_hour", 1)] }, { windows: [] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "unknown while an account could not be read",
    accounts: [{ windows: [spent("five_hour", 1)] }, { unavailable: true as const }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "unknown when a spent window has no reset or already reset",
    accounts: [{ windows: [{ ...spent("five_hour", 1), resetsAt: undefined }] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "a model-scoped weekly window blocks only its own model",
    accounts: [{ windows: [spent("seven_day_fable", 5)] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  {
    name: "a model-scoped weekly window blocks its own model",
    accounts: [{ windows: [spent("seven_day_fable", 5)] }],
    model: "claude-fable-5-2",
    expected: at(5),
  },
  {
    name: "no account of the driver",
    accounts: [{ driver: "codex", windows: [spent("five_hour", 1)] }],
    model: "claude-haiku-5-5",
    expected: null,
  },
  // regression: #30778 only the accounts the hub routes the model to can refill it
  {
    name: "an account of another driver the hub routes the model to counts",
    accounts: [
      { driver: "codex", models: ["gpt-5.6-sol"], windows: [spent("five_hour", 3)] },
      { models: ["claude-sonnet-4-6"], windows: [] },
    ],
    model: "gpt-5.6-sol",
    expected: at(3),
  },
  {
    name: "an account that lists no models is left out of an alias",
    accounts: [{ windows: [spent("five_hour", 1)] }, { models: [], windows: [] }],
    model: "opus",
    expected: at(1),
  },
  {
    name: "a spent Gemini quota does not hold back Claude on Antigravity",
    accounts: [
      {
        driver: "antigravity",
        models: ["claude-opus-4-6-thinking"],
        windows: [spent("3p-5h", 1), spent("gemini-5h", 24)],
      },
    ],
    model: "claude-opus-4-6-thinking",
    expected: at(1),
  },
  {
    name: "a hub thinking suffix routes by its base model",
    accounts: [
      { driver: "codex", models: ["gpt-5.2"], windows: [spent("five_hour", 3)] },
      { models: ["claude-sonnet-4-6"], windows: [] },
    ],
    model: "gpt-5.2(high)",
    expected: at(3),
  },
  {
    name: "a prefixed Gemini model is held back by the Gemini quota",
    accounts: [
      {
        driver: "antigravity",
        models: ["ag/gemini-3.1-pro-high"],
        windows: [spent("3p-5h", 1), spent("gemini-5h", 24)],
      },
    ],
    model: "ag/gemini-3.1-pro-high",
    expected: at(24),
  },
  {
    name: "an alias of unknown family is held back by every Antigravity quota",
    accounts: [{ driver: "antigravity", models: ["fast"], windows: [spent("gemini-5h", 24)] }],
    model: "fast",
    expected: at(24),
  },
  {
    name: "an own-driver account whose model list was unread still counts",
    accounts: [
      { windows: [spent("five_hour", 1)] },
      {
        driver: "antigravity",
        models: ["claude-sonnet-4-6"],
        windows: [spent("3p-5h", 8)],
      },
    ],
    model: "claude-sonnet-4-6",
    expected: at(1),
  },
  {
    name: "an Argon model waits only for the Argon quota",
    accounts: [
      {
        driver: "antigravity",
        models: ["gemini-4-argon-high"],
        windows: [spent("gemini-argon-5h", 2), spent("gemini-carbon-weekly", 96)],
      },
    ],
    model: "gemini-4-argon-high",
    expected: at(2),
  },
])("hub pool reset: $name", ({ accounts, model, expected }) => {
  expect(
    UsageLimitSources.hubPoolResetAt(
      [hub(accounts)],
      ProviderDriverKind.make("claudeAgent"),
      model,
      NOW,
    ),
  ).toBe(expected);
});

it.effect("the reset fallback refreshes its hub, and a stalled hub cannot hold the failure", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(NOW);
    const roomLeft = { ...hub([{ windows: [spent("five_hour", 2)] }]), origin: "http://hub.test" };
    const cached = {
      ...roomLeft,
      accounts: roomLeft.accounts.map((account) => ({
        ...account,
        usageLimits: {
          ...account.usageLimits,
          windows: account.usageLimits.windows.map((window) => ({ ...window, usedPercent: 99 })),
        },
      })),
    };
    let current: ReadonlyArray<UsageLimitSourceSnapshot> = [cached];
    let refresh: Effect.Effect<void> = Effect.sync(() => {
      current = [roomLeft];
    });
    const lookup = UsageLimitSources.UsageLimitResetFallback.pipe(
      Effect.flatMap((fallback) =>
        fallback.resetAt(ProviderDriverKind.make("claudeAgent"), "http://hub.test", null),
      ),
      Effect.provide(
        UsageLimitSources.layerResetFallback.pipe(
          Layer.provide(
            Layer.mock(UsageLimitSources.UsageLimitSources)({
              current: Effect.sync(() => current),
              refresh: Effect.suspend(() => refresh),
            }),
          ),
        ),
      ),
    );
    // The last poll saw room; the account was spent after it.
    expect(yield* lookup).toBe(at(2));
    // Loopback aliases (127.0.0.1 vs localhost) match the same hub origin.
    const loopbackHub = { ...roomLeft, origin: "http://127.0.0.1:8317" };
    current = [loopbackHub];
    const loopbackLookup = UsageLimitSources.UsageLimitResetFallback.pipe(
      Effect.flatMap((fallback) =>
        fallback.resetAt(ProviderDriverKind.make("claudeAgent"), "http://localhost:8317", null),
      ),
      Effect.provide(
        UsageLimitSources.layerResetFallback.pipe(
          Layer.provide(
            Layer.mock(UsageLimitSources.UsageLimitSources)({
              current: Effect.sync(() => current),
              refresh: Effect.void,
            }),
          ),
        ),
      ),
    );
    expect(yield* loopbackLookup).toBe(at(2));
    current = [cached];
    refresh = Effect.never;
    const stalled = yield* Effect.forkChild(lookup);
    yield* TestClock.adjust("5 seconds");
    expect(yield* Fiber.join(stalled)).toBeNull();
  }),
);

it.effect(
  "retains cached account limits on probe failures until removed, switched, or recovered",
  () => {
    let files: ReadonlyArray<{
      readonly id: string;
      readonly auth_index: string;
      readonly provider: string;
      readonly email: string;
      readonly id_token?: { readonly chatgpt_account_id: string };
    }> = [{ id: "claude.json", auth_index: "a", provider: "claude", email: "alice@example.com" }];
    let authFilesStatus = 200;
    let apiCallResponse: { readonly status_code: number; readonly body: string } = {
      status_code: 200,
      body: JSON.stringify({
        five_hour: { utilization: 100, resets_at: "2099-01-01T05:00:00Z" },
      }),
    };
    return Effect.gen(function* () {
      const settings = yield* ServerSettings.ServerSettingsService;
      const sources = yield* UsageLimitSources.make;
      yield* sources.refresh;
      const initial = (yield* sources.current)[0]?.accounts[0];
      expect(initial).toMatchObject({
        id: "claude.json",
        email: "alice@example.com",
        plan: "Claude Subscription",
        usageLimits: {
          windows: [{ id: "five_hour", usedPercent: 100, resetsAt: "2099-01-01T05:00:00.000Z" }],
        },
      });
      expect(initial?.usageLimits.unavailable).toBeUndefined();

      // A 429 on /api/oauth/usage keeps the last good windows, plan, and checkedAt.
      yield* TestClock.adjust("1 minute");
      apiCallResponse = { status_code: 429, body: JSON.stringify({ error: "rate_limited" }) };
      yield* sources.refresh;
      const during429 = (yield* sources.current)[0]?.accounts[0];
      expect(during429).toEqual(initial);

      // Replacing the auth file with a different account does not inherit the previous account's cache.
      yield* TestClock.adjust("1 minute");
      files = [
        { id: "claude.json", auth_index: "a", provider: "claude", email: "bob@example.com" },
      ];
      yield* sources.refresh;
      const switched = (yield* sources.current)[0]?.accounts[0];
      expect(switched?.email).toBe("bob@example.com");
      expect(switched?.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(switched?.usageLimits.windows).toEqual([]);

      // Switching workspaceId on the same auth file and email does not inherit the prior workspace's cache.
      yield* TestClock.adjust("1 minute");
      files = [
        {
          id: "codex.json",
          auth_index: "c",
          provider: "codex",
          email: "alice@example.com",
          id_token: { chatgpt_account_id: "ws-1" },
        },
      ];
      apiCallResponse = {
        status_code: 200,
        body: JSON.stringify({
          plan_type: "plus",
          rate_limit: { primary_window: { used_percent: 60 } },
        }),
      };
      yield* sources.refresh;
      expect((yield* sources.current)[0]?.accounts[0]).toMatchObject({
        id: "codex.json",
        workspaceId: "ws-1",
        usageLimits: { windows: [{ usedPercent: 60 }] },
      });

      yield* TestClock.adjust("1 minute");
      files = [
        {
          id: "codex.json",
          auth_index: "c",
          provider: "codex",
          email: "alice@example.com",
          id_token: { chatgpt_account_id: "ws-2" },
        },
      ];
      apiCallResponse = { status_code: 429, body: JSON.stringify({ error: "rate_limited" }) };
      yield* sources.refresh;
      const switchedWorkspace = (yield* sources.current)[0]?.accounts[0];
      expect(switchedWorkspace?.workspaceId).toBe("ws-2");
      expect(switchedWorkspace?.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(switchedWorkspace?.usageLimits.windows).toEqual([]);

      // A subsequent healthy read replaces the failed state with fresh limits.
      yield* TestClock.adjust("1 minute");
      files = [
        { id: "claude.json", auth_index: "a", provider: "claude", email: "alice@example.com" },
      ];
      apiCallResponse = {
        status_code: 200,
        body: JSON.stringify({
          five_hour: { utilization: 25, resets_at: "2099-01-01T10:00:00Z" },
        }),
      };
      yield* sources.refresh;
      const recovered = (yield* sources.current)[0]?.accounts[0];
      expect(recovered?.usageLimits.unavailable).toBeUndefined();
      expect(recovered?.usageLimits.windows).toMatchObject([
        { id: "five_hour", usedPercent: 25, resetsAt: "2099-01-01T10:00:00.000Z" },
      ]);

      // Repointing the source id to a different hub URL does not inherit the old hub's cache.
      yield* TestClock.adjust("1 minute");
      apiCallResponse = { status_code: 429, body: JSON.stringify({ error: "rate_limited" }) };
      yield* settings.updateSettings({
        usageLimitSources: {
          [UsageLimitSourceId.make("hub")]: {
            kind: "cliproxy",
            url: "https://other-hub.test",
            managementKey: "secret",
            enabled: true,
          },
        },
      });
      yield* sources.refresh;
      const repointed = (yield* sources.current)[0];
      expect(repointed?.origin).toBe("https://other-hub.test");
      expect(repointed?.accounts[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(repointed?.accounts[0]?.usageLimits.windows).toEqual([]);

      // Recover on the new hub, then verify a source-level failure clears accounts and surfaces the error.
      yield* TestClock.adjust("1 minute");
      apiCallResponse = {
        status_code: 200,
        body: JSON.stringify({
          five_hour: { utilization: 40, resets_at: "2099-01-01T11:00:00Z" },
        }),
      };
      yield* sources.refresh;
      expect((yield* sources.current)[0]?.accounts[0]?.usageLimits.windows).toMatchObject([
        { id: "five_hour", usedPercent: 40 },
      ]);

      authFilesStatus = 500;
      yield* sources.refresh;
      const errored = (yield* sources.current)[0];
      expect(errored?.error).toBeDefined();
      expect(errored?.accounts).toEqual([]);

      // Removing the account from CLIProxyAPI drops it immediately.
      authFilesStatus = 200;
      yield* sources.refresh;
      expect((yield* sources.current)[0]?.accounts).toHaveLength(1);
      files = [];
      yield* sources.refresh;
      expect((yield* sources.current)[0]?.accounts).toEqual([]);
    }).pipe(
      Effect.provide([
        layerSecrets(),
        ServerSettings.layerTest({
          usageLimitSources: {
            [UsageLimitSourceId.make("hub")]: {
              kind: "cliproxy",
              url: "https://hub.test",
              managementKey: "secret",
              enabled: true,
            },
          },
        }),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              const path = new URL(request.url).pathname;
              if (path.startsWith("/v8/")) {
                return HttpClientResponse.fromWeb(request, Response.json({}, { status: 404 }));
              }
              if (path.endsWith("/auth-files")) {
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({ files }, { status: authFilesStatus }),
                );
              }
              return HttpClientResponse.fromWeb(request, Response.json(apiCallResponse));
            }),
          ),
        ),
        NodeCrypto.layer,
      ]),
      Effect.scoped,
    );
  },
);

it.effect("coalesces concurrent refreshes into at most one queued follow-up", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const releaseFirst = yield* Deferred.make<void>();
    let authFilesCalls = 0;

    yield* Effect.gen(function* () {
      const sources = yield* UsageLimitSources.make;
      const first = yield* Effect.forkChild(sources.refresh, { startImmediately: true });
      yield* Deferred.await(firstStarted);

      const waiters = yield* Effect.forEach([1, 2, 3, 4, 5], () =>
        Effect.forkChild(sources.refresh, { startImmediately: true }),
      );
      // Interrupting the first queued waiter must not stall or cancel the remaining waiters.
      yield* Fiber.interrupt(waiters[0]!);
      yield* Deferred.succeed(releaseFirst, undefined);

      yield* Fiber.join(first);
      yield* Effect.forEach(waiters.slice(1), Fiber.join);

      expect(authFilesCalls).toBe(2);
      expect((yield* sources.current)[0]?.accounts[0]?.usageLimits.windows).toMatchObject([
        { id: "five_hour", usedPercent: 20 },
      ]);
    }).pipe(
      Effect.provide([
        layerSecrets(),
        ServerSettings.layerTest({
          usageLimitSources: {
            [UsageLimitSourceId.make("hub")]: {
              kind: "cliproxy",
              url: "https://hub.test",
              managementKey: "secret",
              enabled: true,
            },
          },
        }),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              const path = new URL(request.url).pathname;
              if (path.startsWith("/v8/")) {
                return HttpClientResponse.fromWeb(request, Response.json({}, { status: 404 }));
              }
              if (path.endsWith("/auth-files")) {
                authFilesCalls += 1;
                if (authFilesCalls === 1) {
                  yield* Deferred.succeed(firstStarted, undefined);
                  yield* Deferred.await(releaseFirst);
                }
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    files: [{ id: "claude.json", auth_index: "a", provider: "claude" }],
                  }),
                );
              }
              return HttpClientResponse.fromWeb(
                request,
                Response.json({
                  status_code: 200,
                  body: JSON.stringify({
                    five_hour: {
                      utilization: authFilesCalls * 10,
                      resets_at: "2099-01-01T05:00:00Z",
                    },
                  }),
                }),
              );
            }),
          ),
        ),
        NodeCrypto.layer,
      ]),
      Effect.scoped,
    );
  }),
);

it.effect("settles blocked and subsequent refreshes when the service scope closes", () =>
  Effect.gen(function* () {
    const firstStarted = yield* Deferred.make<void>();
    const serviceScope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(serviceScope, Exit.void));
    let authFilesCalls = 0;

    yield* Effect.gen(function* () {
      const sources = yield* UsageLimitSources.make.pipe(Scope.provide(serviceScope));
      const first = yield* Effect.forkChild(sources.refresh, { startImmediately: true });
      yield* Deferred.await(firstStarted);

      const queued = yield* Effect.forkChild(sources.refresh, { startImmediately: true });
      yield* Scope.close(serviceScope, Exit.void);

      yield* Fiber.join(first);
      yield* Fiber.join(queued);
      yield* sources.refresh;
      expect(authFilesCalls).toBe(1);
    }).pipe(
      Effect.provide([
        layerSecrets(),
        ServerSettings.layerTest({
          usageLimitSources: {
            [UsageLimitSourceId.make("hub")]: {
              kind: "cliproxy",
              url: "https://hub.test",
              managementKey: "secret",
              enabled: true,
            },
          },
        }),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.gen(function* () {
              const path = new URL(request.url).pathname;
              if (path.startsWith("/v8/")) {
                return HttpClientResponse.fromWeb(request, Response.json({}, { status: 404 }));
              }
              authFilesCalls += 1;
              yield* Deferred.succeed(firstStarted, undefined);
              return yield* Effect.never;
            }),
          ),
        ),
        NodeCrypto.layer,
      ]),
    );
  }).pipe(Effect.scoped),
);

it.effect(
  "drops pre-redemption cached windows and spent resetCredits when a post-redemption probe fails",
  () => {
    let failUsageProbe = false;
    return Effect.gen(function* () {
      const sources = yield* UsageLimitSources.make;
      yield* sources.refresh;
      const before = (yield* sources.current)[0]?.accounts[0];
      expect(before?.usageLimits.windows).toMatchObject([{ usedPercent: 100 }]);
      expect(before?.usageLimits.resetCredits).toMatchObject({
        availableCount: 1,
        nextCreditId: "credit-1",
      });

      failUsageProbe = true;
      const result = yield* sources.consumeResetCredit({
        sourceId: UsageLimitSourceId.make("hub"),
        accountId: "codex.json",
        creditId: "credit-1",
      });
      expect(result).toEqual({ outcome: "reset" });

      const after = (yield* sources.current)[0]?.accounts[0];
      expect(after?.usageLimits.windows).toEqual([]);
      expect(after?.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(after?.usageLimits.resetCredits).toBeUndefined();
    }).pipe(
      Effect.provide([
        layerSecrets(),
        ServerSettings.layerTest({
          usageLimitSources: {
            [UsageLimitSourceId.make("hub")]: {
              kind: "cliproxy",
              url: "https://hub.test",
              managementKey: "secret",
              enabled: true,
            },
          },
        }),
        Layer.mock(BackgroundPolicy.BackgroundPolicy)({
          shouldRunScopeWork: () => Effect.succeed(false),
        }),
        Layer.succeed(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              const path = new URL(request.url).pathname;
              if (path.startsWith("/v8/")) {
                return HttpClientResponse.fromWeb(request, Response.json({}, { status: 404 }));
              }
              if (path.endsWith("/auth-files")) {
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    files: [
                      {
                        id: "codex.json",
                        auth_index: "c",
                        provider: "codex",
                        email: "alice@example.com",
                        id_token: { chatgpt_account_id: "ws-1" },
                      },
                    ],
                  }),
                );
              }
              if (path.endsWith("/reset-quota")) {
                return HttpClientResponse.fromWeb(request, Response.json({}));
              }
              const payload =
                request.body._tag === "Uint8Array"
                  ? (JSON.parse(new TextDecoder().decode(request.body.body)) as {
                      readonly url?: string;
                    })
                  : undefined;
              if (payload?.url?.endsWith("/consume")) {
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({ status_code: 200, body: JSON.stringify({ code: "reset" }) }),
                );
              }
              if (payload?.url?.endsWith("/rate-limit-reset-credits")) {
                return HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    status_code: 200,
                    body: JSON.stringify({
                      credits: [
                        {
                          id: "credit-1",
                          status: "available",
                          reset_type: "codex_rate_limits",
                          expires_at: "2099-01-01T00:00:00Z",
                        },
                      ],
                    }),
                  }),
                );
              }
              return HttpClientResponse.fromWeb(
                request,
                Response.json(
                  failUsageProbe
                    ? { status_code: 429, body: JSON.stringify({ error: "rate_limited" }) }
                    : {
                        status_code: 200,
                        body: JSON.stringify({
                          plan_type: "plus",
                          rate_limit: { primary_window: { used_percent: 100 } },
                        }),
                      },
                ),
              );
            }),
          ),
        ),
        NodeCrypto.layer,
      ]),
      Effect.scoped,
    );
  },
);
