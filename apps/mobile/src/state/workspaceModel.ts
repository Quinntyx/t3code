import {
  EMPTY_SHELL_STATE,
  type EnvironmentShellState,
  type EnvironmentShellSummary,
} from "@t3tools/client-runtime/state/shell";
import type { MarkedText } from "@t3tools/client-runtime/errors";
import type { EnvironmentId, ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";

import {
  AVAILABLE_CONNECTION_STATE,
  type EnvironmentConnectionPhase,
  type NetworkStatus,
  type SupervisorConnectionState,
} from "@t3tools/client-runtime/connection";

import type { EnvironmentConnectionSummary as WorkspaceEnvironment } from "@t3tools/client-runtime/state/presentation";

export type { EnvironmentConnectionSummary as WorkspaceEnvironment } from "@t3tools/client-runtime/state/presentation";

export interface WorkspaceConnectionState {
  readonly isLoadingConnections: boolean;
  readonly hasConnections: boolean;
  readonly hasReadyEnvironment: boolean;
  readonly hasConnectingEnvironment: boolean;
  readonly hasAwaitingApprovalEnvironment?: boolean;
  readonly connectingEnvironments: ReadonlyArray<WorkspaceEnvironment>;
  readonly connectionState: EnvironmentConnectionPhase;
  readonly connectionError: string | null;
  readonly i18nConnectionError?: MarkedText;
  readonly networkStatus: NetworkStatus;
}

export interface WorkspaceState extends WorkspaceConnectionState {
  readonly hasLoadedShellSnapshot: boolean;
  /** True once at least one enabled environment has a fresh displayed snapshot in this session. */
  readonly hasFreshShellSnapshot: boolean;
  /** True while at least one non-fresh enabled environment is actively connecting or syncing. */
  readonly hasActivelySyncingEnvironment: boolean;
  readonly hasPendingShellSnapshot: boolean;
  readonly hasSyncingConnectedEnvironment: boolean;
  readonly shellSnapshotError: string | null;
}

function overallConnectionState(
  environments: ReadonlyArray<WorkspaceEnvironment>,
  networkStatus: NetworkStatus,
): EnvironmentConnectionPhase {
  if (environments.length === 0) {
    return "available";
  }
  if (networkStatus === "offline") {
    return "offline";
  }
  if (environments.some((environment) => environment.connectionState === "connected")) {
    return "connected";
  }
  if (environments.some((environment) => environment.connectionState === "reconnecting")) {
    return "reconnecting";
  }
  if (environments.some((environment) => environment.connectionState === "connecting")) {
    return "connecting";
  }
  if (environments.some((environment) => environment.connectionState === "unsupported")) {
    return "unsupported";
  }
  if (environments.some((environment) => environment.connectionState === "error")) {
    return "error";
  }
  if (environments.some((environment) => environment.connectionState === "offline")) {
    return "offline";
  }
  return "available";
}

export function projectWorkspaceConnectionState(input: {
  readonly isReady: boolean;
  readonly networkStatus: NetworkStatus;
  readonly environments: ReadonlyArray<WorkspaceEnvironment>;
}): WorkspaceConnectionState {
  const activeEnvironments = input.environments.filter((environment) => environment.isEnabled);
  const failedEnvironment =
    activeEnvironments.find((environment) => environment.connectionError !== null) ??
    activeEnvironments.find((environment) => environment.awaitingApproval === true);
  const connectingEnvironments = activeEnvironments.filter(
    (environment) =>
      environment.connectionState === "connecting" ||
      environment.connectionState === "reconnecting",
  );

  return {
    isLoadingConnections: !input.isReady,
    hasConnections: input.environments.length > 0,
    hasReadyEnvironment:
      input.networkStatus !== "offline" &&
      activeEnvironments.some((environment) => environment.connectionState === "connected"),
    hasConnectingEnvironment: connectingEnvironments.length > 0,
    hasAwaitingApprovalEnvironment: failedEnvironment?.awaitingApproval === true,
    connectingEnvironments,
    connectionState: overallConnectionState(activeEnvironments, input.networkStatus),
    connectionError: failedEnvironment?.connectionError ?? null,
    ...(failedEnvironment?.i18nConnectionError !== undefined
      ? { i18nConnectionError: failedEnvironment.i18nConnectionError }
      : {}),
    networkStatus: input.networkStatus,
  };
}

export function projectWorkspaceState(input: {
  readonly isReady: boolean;
  readonly networkStatus: NetworkStatus;
  readonly environments: ReadonlyArray<WorkspaceEnvironment>;
  readonly shellSummary: EnvironmentShellSummary;
  readonly hasFreshShellSnapshot: boolean;
  readonly hasActivelySyncingEnvironment: boolean;
  readonly hasSyncingConnectedEnvironment: boolean;
}): WorkspaceState {
  return {
    ...projectWorkspaceConnectionState(input),
    hasLoadedShellSnapshot: input.shellSummary.hasSnapshot,
    hasFreshShellSnapshot: input.hasFreshShellSnapshot,
    hasActivelySyncingEnvironment: input.hasActivelySyncingEnvironment,
    hasPendingShellSnapshot: input.shellSummary.hasSynchronizingShell,
    hasSyncingConnectedEnvironment: input.hasSyncingConnectedEnvironment,
    shellSnapshotError: input.shellSummary.firstError,
  };
}

// The atom starts at EMPTY_SHELL_STATE itself; any state after the cache read is a new object.
export function isEnvironmentShellPending(state: EnvironmentShellState): boolean {
  if (Option.isSome(state.error)) return false;
  return state === EMPTY_SHELL_STATE || state.status === "synchronizing";
}

/**
 * Whether a non-fresh environment should display loading skeletons: only during initial/clean
 * connection attempts or healthy connected shell synchronization (including while its fresh
 * snapshot is held by `steadyShells`), never during failed backoff retries, offline, blocked,
 * or shell subscription errors.
 */
export function isEnvironmentActivelySyncingShell(input: {
  readonly connection: SupervisorConnectionState;
  readonly shell: Pick<EnvironmentShellState, "status" | "error" | "fresh">;
  readonly isSteadyFresh: boolean;
}): boolean {
  if (input.isSteadyFresh) return false;
  if (Option.isSome(input.shell.error)) return false;
  if (input.connection === AVAILABLE_CONNECTION_STATE) return true;
  if (input.connection.phase === "connecting" || input.connection.phase === "backoff") {
    return input.connection.lastFailure === null;
  }
  if (input.connection.phase === "connected") {
    return (
      input.shell.status === "synchronizing" ||
      input.shell.fresh ||
      input.shell === EMPTY_SHELL_STATE
    );
  }
  return false;
}

export interface ScopedEnvironmentUnavailableInput {
  readonly networkStatus: NetworkStatus;
  readonly environment: WorkspaceEnvironment;
  readonly hasFreshSnapshot: boolean;
  readonly isActivelySyncing: boolean;
  readonly shellError: string | null;
}

/**
 * True when a selected environment has no fresh displayed data, no clean connect/sync is in
 * flight, and it is disabled, offline, blocked, in failed backoff, or hit a shell sync error.
 */
export function isSelectedEnvironmentUnavailable(
  input: ScopedEnvironmentUnavailableInput,
): boolean {
  if (input.hasFreshSnapshot || input.isActivelySyncing) return false;
  if (input.shellError !== null) return true;
  if (!input.environment.isEnabled) return true;
  return (
    input.networkStatus === "offline" ||
    input.environment.connectionState === "available" ||
    input.environment.connectionState === "offline" ||
    input.environment.connectionState === "error" ||
    input.environment.connectionState === "unsupported" ||
    (input.environment.connectionState === "reconnecting" &&
      input.environment.connectionError !== null)
  );
}

/**
 * True when saved environments have no fresh displayed data, no clean connect/sync is in flight,
 * and the workspace is offline, blocked, in failed backoff, or hit a shell sync error.
 */
export function isWorkspaceEnvironmentUnavailable(state: WorkspaceState): boolean {
  if (!state.hasConnections || state.hasFreshShellSnapshot || state.hasActivelySyncingEnvironment) {
    return false;
  }
  if (state.shellSnapshotError !== null) return true;
  return (
    state.networkStatus === "offline" ||
    state.connectionState === "available" ||
    state.connectionState === "offline" ||
    state.connectionState === "error" ||
    state.connectionState === "unsupported" ||
    (state.connectionState === "reconnecting" && state.connectionError !== null)
  );
}

// Only active clean attempts and healthy connected syncs keep the catalog pending; failed backoff
// retries and errored shell subscriptions settle into unavailable or empty states.
export function isWorkspaceCatalogPending(state: WorkspaceState): boolean {
  return (
    state.networkStatus !== "offline" &&
    (state.hasActivelySyncingEnvironment || state.hasSyncingConnectedEnvironment)
  );
}

export type ServerConfigByEnvironmentId = ReadonlyMap<EnvironmentId, ServerConfig>;
