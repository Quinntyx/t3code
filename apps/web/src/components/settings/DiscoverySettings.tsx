import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { directoryDiscovery } from "../../state/discover";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function DiscoverySettings() {
  const state = useAtomValue(directoryDiscovery.stateValueAtom);
  const refresh = useAtomCommand(directoryDiscovery.refresh, { reportFailure: false });
  const disconnect = useAtomCommand(directoryDiscovery.disconnect, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: "refresh" | "disconnect") => {
    if (pending) return;
    if (
      action === "disconnect" &&
      !(await requestConfirmDialog(
        "Disconnect discovery on this device? Its discovery listing will be removed. Existing direct environment connections remain.",
        { variant: "destructive" },
      ))
    )
      return;
    setPending(true);
    setError(null);
    const result = action === "refresh" ? await refresh() : await disconnect();
    setPending(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not update discovery.");
    }
  };
  return (
    <SettingsSection title="Discovery">
      <SettingsRow
        title={state.directory?.label ?? "No discovery directory"}
        description={
          state.directory
            ? `${state.directory.brokerOrigin} · ${state.hosts.length} discovered environments. Environments appear in the list above.`
            : "Use Add environment to paste a discovery enrollment URL. Joining on desktop also makes its local environment discoverable."
        }
        control={
          state.directory ? (
            <div className="flex flex-wrap gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={pending || state.refreshing}
                onClick={() => void run("refresh")}
              >
                {state.refreshing ? "Refreshing…" : "Refresh"}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => void run("disconnect")}
              >
                Disconnect discovery
              </Button>
            </div>
          ) : undefined
        }
      />
      {(error ?? state.error) ? (
        <SettingsRow title="Discovery error" description={error ?? state.error} />
      ) : null}
    </SettingsSection>
  );
}
