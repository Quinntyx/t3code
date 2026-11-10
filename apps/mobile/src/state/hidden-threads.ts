import { AsyncResult, Atom } from "effect/reactivity";

import { mobilePreferencesAtom } from "./preferences";

const NO_DEVICE_HIDES: ReadonlySet<string> = new Set();
export const showHiddenThreadsAtom = Atom.make(false).pipe(Atom.keepAlive);
export const hiddenThreadKeysAtom = Atom.make((get) => {
  const result = get(mobilePreferencesAtom);
  return new Set(AsyncResult.isSuccess(result) ? (result.value.hiddenThreadKeys ?? []) : []);
}).pipe(Atom.keepAlive);
export const deviceHiddenThreadKeysAtom = Atom.make((get) =>
  get(showHiddenThreadsAtom) ? NO_DEVICE_HIDES : get(hiddenThreadKeysAtom),
);
