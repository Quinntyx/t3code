import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

/** The rail's sections, top to bottom; each opens its own card. */
export const THREAD_DETAILS_RAIL_SECTIONS = ["usage", "agents", "sideChats"] as const;
export type ThreadDetailsRailSection = (typeof THREAD_DETAILS_RAIL_SECTIONS)[number];

/**
 * Pointer travel only. The rail and the card both report moves, so the delay just has to outlast a
 * pointer crossing the gap between them; the card reports entering before the rail reports leaving.
 */
const CLOSE_DELAY_MS = 240;

interface ThreadDetailsRailStore {
  /** The section whose card shows, per thread, while the pointer is on the rail or that card. */
  hoveredSectionByThreadKey: Readonly<Record<string, ThreadDetailsRailSection>>;
  setHovered: (ref: ScopedThreadRef, section: ThreadDetailsRailSection | null) => void;
}

let closeTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Watching is transient, so it never touches the pinned flag in rightPanelStore, which persists.
 * One timer covers every thread: only the rail that is under the pointer can schedule a close.
 */
export const useThreadDetailsRailStore = create<ThreadDetailsRailStore>()((set) => ({
  hoveredSectionByThreadKey: {},
  setHovered: (ref, section) => {
    const key = scopedThreadKey(ref);
    if (closeTimer !== null) {
      clearTimeout(closeTimer);
      closeTimer = null;
    }
    if (section !== null) {
      set((state) =>
        state.hoveredSectionByThreadKey[key] === section
          ? state
          : { hoveredSectionByThreadKey: { ...state.hoveredSectionByThreadKey, [key]: section } },
      );
      return;
    }
    closeTimer = setTimeout(() => {
      closeTimer = null;
      set((state) => {
        if (state.hoveredSectionByThreadKey[key] === undefined) return state;
        const { [key]: _closed, ...rest } = state.hoveredSectionByThreadKey;
        return { hoveredSectionByThreadKey: rest };
      });
    }, CLOSE_DELAY_MS);
  },
}));

export function selectThreadDetailsRailSection(
  hoveredSectionByThreadKey: Readonly<Record<string, ThreadDetailsRailSection>>,
  ref: ScopedThreadRef | null | undefined,
): ThreadDetailsRailSection | null {
  return ref ? (hoveredSectionByThreadKey[scopedThreadKey(ref)] ?? null) : null;
}

const MAX_PINNED_THREADS = 200;

interface ThreadDetailsRailPinStore {
  /** Threads whose full details card stays open beside the rail. */
  pinnedByThreadKey: Readonly<Record<string, true>>;
  togglePinned: (ref: ScopedThreadRef) => void;
}

/** The rail's own pin, so the stock card's per-thread open state is never rewritten by it. */
export const useThreadDetailsRailPinStore = create<ThreadDetailsRailPinStore>()(
  persist(
    (set) => ({
      pinnedByThreadKey: {},
      togglePinned: (ref) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          if (state.pinnedByThreadKey[key]) {
            const { [key]: _unpinned, ...rest } = state.pinnedByThreadKey;
            return { pinnedByThreadKey: rest };
          }
          // Keep the newest pins; a thread deleted while pinned would otherwise stay forever.
          const kept = Object.keys(state.pinnedByThreadKey).slice(-(MAX_PINNED_THREADS - 1));
          return {
            pinnedByThreadKey: Object.fromEntries(
              [...kept, key].map((pinnedKey) => [pinnedKey, true as const]),
            ),
          };
        }),
    }),
    {
      name: "t3code:thread-details-rail-pins:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: ({ pinnedByThreadKey }) => ({ pinnedByThreadKey }),
    },
  ),
);

export function selectThreadDetailsRailPinned(
  pinnedByThreadKey: Readonly<Record<string, true>>,
  ref: ScopedThreadRef | null | undefined,
): boolean {
  return ref ? pinnedByThreadKey[scopedThreadKey(ref)] === true : false;
}
