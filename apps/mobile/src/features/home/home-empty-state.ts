import { shellErrorText } from "@t3tools/client-runtime/state/shell";
import { msg } from "gt-react-native";

import { m, type MessageResolver } from "../../i18n/messages";
import {
  isSelectedEnvironmentUnavailable,
  isWorkspaceCatalogPending,
  isWorkspaceEnvironmentUnavailable,
  type ScopedEnvironmentUnavailableInput,
  type WorkspaceState,
} from "../../state/workspaceModel";
import { runtimeConnectionErrorText } from "../connection/environmentStatusText";

export interface HomeEmptyState {
  readonly title: string;
  readonly detail: string;
  readonly loading: boolean;
  readonly showsAddEnvironment: boolean;
}

function unavailableEnvironmentEmptyState(
  input: {
    readonly connectionState: WorkspaceState["connectionState"];
    readonly connectionError: string | null;
    readonly i18nConnectionError?: WorkspaceState["i18nConnectionError"];
    readonly awaitingApproval?: boolean;
    readonly shellError: string | null;
  },
  resolve: MessageResolver,
): Omit<HomeEmptyState, "showsAddEnvironment"> {
  const connectionError = runtimeConnectionErrorText(input, resolve);
  if (input.awaitingApproval && input.shellError === null) {
    return {
      title: resolve(msg("Waiting for approval")),
      detail: connectionError ?? resolve(msg("Waiting for approval on the host")),
      loading: true,
    };
  }
  return {
    title:
      input.connectionState === "unsupported"
        ? resolve(msg("Client not supported"))
        : resolve(msg("Environment unavailable")),
    detail:
      (input.shellError !== null ? shellErrorText(input.shellError, resolve) : null) ??
      connectionError ??
      resolve(
        msg(
          "The saved environment is offline. Check the URL or start the environment, then retry.",
        ),
      ),
    loading: false,
  };
}

export function deriveSelectedEnvironmentEmptyState(
  input: ScopedEnvironmentUnavailableInput,
  resolve: MessageResolver = m,
): Omit<HomeEmptyState, "showsAddEnvironment"> | null {
  if (!isSelectedEnvironmentUnavailable(input)) return null;
  return unavailableEnvironmentEmptyState(
    {
      connectionState: input.environment.connectionState,
      connectionError: input.environment.connectionError,
      ...(input.environment.i18nConnectionError === undefined
        ? {}
        : { i18nConnectionError: input.environment.i18nConnectionError }),
      ...(input.environment.awaitingApproval ? { awaitingApproval: true } : {}),
      shellError: input.shellError,
    },
    resolve,
  );
}

export function deriveHomeEmptyState(
  catalogState: WorkspaceState,
  projectCount: number,
  resolve: MessageResolver = m,
): HomeEmptyState {
  const emptyState = deriveEmptyState(catalogState, projectCount, resolve);
  return {
    ...emptyState,
    showsAddEnvironment: !emptyState.loading && !catalogState.hasReadyEnvironment,
  };
}

function deriveEmptyState(
  catalogState: WorkspaceState,
  projectCount: number,
  resolve: MessageResolver,
): Omit<HomeEmptyState, "showsAddEnvironment"> {
  if (catalogState.isLoadingConnections) {
    return {
      title: resolve(msg("Loading environments")),
      detail: resolve(msg("Checking saved environments on this device.")),
      loading: true,
    };
  }

  if (!catalogState.hasConnections) {
    return {
      title: resolve(msg("No environments connected")),
      detail: resolve(msg("Add an environment to load projects and start coding sessions.")),
      loading: false,
    };
  }

  if (isWorkspaceEnvironmentUnavailable(catalogState)) {
    return unavailableEnvironmentEmptyState(
      {
        connectionState: catalogState.connectionState,
        connectionError: catalogState.connectionError,
        ...(catalogState.i18nConnectionError === undefined
          ? {}
          : { i18nConnectionError: catalogState.i18nConnectionError }),
        ...(catalogState.hasAwaitingApprovalEnvironment ? { awaitingApproval: true } : {}),
        shellError: catalogState.shellSnapshotError,
      },
      resolve,
    );
  }

  if (isWorkspaceCatalogPending(catalogState)) {
    return {
      title: catalogState.hasReadyEnvironment
        ? resolve(msg("Loading threads"))
        : resolve(msg("Connecting to environment")),
      detail: resolve(msg("Loading projects and threads from the saved environment.")),
      loading: true,
    };
  }

  if (projectCount === 0 && catalogState.hasFreshShellSnapshot) {
    return {
      title: resolve(msg("No projects found")),
      detail: resolve(msg("The connected environment did not report any projects.")),
      loading: false,
    };
  }

  return {
    title: resolve(msg("No threads yet")),
    detail: resolve(
      msg("Create a task to start a new coding runtime in one of your connected projects."),
    ),
    loading: false,
  };
}
