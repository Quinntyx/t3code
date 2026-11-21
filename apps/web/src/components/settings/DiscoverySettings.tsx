import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { directoryDiscovery } from "../../state/discover";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function DiscoverySettings() {
  const gt = useGT();
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
        gt(
          "Disconnect discovery on this device? Its discovery listing will be removed. Existing direct environment connections remain.",
        ),
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
      setError(failure instanceof Error ? failure.message : gt("Could not update discovery."));
    }
  };
  return (
    <SettingsSection title={gt("Discovery")}>
      <SettingsRow
        title={state.directory?.label ?? gt("No discovery directory")}
        description={
          state.directory
            ? gt(
                "{brokerOrigin} · {count} discovered environments. Environments appear in the list above.",
                {
                  brokerOrigin: state.directory.brokerOrigin,
                  count: state.hosts.length,
                },
              )
            : gt(
                "Use Add environment to paste a discovery enrollment URL. Joining on desktop also makes its local environment discoverable.",
              )
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
                {state.refreshing ? <T>Refreshing…</T> : <T>Refresh</T>}
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={pending}
                onClick={() => void run("disconnect")}
              >
                <T>Disconnect discovery</T>
              </Button>
            </div>
          ) : undefined
        }
      />
      {state.services.map((service) => (
        <SettingsRow
          key={service.serviceId}
          title={service.label}
          description={
            service.linkedAt === null
              ? gt(
                  "{kind} · {health} · not linked. Link it and configure providers from the Usage tab.",
                  { kind: service.kind, health: service.health },
                )
              : gt(
                  "{kind} · {health} · linked. Link it and configure providers from the Usage tab.",
                  { kind: service.kind, health: service.health },
                )
          }
        />
      ))}
      {(error ?? state.error) ? (
        <SettingsRow title={gt("Discovery error")} description={error ?? state.error} />
      ) : null}
    </SettingsSection>
  );
}
