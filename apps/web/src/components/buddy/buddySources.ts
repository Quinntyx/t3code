import { useAtomValue } from "@effect/atom-react";
import {
  type DeviceHubAccess,
  resolveDeviceHubAccess,
  withDeviceHubQuery,
} from "@t3tools/client-runtime/state/deviceHubAccess";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { AsyncResult, Atom, AtomRegistry } from "effect/reactivity";
import { msg } from "gt-react";
import { useEffect, useSyncExternalStore } from "react";

import { connectionAtomRuntime } from "~/connection/runtime";
import { m } from "~/i18n/messages";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import {
  type EnvironmentPresentation,
  useEnvironments,
  usePrimaryEnvironment,
} from "~/state/environments";
import { environmentSession } from "~/state/session";

import { buddyCharacterFrom, type BuddyCharacter, type BuddyManifest } from "./buddyCharacters";

export interface BuddyFolderEntry {
  readonly folderPath: string;
  readonly buddies: ReadonlyArray<BuddyManifest>;
  readonly error: string | null;
}

/** A buddy setting references a folder-loaded buddy as `<folderPath>|<buddyId>`. */
const REF_SEPARATOR = "|";

const buddyRefFor = (folderPath: string, buddyId: string): string =>
  `${folderPath}${REF_SEPARATOR}${buddyId}`;

export function buildBuddyClipUrl(
  access: DeviceHubAccess,
  folderPath: string,
  buddyId: string,
  file: string,
  revision: number,
): string {
  const query = new URLSearchParams({
    folder: folderPath,
    buddy: buddyId,
    file,
    v: String(revision),
  });
  return withDeviceHubQuery(`${access.httpBase}/clip?${query.toString()}`, access);
}

const folderBuddyCharacter = (
  access: DeviceHubAccess,
  folderPath: string,
  manifest: BuddyManifest,
  revision: number,
): BuddyCharacter =>
  buddyCharacterFrom(
    manifest,
    (file) => buildBuddyClipUrl(access, folderPath, manifest.id, file, revision),
    { credentials: access.credentials },
  );

const buddyMediaAccessAtom = Atom.family((environmentId: EnvironmentId) =>
  connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId)),
      );
      if (prepared === null) return Effect.never;
      return resolveDeviceHubAccess({ prepared, hubBasePath: "/api/buddies" });
    })
    .pipe(Atom.setIdleTTL(60_000), Atom.withLabel(`buddy-media-access:${environmentId}`)),
);

const EMPTY_ACCESS_ATOM = Atom.make(AsyncResult.initial<DeviceHubAccess, never>()).pipe(
  Atom.withLabel("buddy-media-access:empty"),
);

function useBuddyMediaAccess(environmentId: EnvironmentId | null): DeviceHubAccess | null {
  const result = useAtomValue(
    environmentId === null ? EMPTY_ACCESS_ATOM : buddyMediaAccessAtom(environmentId),
  );
  return AsyncResult.isSuccess(result) ? result.value : null;
}

function renewBuddyMediaAccess(environmentId: EnvironmentId): Promise<DeviceHubAccess | null> {
  const atom = buddyMediaAccessAtom(environmentId);
  appAtomRegistry.refresh(atom);
  return Effect.runPromise(
    AtomRegistry.getResult(appAtomRegistry, atom, { suspendOnWaiting: true }).pipe(
      Effect.timeout("10 seconds"),
      Effect.orElseSucceed(() => null),
    ),
  );
}

/** The environment whose configured `buddyFolders` supply custom buddies. */
export function useBuddyEnvironment(): EnvironmentPresentation | null {
  const primary = usePrimaryEnvironment();
  const { environments } = useEnvironments();
  if (primary !== null) return primary;
  return (
    environments.find(
      (environment) =>
        environment.connection.phase === "connected" && environment.serverConfig !== null,
    ) ?? null
  );
}

export interface BuddyCatalogState {
  readonly key: string;
  readonly folders: ReadonlyArray<BuddyFolderEntry>;
  readonly loading: boolean;
  /** Bumped on explicit reloads so clip URLs bust cached blobs. */
  readonly revision: number;
}

export interface BuddyCatalogStore {
  readonly getSnapshot: () => BuddyCatalogState;
  readonly subscribe: (listener: () => void) => () => void;
  readonly clear: () => void;
  readonly load: (input: {
    readonly key: string;
    readonly folderPaths: ReadonlyArray<string>;
    readonly access: DeviceHubAccess;
    readonly renewAccess?: () => Promise<DeviceHubAccess | null>;
    readonly bumpRevision?: boolean;
  }) => Promise<void>;
}

export function createBuddyCatalogStore(
  fetchImpl: typeof fetch = globalThis.fetch,
): BuddyCatalogStore {
  let state: BuddyCatalogState = { key: "", folders: [], loading: false, revision: 0 };
  const listeners = new Set<() => void>();
  let requestSequence = 0;

  const publish = (next: BuddyCatalogState) => {
    state = next;
    for (const listener of listeners) listener();
  };

  const fetchCatalog = async (access: DeviceHubAccess) =>
    fetchImpl(withDeviceHubQuery(`${access.httpBase}/catalog`, access), {
      cache: "no-store",
      credentials: access.credentials ? "include" : "same-origin",
    });

  return {
    getSnapshot: () => state,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    clear: () => {
      requestSequence += 1;
      if (state.key === "" && state.folders.length === 0 && !state.loading) return;
      publish({ key: "", folders: [], loading: false, revision: state.revision });
    },
    load: async ({ key, folderPaths, access, renewAccess, bumpRevision }) => {
      if (folderPaths.length === 0) {
        requestSequence += 1;
        publish({ key: "", folders: [], loading: false, revision: state.revision });
        return;
      }
      const requestId = ++requestSequence;
      const revision = bumpRevision ? state.revision + 1 : state.revision;
      publish({ ...state, key, loading: true, revision });
      try {
        let response = await fetchCatalog(access);
        if (response.status === 401 && !access.credentials && renewAccess) {
          const renewed = await renewAccess();
          if (requestId !== requestSequence) return;
          if (renewed !== null) {
            response = await fetchCatalog(renewed);
          }
        }
        if (!response.ok) throw new Error(`Buddy folders failed with ${response.status}.`);
        const body = (await response.json()) as { folders: ReadonlyArray<BuddyFolderEntry> };
        if (requestId !== requestSequence) return;
        publish({ key, folders: body.folders, loading: false, revision });
      } catch (error: unknown) {
        if (requestId !== requestSequence) return;
        console.error("[BUDDY] Could not read buddy folders.", error);
        publish({
          key,
          loading: false,
          revision,
          folders: folderPaths.map((folderPath) => ({
            folderPath,
            buddies: [],
            error: m(msg("Could not read this folder.")),
          })),
        });
      }
    },
  };
}

// One catalog for the whole app: the overlay and the settings picker share it,
// so a reload in either place shows up in both.
const sharedBuddyCatalogStore = createBuddyCatalogStore();

export interface BuddyCatalog {
  /** Buddies loaded from configured folders, keyed by `<folderPath>|<buddyId>`. */
  readonly characters: ReadonlyMap<string, BuddyCharacter>;
  readonly folders: ReadonlyArray<BuddyFolderEntry>;
  readonly loading: boolean;
  readonly refresh: () => void;
}

export function useBuddyCatalog(
  environmentId: EnvironmentId | null,
  folderPaths: ReadonlyArray<string>,
  options?: { readonly enabled?: boolean },
): BuddyCatalog {
  const enabled = options?.enabled ?? true;
  const access = useBuddyMediaAccess(enabled && folderPaths.length > 0 ? environmentId : null);
  const key =
    environmentId !== null && folderPaths.length > 0
      ? `${environmentId}\0${folderPaths.join("\n")}`
      : "";
  const state = useSyncExternalStore(
    sharedBuddyCatalogStore.subscribe,
    sharedBuddyCatalogStore.getSnapshot,
    sharedBuddyCatalogStore.getSnapshot,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads configured buddy folders over HTTP when the list or environment changes
  useEffect(() => {
    if (!enabled) return;
    if (key.length === 0) {
      sharedBuddyCatalogStore.clear();
      return;
    }
    if (access === null || environmentId === null) return;
    const snapshot = sharedBuddyCatalogStore.getSnapshot();
    if (snapshot.key === key && !snapshot.loading) return;
    void sharedBuddyCatalogStore.load({
      key,
      folderPaths,
      access,
      renewAccess: () => renewBuddyMediaAccess(environmentId),
    });
  }, [enabled, key, access, environmentId, folderPaths]);

  const characters = new Map<string, BuddyCharacter>();
  if (access !== null && state.key === key) {
    for (const entry of state.folders) {
      for (const manifest of entry.buddies) {
        characters.set(
          buddyRefFor(entry.folderPath, manifest.id),
          folderBuddyCharacter(access, entry.folderPath, manifest, state.revision),
        );
      }
    }
  }

  return {
    characters,
    folders: state.key === key ? state.folders : [],
    loading: state.loading,
    refresh: () => {
      if (key.length === 0 || access === null || environmentId === null) {
        sharedBuddyCatalogStore.clear();
        return;
      }
      void sharedBuddyCatalogStore.load({
        key,
        folderPaths,
        access,
        renewAccess: () => renewBuddyMediaAccess(environmentId),
        bumpRevision: true,
      });
    },
  };
}
