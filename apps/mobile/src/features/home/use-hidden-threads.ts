import { useAtom, useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useCallback } from "react";

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
  return useCallback(
    async function setHidden(thread: EnvironmentThreadShell, hidden: boolean): Promise<void> {
      try {
        await updatePreferences({
          transform: (current) => ({
            hiddenThreadKeys: updateHiddenThreadKeys(
              current.hiddenThreadKeys ?? [],
              thread,
              hidden,
            ),
          }),
        });
        if (hidden) showLocalThreadUndoNotice(() => setHidden(thread, false));
      } catch {
        Dialog.alert(
          hidden ? "Could not hide thread" : "Could not restore thread",
          "Your device could not save this change. Please try again.",
        );
      }
    },
    [updatePreferences],
  );
}
