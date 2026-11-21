import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

import { resolveStorage } from "../../lib/storage";

type NotebookViewState = {
  kernelId?: string;
  collapsed: Record<string, boolean>;
};

export const useNotebookStore = create<{
  byThread: Record<string, NotebookViewState>;
  selectKernel: (ref: ScopedThreadRef, kernelId: string) => void;
  toggle: (ref: ScopedThreadRef, key: string) => void;
}>()(
  persist(
    (set) => ({
      byThread: {},
      selectKernel: (ref, kernelId) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          return {
            byThread: {
              ...state.byThread,
              [key]: { collapsed: {}, ...state.byThread[key], kernelId },
            },
          };
        }),
      toggle: (ref, cellKey) =>
        set((state) => {
          const key = scopedThreadKey(ref);
          const current = state.byThread[key];
          return {
            byThread: {
              ...state.byThread,
              [key]: {
                ...current,
                collapsed: { ...current?.collapsed, [cellKey]: !current?.collapsed[cellKey] },
              },
            },
          };
        }),
    }),
    {
      name: "t3code:notebook-view:v1",
      storage: createJSONStorage(() =>
        resolveStorage(typeof window !== "undefined" ? window.localStorage : undefined),
      ),
      partialize: (state) => ({ byThread: state.byThread }),
    },
  ),
);
