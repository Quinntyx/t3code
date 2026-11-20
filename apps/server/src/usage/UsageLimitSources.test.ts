import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  SecretProviderId,
  ServerConfigStreamEvent,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
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
            url: "https://hub.test:8317",
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
    Effect.scoped,
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
    Effect.scoped,
  );
});

it.effect(
  "retains cached account limits on probe failures until removed, switched, or recovered",
  () => {
    let files: ReadonlyArray<{
      readonly id: string;
      readonly auth_index: string;
      readonly provider: string;
      readonly email: string;
      readonly disabled?: boolean;
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
      expect(repointed?.url).toBe("https://other-hub.test");
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
