import { useEffect, useSyncExternalStore } from "react";

const claims = new Set<symbol>();
const listeners = new Set<() => void>();

const emit = () => {
  for (const listener of listeners) listener();
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};

const isProminent = () => claims.size > 0;

/** Asks for the stronger shimmer while `active`, as the new thread page does. */
export function useAmbientShimmerProminence(active: boolean) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- registers with the app-level shimmer store
  useEffect(() => {
    if (!active) return;
    const claim = Symbol("ambient-shimmer-prominence");
    claims.add(claim);
    emit();
    return () => {
      claims.delete(claim);
      emit();
    };
  }, [active]);
}

export function useAmbientShimmerProminent(): boolean {
  return useSyncExternalStore(subscribe, isProminent, () => false);
}
