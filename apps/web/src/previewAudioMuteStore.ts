import * as Schema from "effect/Schema";
import { useEffect, useSyncExternalStore } from "react";
import { create } from "zustand";

import {
  readLocalStorageValue,
  subscribeLocalStorageKey,
  writeLocalStorageValue,
} from "./hooks/useLocalStorage";

const STORAGE_KEY = "t3code:preview-audio-muted:v1";
const MutedTabs = Schema.Array(Schema.String);

const readMuted = (): ReadonlySet<string> =>
  new Set(readLocalStorageValue(STORAGE_KEY, [], MutedTabs));

interface PreviewAudioMuteState {
  readonly muted: ReadonlySet<string>;
  readonly setMuted: (sessionTabId: string, muted: boolean) => void;
  readonly toggle: (sessionTabId: string) => void;
}

/**
 * Silences a streamed tab in this browser, which is where its sound plays. One update path: the
 * store never writes state itself, it only follows storage, so the same-window notification
 * `writeLocalStorageValue` dispatches is the single time a change lands.
 */
export const usePreviewAudioMuteStore = create<PreviewAudioMuteState>((_set, get) => ({
  muted: readMuted(),
  setMuted: (sessionTabId, muted) => {
    if (get().muted.has(sessionTabId) === muted) return;
    writeLocalStorageValue(
      STORAGE_KEY,
      (current: ReadonlyArray<string>) =>
        muted
          ? current.includes(sessionTabId)
            ? current
            : [...current, sessionTabId]
          : current.filter((entry) => entry !== sessionTabId),
      [],
      MutedTabs,
    );
  },
  toggle: (sessionTabId) => {
    get().setMuted(sessionTabId, !get().muted.has(sessionTabId));
  },
}));

// Every change reaches the store here, this window's own writes included.
if (typeof window !== "undefined") {
  subscribeLocalStorageKey(STORAGE_KEY, () => {
    const next = readMuted();
    const current = usePreviewAudioMuteStore.getState().muted;
    if (next.size === current.size && [...next].every((entry) => current.has(entry))) return;
    usePreviewAudioMuteStore.setState({ muted: next });
  });
}

/**
 * Which mounted surfaces could play each tab, oldest claim first, plus those that outrank
 * everything while they exist (a popped-out window, which the user opened deliberately).
 * The newest claimant plays, so a mini player appearing over an open panel takes the sound and
 * closing it hands the sound back rather than leaving the tab silent.
 */
const claims = new Map<string, Array<string>>();
const pinned = new Set<string>();

const ownerListeners = new Set<() => void>();
const emitOwnerChange = () => {
  for (const listener of ownerListeners) listener();
};
const subscribeOwners = (listener: () => void) => {
  ownerListeners.add(listener);
  return () => ownerListeners.delete(listener);
};

export function claimPreviewAudio(tabId: string, owner: string, outranksAll = false): void {
  const held = claims.get(tabId) ?? [];
  if (held.at(-1) === owner && outranksAll === pinned.has(owner)) return;
  // A surface shows one tab at a time, so moving on gives up whatever it held.
  for (const [key, owners] of claims)
    if (key !== tabId && owners.includes(owner))
      claims.set(
        key,
        owners.filter((each) => each !== owner),
      );
  claims.set(tabId, [...held.filter((each) => each !== owner), owner]);
  if (outranksAll) pinned.add(owner);
  else pinned.delete(owner);
  emitOwnerChange();
}

export function releasePreviewAudio(tabId: string, owner: string): void {
  const held = claims.get(tabId);
  if (!held?.includes(owner)) return;
  const rest = held.filter((each) => each !== owner);
  if (rest.length === 0) claims.delete(tabId);
  else claims.set(tabId, rest);
  pinned.delete(owner);
  emitOwnerChange();
}

/** The surface that plays this tab, or null when none has claimed it. */
export const previewAudioOwner = (tabId: string): string | null => {
  const held = claims.get(tabId);
  if (!held) return null;
  for (let index = held.length - 1; index >= 0; index -= 1)
    if (pinned.has(held[index]!)) return held[index]!;
  return held.at(-1) ?? null;
};

export function usePreviewAudioMuted(tabId: string): boolean {
  return usePreviewAudioMuteStore((state) => state.muted.has(tabId));
}

/**
 * Tabs whose capture cannot run: an insecure origin has no encoder, and a tab the desktop
 * renders has no tracker. The server reports both, so a mute control can say why it is dead.
 */
interface PreviewAudioAvailabilityState {
  readonly unavailable: ReadonlySet<string>;
  readonly setUnavailable: (tabId: string, unavailable: boolean) => void;
}

export const usePreviewAudioAvailabilityStore = create<PreviewAudioAvailabilityState>(
  (set, get) => ({
    unavailable: new Set(),
    setUnavailable: (tabId, unavailable) => {
      if (get().unavailable.has(tabId) === unavailable) return;
      const next = new Set(get().unavailable);
      if (unavailable) next.add(tabId);
      else next.delete(tabId);
      set({ unavailable: next });
    },
  }),
);

/**
 * Declares this surface as a playback candidate while it is shown, and reports whether it is
 * the one that currently plays. Each activation re-claims, which is how the newest surface wins.
 */
export function useOwnsPreviewAudio(tabId: string, owner: string, active: boolean): boolean {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- holds this surface's claim in the shared playback registry while it is mounted and shown
  useEffect(() => {
    if (!active) return;
    // An activation is a new claim, so mounting or a dependency change is enough to take over.
    claimPreviewAudio(tabId, owner);
    return () => releasePreviewAudio(tabId, owner);
  }, [tabId, owner, active]);
  const held = useSyncExternalStore(
    subscribeOwners,
    () => previewAudioOwner(tabId) === owner,
    () => false,
  );
  return active && held;
}
