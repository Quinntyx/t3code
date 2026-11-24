import { AVAILABLE_CONNECTION_STATE } from "@t3tools/client-runtime/connection";
import { enabledEnvironmentIds } from "@t3tools/client-runtime/state/connections";
import {
  createEnvironmentShellAtoms,
  createEnvironmentShellSummaryAtom,
  createEnvironmentSnapshotAtom,
  createFreshShellEnvironmentIdsAtom,
  EMPTY_SHELL_STATE,
  type EnvironmentShellState,
} from "@t3tools/client-runtime/state/shell";
import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";

import { environmentCatalog } from "../connection/catalog";
import { connectionAtomRuntime } from "../connection/runtime";

export const environmentShell = createEnvironmentShellAtoms(connectionAtomRuntime);
export const environmentSnapshotAtom = createEnvironmentSnapshotAtom(environmentShell.stateAtom);
export const environmentShellSummaryAtom = createEnvironmentShellSummaryAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  shellStateValueAtom: environmentShell.stateValueAtom,
});
export const freshShellEnvironmentIdsAtom = createFreshShellEnvironmentIdsAtom({
  catalogValueAtom: environmentCatalog.catalogValueAtom,
  freshAtom: environmentShell.freshAtom,
});

const EMPTY_ENVIRONMENT_ID_SET: ReadonlySet<EnvironmentId> = new Set();

/**
 * Enabled environments that have not yet completed a live sync in the current foreground
 * session and are actively connecting or synchronizing (excluding backoff/offline/blocked).
 */
export const syncingShellEnvironmentIdsAtom = (() => {
  let previous: ReadonlySet<EnvironmentId> = EMPTY_ENVIRONMENT_ID_SET;
  return Atom.make((get) => {
    const catalog = get(environmentCatalog.catalogValueAtom);
    if (!catalog.isReady || get(environmentCatalog.networkStatusValueAtom) === "offline") {
      previous = EMPTY_ENVIRONMENT_ID_SET;
      return previous;
    }
    const next = new Set<EnvironmentId>();
    for (const environmentId of enabledEnvironmentIds(catalog)) {
      if (get(environmentShell.freshAtom(environmentId))) continue;
      const connection = AsyncResult.getOrElse(
        get(environmentCatalog.stateAtom(environmentId)),
        () => AVAILABLE_CONNECTION_STATE,
      );
      if (
        connection === AVAILABLE_CONNECTION_STATE ||
        connection.phase === "connecting" ||
        connection.phase === "connected"
      ) {
        next.add(environmentId);
      }
    }
    if (next.size === previous.size && [...next].every((id) => previous.has(id))) return previous;
    previous = next;
    return next;
  }).pipe(Atom.withLabel("mobile-syncing-shell-environment-ids"));
})();

const EMPTY_ENVIRONMENT_SHELL_STATE_ATOM = Atom.make<EnvironmentShellState>(EMPTY_SHELL_STATE);

const shellStatus = (state: EnvironmentShellState) => state.status;
const shellHasError = (state: EnvironmentShellState) => Option.isSome(state.error);
// The empty placeholder stands until the environment has read its cached shell.
const shellCacheRead = (state: EnvironmentShellState) => state !== EMPTY_SHELL_STATE;

export function useEnvironmentShellReadiness(environmentId: EnvironmentId | null) {
  const atom =
    environmentId === null
      ? EMPTY_ENVIRONMENT_SHELL_STATE_ATOM
      : environmentShell.stateValueAtom(environmentId);
  return {
    status: useAtomValue(atom, shellStatus),
    hasError: useAtomValue(atom, shellHasError),
    cacheRead: useAtomValue(atom, shellCacheRead),
  };
}
