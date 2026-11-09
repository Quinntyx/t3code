import type { Atom, AtomRegistry } from "effect/reactivity";

/** Mounts `atom` only until `pick` yields a value, so one read does not keep a subscription open. */
export function awaitAtomValue<A, B>(
  registry: AtomRegistry.AtomRegistry,
  atom: Atom.Atom<A>,
  pick: (value: A) => B | null,
  signal: AbortSignal,
): Promise<B> {
  return new Promise((resolve, reject) => {
    const release = registry.mount(atom);
    let settled = false;
    let unsubscribe: (() => void) | undefined;
    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      unsubscribe?.();
      release();
      settle();
    };
    const abort = () => finish(() => reject(new Error("Thread history is still synchronizing.")));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort);
    unsubscribe = registry.subscribe(
      atom,
      (value) => {
        const picked = pick(value);
        if (picked !== null) finish(() => resolve(picked));
      },
      { immediate: true },
    );
    // A value already present settles during the immediate callback, before unsubscribe exists.
    if (settled) unsubscribe();
  });
}
