import { useEffect, useSyncExternalStore } from "react";

import { buddyCharacterFrom, type BuddyCharacter, type BuddyManifest } from "./buddyCharacters";

export interface BuddySourceEntry {
  readonly repositoryUrl: string;
  readonly buddies: ReadonlyArray<BuddyManifest>;
  readonly error: string | null;
}

/** A buddy setting references a downloaded buddy as `<repositoryUrl>|<buddyId>`. */
const REF_SEPARATOR = "|";

const buddyRefFor = (repositoryUrl: string, buddyId: string): string =>
  `${repositoryUrl}${REF_SEPARATOR}${buddyId}`;

const clipUrl = (repositoryUrl: string, buddyId: string, file: string): string => {
  const query = new URLSearchParams({ source: repositoryUrl, buddy: buddyId, file });
  return `/api/buddies/clip?${query.toString()}`;
};

const remoteBuddyCharacter = (repositoryUrl: string, manifest: BuddyManifest): BuddyCharacter =>
  buddyCharacterFrom(manifest, (file) => clipUrl(repositoryUrl, manifest.id, file));

// One catalog for the whole app: the overlay and the settings picker share it,
// so a reload in either place shows up in both.
interface CatalogState {
  readonly key: string;
  readonly sources: ReadonlyArray<BuddySourceEntry>;
  readonly loading: boolean;
  /** Bumped whenever a fetch should run again. */
  readonly generation: number;
}

let catalogState: CatalogState = { key: "", sources: [], loading: false, generation: 0 };
const listeners = new Set<() => void>();
let loadingKey: string | null = null;
let pulledThisSession = false;

const publish = (next: CatalogState) => {
  catalogState = next;
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const load = (key: string, refresh: boolean) => {
  if (loadingKey === key) return;
  loadingKey = key;
  const urls = key.length === 0 ? [] : key.split("\n");
  if (urls.length === 0) {
    loadingKey = null;
    publish({ key, sources: [], loading: false, generation: catalogState.generation });
    return;
  }
  const query = new URLSearchParams();
  for (const url of urls) query.append("source", url);
  if (refresh) query.set("refresh", "1");
  publish({ ...catalogState, key, loading: true });
  void fetch(`/api/buddies/catalog?${query.toString()}`)
    .then((response) => {
      if (!response.ok) throw new Error(`Buddy sources failed with ${response.status}.`);
      return response.json() as Promise<{ sources: ReadonlyArray<BuddySourceEntry> }>;
    })
    .then((body) => {
      loadingKey = null;
      publish({ ...catalogState, key, sources: body.sources, loading: false });
    })
    .catch((error: unknown) => {
      loadingKey = null;
      console.error("[BUDDY] Could not read buddy sources.", error);
      publish({
        ...catalogState,
        key,
        loading: false,
        sources: urls.map((repositoryUrl) => ({
          repositoryUrl,
          buddies: [],
          error: "Could not read this source.",
        })),
      });
    });
};

export interface BuddyCatalog {
  /** Downloaded buddies, keyed by their `<repositoryUrl>|<buddyId>` reference. */
  readonly characters: ReadonlyMap<string, BuddyCharacter>;
  readonly sources: ReadonlyArray<BuddySourceEntry>;
  readonly loading: boolean;
  readonly refresh: () => void;
}

export function useBuddyCatalog(repositoryUrls: ReadonlyArray<string>): BuddyCatalog {
  const key = repositoryUrls.join("\n");
  const state = useSyncExternalStore(
    subscribe,
    () => catalogState,
    () => catalogState,
  );

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reads the source clones over HTTP when the configured list changes
  useEffect(() => {
    if (key.length === 0) return;
    if (catalogState.key === key && !catalogState.loading) return;
    // The first read of a session pulls every source; later ones reuse the clones.
    const refresh = !pulledThisSession;
    pulledThisSession = true;
    load(key, refresh);
  }, [key]);

  const characters = new Map<string, BuddyCharacter>();
  for (const entry of state.sources) {
    for (const manifest of entry.buddies) {
      characters.set(
        buddyRefFor(entry.repositoryUrl, manifest.id),
        remoteBuddyCharacter(entry.repositoryUrl, manifest),
      );
    }
  }

  return {
    characters,
    sources: state.sources,
    loading: state.loading,
    refresh: () => {
      pulledThisSession = true;
      load(key, true);
    },
  };
}
