import { useAtom, useAtomValue } from "@effect/atom-react";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import { useGT } from "gt-react-native";

import * as Dialog from "../../components/ui/Dialog";
import { hiddenThreadKeysAtom, showHiddenThreadsAtom } from "../../state/hidden-threads";
import { saveMobilePreferences } from "../../state/preferences";
import { useAtomCommand } from "../../state/use-atom-command";
import { updateHiddenThreadKeys } from "./hidden-threads";
import { showLocalThreadUndoNotice } from "./thread-undo-notice";

export function useHiddenThreads() {
  const hiddenThreadKeys = useAtomValue(hiddenThreadKeysAtom);
  const [showHidden, setShowHidden] = useAtom(showHiddenThreadsAtom);
  return { hiddenThreadKeys, showHidden, setShowHidden };
}

export function useSetThreadHidden() {
  const gt = useGT();
  const savePreferences = useAtomCommand(saveMobilePreferences, { reportFailure: false });
  const setHidden = async (thread: EnvironmentThreadShell, hidden: boolean): Promise<void> => {
    const result = await savePreferences({
      transform: (current) => ({
        hiddenThreadKeys: updateHiddenThreadKeys(current.hiddenThreadKeys ?? [], thread, hidden),
      }),
    });
    if (result._tag !== "Success") {
      Dialog.alert(
        hidden ? gt("Could not hide thread") : gt("Could not restore thread"),
        gt("Your device could not save this change. Please try again."),
      );
      return;
    }
    if (hidden) showLocalThreadUndoNotice(() => setHidden(thread, false));
  };
  return setHidden;
}
