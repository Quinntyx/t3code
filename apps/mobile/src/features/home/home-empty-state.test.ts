import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { WorkspaceEnvironment, WorkspaceState } from "../../state/workspaceModel";
import { deriveHomeEmptyState } from "./home-empty-state";

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
});
