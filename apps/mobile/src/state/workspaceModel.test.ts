import {
  EMPTY_SHELL_STATE,
  type EnvironmentShellSummary,
} from "@t3tools/client-runtime/state/shell";
import {
  AVAILABLE_CONNECTION_STATE,
  BearerConnectionProfile,
  BearerConnectionTarget,
  ConnectionTransientError,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  isEnvironmentActivelySyncingShell,
  isEnvironmentShellPending,
  isSelectedEnvironmentUnavailable,
  isWorkspaceEnvironmentUnavailable,
  projectWorkspaceState,
} from "./workspaceModel";
import { projectEnvironmentConnectionSummary as projectWorkspaceEnvironment } from "@t3tools/client-runtime/state/presentation";
import type { EnvironmentPresentation } from "./environments";

const ENVIRONMENT_ID = EnvironmentId.make("environment-1");

function environment(
  phase: EnvironmentPresentation["connection"]["phase"],
): EnvironmentPresentation {
  const connectionId = `bearer:${ENVIRONMENT_ID}`;
  return {
    environmentId: ENVIRONMENT_ID,
    label: "Julius's MacBook Pro",
    displayUrl: "https://environment.example.test",
    relayManaged: false,
    entry: {
      target: new BearerConnectionTarget({
        environmentId: ENVIRONMENT_ID,
        label: "Julius's MacBook Pro",
        connectionId,
      }),
      profile: Option.some(
        new BearerConnectionProfile({
          connectionId,
          environmentId: ENVIRONMENT_ID,
          label: "Julius's MacBook Pro",
          httpBaseUrl: "https://environment.example.test",
          wsBaseUrl: "wss://environment.example.test",
        }),
      ),
      enabled: true,
    },
    connection: {
      phase,
      error: phase === "error" ? "Connection failed." : null,
      traceId: phase === "error" ? "trace-1" : null,
    },
    serverConfig: null,
    refusedRouteIds: [],
  };
}

const EMPTY_SHELL_SUMMARY: EnvironmentShellSummary = {
  hasSnapshot: false,
  hasSynchronizingShell: false,
  firstError: null,
};

const CACHED_SHELL_SUMMARY: EnvironmentShellSummary = {
  ...EMPTY_SHELL_SUMMARY,
  hasSnapshot: true,
  hasSynchronizingShell: true,
};

describe("mobile workspace projection", () => {
  it("reports offline before stale connected presentations", () => {
    const environments = [projectWorkspaceEnvironment(ENVIRONMENT_ID, environment("connected"))];
    const state = projectWorkspaceState({
      isReady: true,
      networkStatus: "offline",
      environments,
      shellSummary: EMPTY_SHELL_SUMMARY,
      hasFreshShellSnapshot: false,
      hasActivelySyncingEnvironment: false,
      hasSyncingConnectedEnvironment: false,
    });

    expect(state.connectionState).toBe("offline");
    expect(state.networkStatus).toBe("offline");
    expect(state.hasReadyEnvironment).toBe(false);
    expect(isWorkspaceEnvironmentUnavailable(state)).toBe(true);
  });

  it("waits for shell cache initialization and synchronization, but not completed reads", () => {
    expect(isEnvironmentShellPending(EMPTY_SHELL_STATE)).toBe(true);
    expect(isEnvironmentShellPending({ ...EMPTY_SHELL_STATE, status: "synchronizing" })).toBe(true);
    expect(isEnvironmentShellPending({ ...EMPTY_SHELL_STATE, status: "cached" })).toBe(false);
    expect(
      isEnvironmentShellPending({ ...EMPTY_SHELL_STATE, error: Option.some("Cache failed.") }),
    ).toBe(false);
    expect(
      isEnvironmentShellPending({
        ...EMPTY_SHELL_STATE,
        status: "synchronizing",
        error: Option.some("Could not synchronize environment data."),
      }),
    ).toBe(false);
  });

  it("pairs workspace approval status with the same environment that supplies connectionError", () => {
    const failedEnv = projectWorkspaceEnvironment(ENVIRONMENT_ID, environment("error"));
    const approvalEnvId = EnvironmentId.make("environment-2");
    const approvalPresentation = environment("reconnecting");
    const approvalEnv = projectWorkspaceEnvironment(approvalEnvId, {
      ...approvalPresentation,
      connection: {
        phase: "reconnecting",
        error: "Approve this device on host 2.",
        traceId: null,
        awaitingApproval: true,
      },
    });
    const state = projectWorkspaceState({
      isReady: true,
      networkStatus: "online",
      environments: [failedEnv, approvalEnv],
      shellSummary: EMPTY_SHELL_SUMMARY,
      hasFreshShellSnapshot: false,
      hasActivelySyncingEnvironment: false,
      hasSyncingConnectedEnvironment: false,
    });

    expect(state.connectionError).toBe("Connection failed.");
    expect(state.hasAwaitingApprovalEnvironment).toBe(false);
  });

  it("keeps retained snapshots visible while reconnecting without claiming readiness", () => {
    const environments = [projectWorkspaceEnvironment(ENVIRONMENT_ID, environment("reconnecting"))];
    const state = projectWorkspaceState({
      isReady: true,
      networkStatus: "online",
      environments,
      shellSummary: CACHED_SHELL_SUMMARY,
      hasFreshShellSnapshot: false,
      hasActivelySyncingEnvironment: false,
      hasSyncingConnectedEnvironment: false,
    });

    expect(state.hasLoadedShellSnapshot).toBe(true);
    expect(state.hasFreshShellSnapshot).toBe(false);
    expect(state.hasPendingShellSnapshot).toBe(true);
    expect(state.hasSyncingConnectedEnvironment).toBe(false);
    expect(state.hasReadyEnvironment).toBe(false);
    expect(state.connectionState).toBe("reconnecting");
  });

  it.each([
    {
      name: "clean initial connecting attempt shows skeleton",
      connection: {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        phase: "connecting",
        attempt: 1,
      } satisfies SupervisorConnectionState,
      shell: { status: "cached" as const, error: Option.none<string>(), fresh: false },
      isSteadyFresh: false,
      expected: true,
    },
    {
      name: "clean first-loss backoff without failure keeps skeleton",
      connection: {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        phase: "backoff",
        attempt: 1,
        lastFailure: null,
      } satisfies SupervisorConnectionState,
      shell: { status: "cached" as const, error: Option.none<string>(), fresh: false },
      isSteadyFresh: false,
      expected: true,
    },
    {
      name: "failed backoff state exits skeleton",
      connection: {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        phase: "backoff",
        attempt: 1,
        lastFailure: new ConnectionTransientError({ reason: "timeout", detail: "Timed out." }),
      } satisfies SupervisorConnectionState,
      shell: { status: "cached" as const, error: Option.none<string>(), fresh: false },
      isSteadyFresh: false,
      expected: false,
    },
    {
      name: "retry attempt after a prior failure does not oscillate back to skeleton",
      connection: {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        phase: "connecting",
        attempt: 2,
        lastFailure: new ConnectionTransientError({ reason: "timeout", detail: "Timed out." }),
      } satisfies SupervisorConnectionState,
      shell: { status: "cached" as const, error: Option.none<string>(), fresh: false },
      isSteadyFresh: false,
      expected: false,
    },
    {
      name: "connected socket actively synchronizing shell shows skeleton",
      connection: {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        phase: "connected",
        attempt: 1,
      } satisfies SupervisorConnectionState,
      shell: { status: "synchronizing" as const, error: Option.none<string>(), fresh: false },
      isSteadyFresh: false,
      expected: true,
    },
    {
      name: "connected socket whose fresh shell is held by steadyShells stays on skeleton until released",
      connection: {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        phase: "connected",
        attempt: 1,
      } satisfies SupervisorConnectionState,
      shell: { status: "live" as const, error: Option.none<string>(), fresh: true },
      isSteadyFresh: false,
      expected: true,
    },
    {
      name: "connected socket with a failed shell subscription exits skeleton",
      connection: {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        phase: "connected",
        attempt: 1,
      } satisfies SupervisorConnectionState,
      shell: {
        status: "cached" as const,
        error: Option.some("Could not synchronize environment data."),
        fresh: false,
      },
      isSteadyFresh: false,
      expected: false,
    },
    {
      name: "connected socket with an idle non-fresh shell exits skeleton",
      connection: {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        phase: "connected",
        attempt: 1,
      } satisfies SupervisorConnectionState,
      shell: { status: "cached" as const, error: Option.none<string>(), fresh: false },
      isSteadyFresh: false,
      expected: false,
    },
    {
      name: "fresh displayed steady shell exits skeleton",
      connection: {
        ...AVAILABLE_CONNECTION_STATE,
        desired: true,
        phase: "connected",
        attempt: 1,
      } satisfies SupervisorConnectionState,
      shell: { status: "live" as const, error: Option.none<string>(), fresh: true },
      isSteadyFresh: true,
      expected: false,
    },
  ])(
    "isEnvironmentActivelySyncingShell: $name",
    ({ connection, shell, isSteadyFresh, expected }) => {
      expect(isEnvironmentActivelySyncingShell({ connection, shell, isSteadyFresh })).toBe(
        expected,
      );
    },
  );

  it.each([
    {
      name: "blocked selected environment is unavailable",
      phase: "error" as const,
      hasFreshSnapshot: false,
      isActivelySyncing: false,
      shellError: null,
      expected: true,
    },
    {
      name: "connected selected environment with shell error is unavailable",
      phase: "connected" as const,
      hasFreshSnapshot: false,
      isActivelySyncing: false,
      shellError: "Could not synchronize environment data.",
      expected: true,
    },
    {
      name: "fresh selected environment is available",
      phase: "connected" as const,
      hasFreshSnapshot: true,
      isActivelySyncing: false,
      shellError: null,
      expected: false,
    },
    {
      name: "actively syncing selected environment is not yet unavailable",
      phase: "connecting" as const,
      hasFreshSnapshot: false,
      isActivelySyncing: true,
      shellError: null,
      expected: false,
    },
  ])(
    "isSelectedEnvironmentUnavailable: $name",
    ({ phase, hasFreshSnapshot, isActivelySyncing, shellError, expected }) => {
      expect(
        isSelectedEnvironmentUnavailable({
          networkStatus: "online",
          environment: projectWorkspaceEnvironment(ENVIRONMENT_ID, environment(phase)),
          hasFreshSnapshot,
          isActivelySyncing,
          shellError,
        }),
      ).toBe(expected);
    },
  );
});
