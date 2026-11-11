import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";

import * as Dialog from "../../components/ui/Dialog";
import { hiddenThreadKeysAtom, showHiddenThreadsAtom } from "../../state/hidden-threads";
import { updateMobilePreferencesAtom } from "../../state/preferences";
import { updateHiddenThreadKeys } from "./hidden-threads";
import { showLocalThreadUndoNotice } from "./thread-undo-notice";

export function useHiddenThreads() {
  const hiddenThreadKeys = useAtomValue(hiddenThreadKeysAtom);
  const [showHidden, setShowHidden] = useAtom(showHiddenThreadsAtom);
  return { hiddenThreadKeys, showHidden, setShowHidden };
}

export function useSetThreadHidden() {
  const updatePreferences = useAtomSet(updateMobilePreferencesAtom, { mode: "promise" });
  const setHidden = async (thread: EnvironmentThreadShell, hidden: boolean): Promise<void> => {
    const saved = await updatePreferences({
      transform: (current) => ({
        hiddenThreadKeys: updateHiddenThreadKeys(current.hiddenThreadKeys ?? [], thread, hidden),
      }),
    }).then(
      () => true,
      () => false,
    );
    if (!saved) {
      Dialog.alert(
        hidden ? "Could not hide thread" : "Could not restore thread",
        "Your device could not save this change. Please try again.",
      );
      return;
    }
    if (hidden) showLocalThreadUndoNotice(() => setHidden(thread, false));
  };
  return setHidden;
}
