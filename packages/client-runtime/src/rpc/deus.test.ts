import { describe, expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProjectId,
  DeusSessionId,
  WS_METHODS,
  type ServerConfig,
  type DeusCapabilities,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as SubscriptionRef from "effect/SubscriptionRef";
import {
  AVAILABLE_CONNECTION_STATE,
  PrimaryConnectionTarget,
  type PreparedConnection,
} from "../connection/model.ts";
import { EnvironmentSupervisor } from "../connection/supervisor.ts";
import { RpcPermissionGuard } from "./client.ts";
import type { RpcSession } from "./session.ts";
import type { WsRpcProtocolClient } from "./protocol.ts";
import { deusRequest } from "./deus.ts";

const environmentId = EnvironmentId.make("destination");
const input = {
  environmentId,
  projectId: ProjectId.make("project"),
  sessionId: DeusSessionId.make("session"),
};
const supported: DeusCapabilities = {
  available: true,
  protocolVersion: 1,
  text: true,
  liveAudio: true,
  learning: false,
  reportModes: ["SILENT", "WHEN_IDLE", "INTERRUPT"],
};
const config = (deus?: DeusCapabilities): ServerConfig => ({
  environment: {
    environmentId,
    label: "Destination",
    platform: { os: "linux", arch: "x64" },
    serverVersion: "test",
    capabilities: { repositoryIdentity: true },
  },
  auth: {
    policy: "loopback-browser",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  cwd: "/test",
  keybindingsConfigPath: "/test/keybindings.json",
  keybindings: [],
  issues: [],
  providers: [],
  availableEditors: [],
  observability: {
    logsDirectoryPath: "/test/logs",
    localTracingEnabled: false,
    otlpTracesEnabled: false,
    otlpMetricsEnabled: false,
    otlpLogsEnabled: false,
  },
  settings: DEFAULT_SERVER_SETTINGS,
  ...(deus === undefined ? {} : { deus }),
});
const fixture = Effect.fn("DeusClientTest.fixture")(function* (serverConfig: ServerConfig) {
  let calls = 0;
  const client = {
    [WS_METHODS.deusGetSnapshot]: () =>
      Effect.sync(() => {
        calls++;
        return "snapshot";
      }),
  } as unknown as WsRpcProtocolClient;
  const session: RpcSession = {
    client,
    initialConfig: Effect.succeed(serverConfig),
    subscribeServerConfig: () => {
      throw new Error("unused");
    },
    ready: Effect.void,
    probe: Effect.void,
    inboundFrames: Effect.succeed(0),
    closed: Effect.never,
  };
  const supervisor = EnvironmentSupervisor.of({
    target: new PrimaryConnectionTarget({
      environmentId,
      label: "Destination",
      httpBaseUrl: "https://destination.test",
      wsBaseUrl: "wss://destination.test",
    }),
    state: yield* SubscriptionRef.make(AVAILABLE_CONNECTION_STATE),
    session: yield* SubscriptionRef.make(Option.some(session)),
    prepared: yield* SubscriptionRef.make(Option.none<PreparedConnection>()),
    connect: Effect.void,
    disconnect: Effect.void,
    retryNow: Effect.void,
  });
  return { supervisor, calls: () => calls };
});

describe("environment-aware Deus requests", () => {
  it.effect("never probes a legacy server with missing Deus capability", () =>
    Effect.gen(function* () {
      const h = yield* fixture(config());
      const exit = yield* deusRequest(WS_METHODS.deusGetSnapshot, input).pipe(
        Effect.provideService(EnvironmentSupervisor, h.supervisor),
        Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(h.calls()).toBe(0);
    }),
  );
  it.effect("rejects payload destination mismatch before a request", () =>
    Effect.gen(function* () {
      const h = yield* fixture(config(supported));
      const exit = yield* deusRequest(WS_METHODS.deusGetSnapshot, {
        ...input,
        environmentId: EnvironmentId.make("elsewhere"),
      }).pipe(
        Effect.provideService(EnvironmentSupervisor, h.supervisor),
        Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
        Effect.exit,
      );
      expect(Exit.isFailure(exit)).toBe(true);
      expect(h.calls()).toBe(0);
    }),
  );
  it.effect("uses the current supervisor session and requires its destination permission", () =>
    Effect.gen(function* () {
      const h = yield* fixture(config(supported));
      const request = deusRequest(WS_METHODS.deusGetSnapshot, input).pipe(
        Effect.provideService(EnvironmentSupervisor, h.supervisor),
      );
      expect(Exit.isFailure(yield* request.pipe(Effect.exit))).toBe(true);
      expect(h.calls()).toBe(0);
      expect(
        yield* request.pipe(
          Effect.provideService(RpcPermissionGuard, { authorize: () => Effect.void }),
        ),
      ).toBe("snapshot");
      expect(h.calls()).toBe(1);
    }),
  );
});
