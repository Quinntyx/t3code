import {
  AuthEnvironmentMaintainScope,
  AuthDiagnosticsReadScope,
  AuthFilesystemReadScope,
  AuthProvidersManageScope,
  AuthSettingsWriteScope,
  DEFAULT_SERVER_SETTINGS,
  DEUS_UNAVAILABLE,
  DeusAttachmentId,
  DeusCursor,
  DeusInputId,
  DeusSessionId,
  DeusUnavailableError,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSourceControlWriteScope,
  AuthTerminalReadScope,
  AuthTerminalOperateScope,
  MachineHandoffError,
  WS_METHODS,
  ORCHESTRATION_V2_WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";

import {
  RPC_REQUIRED_SCOPES,
  requiredScopeForRpcMethod,
  requiredScopeForDeviceList,
} from "./RpcAuthorization.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";

describe("RPC authorization scopes", () => {
  it("declares exactly one scope for every RPC in the server group", () => {
    expect(new Set(Object.keys(RPC_REQUIRED_SCOPES))).toEqual(new Set(WsRpcGroup.requests.keys()));
  });

  it("keeps webhook delivery logs, which hold request bodies, behind operate scope", () => {
    for (const method of [
      ORCHESTRATION_V2_WS_METHODS.exportMachineHandoff,
      ORCHESTRATION_V2_WS_METHODS.importMachineHandoff,
      WS_METHODS.scheduledTasksListWebhookDeliveries,
      WS_METHODS.scheduledTasksGetWebhookDelivery,
      WS_METHODS.scheduledTasksRotateWebhookToken,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    }
  });

  it("keeps triage, which seeds an agent that reads logs and the database, behind operate scope", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.serverPrepareTriage)).toBe(
      AuthOrchestrationOperateScope,
    );
  });

  it("separates passive terminal observation from operations that can change a shell", () => {
    for (const method of [WS_METHODS.terminalObserve, WS_METHODS.subscribeTerminalMetadata]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalReadScope);
    }
    for (const method of [
      WS_METHODS.terminalAttach,
      WS_METHODS.terminalOpen,
      WS_METHODS.terminalWrite,
      WS_METHODS.terminalResize,
      WS_METHODS.terminalClear,
      WS_METHODS.terminalClose,
      WS_METHODS.previewStopLocalServer,
    ]) {
      expect(requiredScopeForRpcMethod(method)).toBe(AuthTerminalOperateScope);
    }
  });

  it("separates Deus metadata, media ownership, and management permissions", () => {
    for (const method of [
      WS_METHODS.deusGetCapabilities,
      WS_METHODS.deusGetSnapshot,
      WS_METHODS.deusSubscribe,
      WS_METHODS.deusMemorySearch,
      WS_METHODS.deusMemoryRead,
      WS_METHODS.deusGetSettings,
    ])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationReadScope);
    for (const method of [
      WS_METHODS.deusOpen,
      WS_METHODS.deusSendInput,
      WS_METHODS.deusResetConversation,
      WS_METHODS.deusLaunchTask,
      WS_METHODS.deusTaskAction,
      WS_METHODS.deusMemoryCorrect,
      WS_METHODS.deusPonder,
      WS_METHODS.deusAttach,
      WS_METHODS.deusDetach,
      WS_METHODS.deusRenew,
      WS_METHODS.deusMediaPush,
      WS_METHODS.deusMediaControl,
      WS_METHODS.deusMediaSubscribe,
    ])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthOrchestrationOperateScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.deusUpdateSettings)).toBe(AuthSettingsWriteScope);
    expect(requiredScopeForRpcMethod(WS_METHODS.deusSetCredential)).toBe(AuthProvidersManageScope);
  });

  it("rejects unknown RPC method names", () => {
    for (const method of ["server.notRegistered", "toString", "constructor"]) {
      expect(() => requiredScopeForRpcMethod(method)).toThrow(
        `RPC method ${method} has no declared authorization scope.`,
      );
    }
  });
});

it("requires operate permission for host retry while preserving read-only listing", () => {
  expect(requiredScopeForDeviceList({})).toBe(AuthOrchestrationReadScope);
  expect(requiredScopeForDeviceList({ retryHostId: "remote-host" })).toBe(
    AuthOrchestrationOperateScope,
  );
});

it("requires operate permission for tool updates even alongside a read-only check", () => {
  expect(requiredScopeForDeviceList({ updateTool: "agent", inspectOnly: true })).toBe(
    AuthOrchestrationOperateScope,
  );
  expect(requiredScopeForDeviceList({ updateTool: "hub" })).toBe(AuthOrchestrationOperateScope);
});

describe("machine handoff authorization", () => {
  const method = ORCHESTRATION_V2_WS_METHODS.exportMachineHandoff;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof method> => tag !== method,
    ),
  );
  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthOrchestrationOperateScope },
    { scopes: [AuthOrchestrationOperateScope], missing: AuthSourceControlWriteScope },
  ])("refuses export without $missing before touching Git", ({ scopes, missing }) =>
    Effect.gen(function* () {
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(method, () =>
              Effect.sync(() => {
                handled = true;
              }).pipe(
                Effect.andThen(
                  Effect.fail(new MachineHandoffError({ message: "handler reached" })),
                ),
              ),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );
      expect(
        yield* client[method]({ threadId: ThreadId.make("source") }).pipe(Effect.flip),
      ).toMatchObject({ _tag: "EnvironmentAuthorizationError", requiredPermission: missing });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
});

describe("RPC scope middleware", () => {
  const tested = [WS_METHODS.serverProbe, WS_METHODS.serverRetryResourceTelemetry] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );

  it.effect.each([
    { scopes: [AuthOrchestrationReadScope], missing: AuthEnvironmentMaintainScope },
    {
      scopes: [AuthOrchestrationReadScope, AuthEnvironmentMaintainScope],
      missing: AuthDiagnosticsReadScope,
    },
  ])("rejects telemetry retry without $missing before its handler runs", ({ scopes, missing }) =>
    Effect.gen(function* () {
      const handled: Array<string> = [];
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverProbe, () => Effect.succeed({})),
            group.toLayerHandler(WS_METHODS.serverRetryResourceTelemetry, () =>
              Effect.sync(() => handled.push("retry")).pipe(Effect.andThen(Effect.never)),
            ),
            RpcAuthorization.layer(scopes),
          ),
        ),
      );

      expect(yield* client[WS_METHODS.serverProbe]({})).toEqual({});
      expect(
        yield* client[WS_METHODS.serverRetryResourceTelemetry]({}).pipe(Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: missing,
      });
      expect(handled).toEqual([]);
    }).pipe(Effect.scoped),
  );
});

describe("Deus RPC authorization", () => {
  const tested = [
    WS_METHODS.deusGetCapabilities,
    WS_METHODS.deusOpen,
    WS_METHODS.deusSubscribe,
    WS_METHODS.deusMediaSubscribe,
    WS_METHODS.deusUpdateSettings,
    WS_METHODS.deusSetCredential,
  ] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as ReadonlyArray<string>).includes(tag),
    ),
  );
  const input = {
    environmentId: EnvironmentId.make("environment"),
    projectId: ProjectId.make("project"),
    sessionId: DeusSessionId.make("session"),
    inputId: DeusInputId.make("input"),
    after: DeusCursor.make(0),
    attachmentId: DeusAttachmentId.make("attachment"),
    generation: 1,
    patch: { enabled: true },
    secretRef: null,
  };

  it.effect.each([
    { scopes: [], unary: WS_METHODS.deusGetCapabilities, missing: AuthOrchestrationReadScope },
    {
      scopes: [AuthOrchestrationReadScope],
      unary: WS_METHODS.deusOpen,
      missing: AuthOrchestrationOperateScope,
    },
    {
      scopes: [AuthOrchestrationOperateScope],
      unary: WS_METHODS.deusUpdateSettings,
      missing: AuthSettingsWriteScope,
    },
    {
      scopes: [AuthSettingsWriteScope],
      unary: WS_METHODS.deusSetCredential,
      missing: AuthProvidersManageScope,
    },
  ] as const)(
    "rejects $unary without $missing before the handler runs",
    ({ scopes, unary, missing }) =>
      Effect.gen(function* () {
        let handled = 0;
        const unavailable = Effect.sync(() => {
          handled++;
        }).pipe(
          Effect.andThen(
            Effect.fail(
              new DeusUnavailableError({ message: "Not implemented.", reason: "unsupported" }),
            ),
          ),
        );
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.mergeAll(
              group.toLayerHandler(WS_METHODS.deusGetCapabilities, () =>
                Effect.sync(() => {
                  handled++;
                  return DEUS_UNAVAILABLE;
                }),
              ),
              group.toLayerHandler(WS_METHODS.deusOpen, () => unavailable),
              group.toLayerHandler(WS_METHODS.deusSubscribe, () => Stream.fromEffect(unavailable)),
              group.toLayerHandler(WS_METHODS.deusMediaSubscribe, () =>
                Stream.fromEffect(unavailable),
              ),
              group.toLayerHandler(WS_METHODS.deusUpdateSettings, () => unavailable),
              group.toLayerHandler(WS_METHODS.deusSetCredential, () => unavailable),
              RpcAuthorization.layer(scopes),
            ),
          ),
        );
        const responses = {
          [WS_METHODS.deusGetCapabilities]: client[WS_METHODS.deusGetCapabilities](input).pipe(
            Effect.asVoid,
          ),
          [WS_METHODS.deusOpen]: client[WS_METHODS.deusOpen](input).pipe(Effect.asVoid),
          [WS_METHODS.deusUpdateSettings]: client[WS_METHODS.deusUpdateSettings](input).pipe(
            Effect.asVoid,
          ),
          [WS_METHODS.deusSetCredential]: client[WS_METHODS.deusSetCredential](input).pipe(
            Effect.asVoid,
          ),
        };
        expect(yield* responses[unary].pipe(Effect.flip)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: missing,
        });
        expect(handled).toBe(0);
      }).pipe(Effect.scoped),
  );

  it.effect("allows metadata observers but denies their media subscription", () =>
    Effect.gen(function* () {
      const handled: string[] = [];
      const unavailable = new DeusUnavailableError({
        message: "Not implemented.",
        reason: "unsupported",
      });
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.deusGetCapabilities, () =>
              Effect.succeed(DEUS_UNAVAILABLE),
            ),
            group.toLayerHandler(WS_METHODS.deusOpen, () => Effect.fail(unavailable)),
            group.toLayerHandler(WS_METHODS.deusSubscribe, () =>
              Stream.fromEffect(
                Effect.sync(() => handled.push("metadata")).pipe(
                  Effect.andThen(Effect.fail(unavailable)),
                ),
              ),
            ),
            group.toLayerHandler(WS_METHODS.deusMediaSubscribe, () =>
              Stream.fromEffect(
                Effect.sync(() => handled.push("media")).pipe(
                  Effect.andThen(Effect.fail(unavailable)),
                ),
              ),
            ),
            group.toLayerHandler(WS_METHODS.deusUpdateSettings, () => Effect.fail(unavailable)),
            group.toLayerHandler(WS_METHODS.deusSetCredential, () => Effect.fail(unavailable)),
            RpcAuthorization.layer([AuthOrchestrationReadScope]),
          ),
        ),
      );
      expect(yield* client[WS_METHODS.deusGetCapabilities](input)).toEqual(DEUS_UNAVAILABLE);
      expect(
        yield* client[WS_METHODS.deusSubscribe](input).pipe(Stream.runDrain, Effect.flip),
      ).toMatchObject({ _tag: "DeusUnavailableError" });
      expect(
        yield* client[WS_METHODS.deusMediaSubscribe](input).pipe(Stream.runDrain, Effect.flip),
      ).toMatchObject({
        _tag: "EnvironmentAuthorizationError",
        requiredPermission: AuthOrchestrationOperateScope,
      });
      expect(handled).toEqual(["metadata"]);
    }).pipe(Effect.scoped),
  );
});

describe("settings mutation authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.serverUpdateSettings> =>
        tag !== WS_METHODS.serverUpdateSettings,
    ),
  );
  const providerInstanceMutation = {
    operation: "remove" as const,
    instanceId: ProviderInstanceId.make("codex_work"),
  };

  it.effect("allows provider-only mutations while denying mixed settings without their grant", () =>
    Effect.gen(function* () {
      let handled = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled++;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthProvidersManageScope]),
          ),
        ),
      );
      yield* client[WS_METHODS.serverUpdateSettings]({ patch: {}, providerInstanceMutation });
      expect(handled).toBe(1);
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: { defaultRuntimeMode: "full-access" },
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthSettingsWriteScope });
      expect(handled).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.effect("does not let a settings grant create or remove providers", () =>
    Effect.gen(function* () {
      let handled = false;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.serverUpdateSettings, () =>
              Effect.sync(() => {
                handled = true;
                return DEFAULT_SERVER_SETTINGS;
              }),
            ),
            RpcAuthorization.layer([AuthSettingsWriteScope]),
          ),
        ),
      );
      expect(
        yield* client[WS_METHODS.serverUpdateSettings]({
          patch: {},
          providerInstanceMutation,
        }).pipe(Effect.flip),
      ).toMatchObject({ requiredPermission: AuthProvidersManageScope });
      expect(handled).toBe(false);
    }).pipe(Effect.scoped),
  );
});

it.effect("requires task permission before attaching a prepared worktree to a thread", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.gitPreparePullRequestThread
        > => tag !== WS_METHODS.gitPreparePullRequestThread,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.gitPreparePullRequestThread, () =>
            Effect.sync(() => {
              handled = true;
            }).pipe(Effect.andThen(Effect.never)),
          ),
          RpcAuthorization.layer([AuthSourceControlWriteScope]),
        ),
      ),
    );
    expect(
      yield* client[WS_METHODS.gitPreparePullRequestThread]({
        cwd: "/repo",
        reference: "42",
        mode: "worktree",
        threadId: ThreadId.make("thread"),
      }).pipe(Effect.flip),
    ).toMatchObject({ requiredPermission: AuthOrchestrationOperateScope });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);

describe("thread context authorization", () => {
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (
        tag,
      ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.gitRunStackedAction> =>
        tag !== WS_METHODS.gitRunStackedAction,
    ),
  );

  it.effect.each(["commit", "create_pr", "commit_push_pr"] as const)(
    "%s needs thread read permission only when generating a PR from a thread",
    (action) =>
      Effect.gen(function* () {
        const handled: string[] = [];
        const handler = group.toLayerHandler(WS_METHODS.gitRunStackedAction, ({ actionId }) =>
          Stream.fromEffect(Effect.sync(() => handled.push(actionId))).pipe(Stream.drain),
        );
        const client = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(handler, RpcAuthorization.layer([AuthSourceControlWriteScope])),
          ),
        );
        const input = { actionId: "without-thread", cwd: "/repo", action };
        const withThread = { ...input, actionId: "with-thread", threadId: ThreadId.make("thread") };
        yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](input));
        if (action === "create_pr" || action === "commit_push_pr") {
          expect(
            yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread)).pipe(
              Effect.flip,
            ),
          ).toMatchObject({ requiredPermission: AuthOrchestrationReadScope });
          expect(handled).toEqual(["without-thread"]);
        } else {
          yield* Stream.runDrain(client[WS_METHODS.gitRunStackedAction](withThread));
          expect(handled).toEqual(["without-thread", "with-thread"]);
        }
        const reader = yield* RpcTest.makeClient(group).pipe(
          Effect.provide(
            Layer.merge(
              handler,
              RpcAuthorization.layer([AuthSourceControlWriteScope, AuthOrchestrationReadScope]),
            ),
          ),
        );
        yield* Stream.runDrain(
          reader[WS_METHODS.gitRunStackedAction]({ ...withThread, actionId: "allowed" }),
        );
        expect(handled.at(-1)).toBe("allowed");
      }).pipe(Effect.scoped),
  );
});

it.effect("separates host file URLs from readable attachment URLs", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, typeof WS_METHODS.assetsCreateUrl> =>
          tag !== WS_METHODS.assetsCreateUrl,
      ),
    );
    let handled = 0;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.assetsCreateUrl, () =>
            Effect.sync(() => {
              handled++;
              return { relativeUrl: "/api/assets/file", expiresAt: 1 };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    yield* client[WS_METHODS.assetsCreateUrl]({
      resource: { _tag: "attachment", attachmentId: "image" },
    });
    for (const resource of [
      { _tag: "workspace-file", threadId: ThreadId.make("thread"), path: "file.txt" },
      { _tag: "media-file", threadId: ThreadId.make("thread"), path: "/repo/image.png" },
      { _tag: "draft-workspace-file", cwd: "/repo", path: "file.txt" },
    ] as const) {
      expect(
        yield* client[WS_METHODS.assetsCreateUrl]({ resource }).pipe(Effect.flip),
      ).toMatchObject({
        requiredScope: AuthOrchestrationReadScope,
        requiredPermission: AuthFilesystemReadScope,
      });
    }
    expect(handled).toBe(1);
  }).pipe(Effect.scoped),
);

it.effect("denies manual cleanup before the handler without settings permission", () =>
  Effect.gen(function* () {
    const group = WsRpcGroup.omit(
      ...[...WsRpcGroup.requests.keys()].filter(
        (
          tag,
        ): tag is Exclude<
          keyof typeof RPC_REQUIRED_SCOPES,
          typeof WS_METHODS.serverRunStorageCleanup
        > => tag !== WS_METHODS.serverRunStorageCleanup,
      ),
    );
    let handled = false;
    const client = yield* RpcTest.makeClient(group).pipe(
      Effect.provide(
        Layer.mergeAll(
          group.toLayerHandler(WS_METHODS.serverRunStorageCleanup, () =>
            Effect.sync(() => {
              handled = true;
              return {
                trigger: "manual" as const,
                startedAt: "2026-10-09T12:00:00.000Z",
                finishedAt: "2026-10-09T12:00:00.000Z",
                entries: [],
                counts: { removed: 0, kept: 0, failed: 0 },
                omittedCount: 0,
                bytesFreed: 0,
              };
            }),
          ),
          RpcAuthorization.layer([AuthOrchestrationReadScope]),
        ),
      ),
    );
    expect(yield* client[WS_METHODS.serverRunStorageCleanup]({}).pipe(Effect.flip)).toMatchObject({
      requiredPermission: AuthSettingsWriteScope,
    });
    expect(handled).toBe(false);
  }).pipe(Effect.scoped),
);
