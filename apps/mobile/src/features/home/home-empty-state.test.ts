import { translatableMessage } from "@t3tools/client-runtime/errors";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MessageResolver } from "../../i18n/messages";
import type { WorkspaceEnvironment, WorkspaceState } from "../../state/workspaceModel";
import { deriveHomeEmptyState, deriveSelectedEnvironmentEmptyState } from "./home-empty-state";

function connectingEnvironment(
  connectionState: "connecting" | "reconnecting",
  connectionError: string | null,
): WorkspaceEnvironment {
  return {
    environmentId: EnvironmentId.make("environment-1"),
    environmentLabel: "corex",
    displayUrl: "",
    isRelayManaged: false,
    isEnabled: true,
    connectionState,
    connectionError,
    connectionErrorTraceId: null,
  };
}

function workspaceState(overrides: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    isLoadingConnections: false,
    hasConnections: true,
    hasLoadedShellSnapshot: true,
    hasFreshShellSnapshot: true,
    hasActivelySyncingEnvironment: false,
    hasPendingShellSnapshot: false,
    hasSyncingConnectedEnvironment: false,
    hasReadyEnvironment: true,
    hasConnectingEnvironment: false,
    connectingEnvironments: [],
    connectionState: "connected",
    connectionError: null,
    shellSnapshotError: null,
    networkStatus: "online",
    ...overrides,
  };
}

const RETAINED_FAILURE = "Environment did not respond before the connection timeout.";
const reconnecting = connectingEnvironment("reconnecting", RETAINED_FAILURE);

describe("home empty state", () => {
  it.each([
    [
      "reports environment unavailable while a saved environment sits in failed backoff",
      workspaceState({
        hasLoadedShellSnapshot: false,
        hasFreshShellSnapshot: false,
        hasActivelySyncingEnvironment: false,
        hasPendingShellSnapshot: true,
        hasReadyEnvironment: false,
        hasConnectingEnvironment: true,
        connectingEnvironments: [reconnecting],
        connectionState: "reconnecting",
        connectionError: RETAINED_FAILURE,
      }),
      1,
      { title: "Environment unavailable", loading: false, showsAddEnvironment: true },
    ],
    [
      "reports environment unavailable when a connected socket fails to synchronize its shell",
      workspaceState({
        hasLoadedShellSnapshot: true,
        hasFreshShellSnapshot: false,
        hasActivelySyncingEnvironment: false,
        hasPendingShellSnapshot: false,
        hasReadyEnvironment: true,
        connectionState: "connected",
        shellSnapshotError: "Could not synchronize environment data.",
      }),
      1,
      { title: "Environment unavailable", loading: false, showsAddEnvironment: false },
    ],
    [
      "waits for a connected environment's first shell snapshot",
      workspaceState({
        hasLoadedShellSnapshot: false,
        hasFreshShellSnapshot: false,
        hasActivelySyncingEnvironment: true,
        hasPendingShellSnapshot: true,
        hasSyncingConnectedEnvironment: true,
      }),
      0,
      { title: "Loading threads", loading: true, showsAddEnvironment: false },
    ],
    [
      "waits while another environment is still connecting after one loaded empty",
      workspaceState({
        hasPendingShellSnapshot: true,
        hasConnectingEnvironment: true,
        connectingEnvironments: [reconnecting],
        connectionError: RETAINED_FAILURE,
      }),
      0,
      { title: "Loading threads", loading: true, showsAddEnvironment: false },
    ],
    [
      "reports no threads once every environment has resolved",
      workspaceState(),
      1,
      { title: "No threads yet", loading: false, showsAddEnvironment: false },
    ],
    [
      "does not wait on retries while the device is offline",
      workspaceState({
        hasPendingShellSnapshot: true,
        hasReadyEnvironment: false,
        hasConnectingEnvironment: true,
        connectingEnvironments: [reconnecting],
        connectionState: "offline",
        networkStatus: "offline",
      }),
      1,
      { title: "No threads yet", loading: false, showsAddEnvironment: true },
    ],
    [
      "waits for host approval instead of showing environment unavailable",
      workspaceState({
        hasLoadedShellSnapshot: false,
        hasFreshShellSnapshot: false,
        hasActivelySyncingEnvironment: false,
        hasPendingShellSnapshot: false,
        hasReadyEnvironment: false,
        hasConnectingEnvironment: true,
        hasAwaitingApprovalEnvironment: true,
        connectingEnvironments: [{ ...reconnecting, awaitingApproval: true }],
        connectionState: "reconnecting",
        connectionError: "Approve this device on the host.",
      }),
      0,
      { title: "Waiting for approval", loading: true, showsAddEnvironment: false },
    ],
    [
      "reports environment unavailable when offline with only a cached shell snapshot",
      workspaceState({
        hasLoadedShellSnapshot: true,
        hasFreshShellSnapshot: false,
        hasPendingShellSnapshot: false,
        hasReadyEnvironment: false,
        connectionState: "offline",
        networkStatus: "offline",
      }),
      1,
      { title: "Environment unavailable", loading: false, showsAddEnvironment: true },
    ],
  ] as const)("%s", (_name, state, projectCount, expected) => {
    const { title, loading, showsAddEnvironment } = deriveHomeEmptyState(state, projectCount);
    expect({ title, loading, showsAddEnvironment }).toEqual(expected);
  });

  it("localizes shell and connection errors and derives scoped unavailability for a selected environment", () => {
    const resolve = ((text: string) => `[i18n] ${text}`) as MessageResolver;
    const workspaceShellError = deriveHomeEmptyState(
      workspaceState({
        hasFreshShellSnapshot: false,
        hasActivelySyncingEnvironment: false,
        shellSnapshotError: "Could not synchronize environment data.",
      }),
      0,
      resolve,
    );
    expect(workspaceShellError.detail).toBe("[i18n] Could not synchronize environment data.");

    const scopedBlocked = deriveSelectedEnvironmentEmptyState(
      {
        networkStatus: "online",
        environment: {
          ...reconnecting,
          connectionState: "error",
          connectionError: RETAINED_FAILURE,
          i18nConnectionError: translatableMessage(RETAINED_FAILURE).i18nMessage,
        },
        hasFreshSnapshot: false,
        isActivelySyncing: false,
        shellError: null,
      },
      resolve,
    );
    expect(scopedBlocked).toEqual({
      title: "[i18n] Environment unavailable",
      detail: `[i18n] ${RETAINED_FAILURE}`,
      loading: false,
    });

    const scopedFresh = deriveSelectedEnvironmentEmptyState(
      {
        networkStatus: "online",
        environment: { ...reconnecting, connectionState: "connected", connectionError: null },
        hasFreshSnapshot: true,
        isActivelySyncing: false,
        shellError: null,
      },
      resolve,
    );
    expect(scopedFresh).toBeNull();
  });
});
