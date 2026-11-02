import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { DiscoverHostStatus, DiscoverTransport } from "@t3tools/contracts/discover";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { directoryDiscovery, discoveryHost } from "../../state/discover";
import { type EnvironmentPresentation } from "../../state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function DiscoverySettings({
  environments,
}: {
  readonly environments: ReadonlyArray<EnvironmentPresentation>;
}) {
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
        "Disconnect discovery on this device? Existing direct environment connections remain. To stop sharing an environment, use Stop sharing in its settings.",
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
            ? `${state.directory.brokerOrigin} · ${state.hosts.length} discovered environments. Enrolling this device does not share any environment.`
            : "Use Add environment to paste a discovery enrollment URL. Existing direct connections are independent of discovery."
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
      {environments.map((environment) => (
        <DiscoveryHostRow
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
          enrolled={state.directory !== null}
        />
      ))}
    </SettingsSection>
  );
}

function DiscoveryHostRow({
  environmentId,
  label,
  enrolled,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly enrolled: boolean;
}) {
  const canShare = useAtomValue(discoveryHost.configure.permissionAtom(environmentId));
  const canRevoke = useAtomValue(discoveryHost.revoke.permissionAtom(environmentId));
  const canCheck = useAtomValue(discoveryHost.status.permissionAtom(environmentId));
  const hostConfiguration = useAtomCommand(directoryDiscovery.hostConfiguration, {
    reportFailure: false,
  });
  const configure = useAtomCommand(discoveryHost.configure, { reportFailure: false });
  const revoke = useAtomCommand(discoveryHost.revoke, { reportFailure: false });
  const check = useAtomCommand(discoveryHost.status, { reportFailure: false });
  const [transport, setTransport] = useState<DiscoverTransport>("tailscale");
  const [status, setStatus] = useState<DiscoverHostStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: "share" | "stop" | "status") => {
    if (pending) return;
    if (
      action === "share" &&
      !(await requestConfirmDialog(
        `Share ${label} via ${transport === "lan" ? "LAN" : "Tailscale"}? The paired discovery broker can authorize other directory members to access this environment with the same access as a normal pairing link.`,
      ))
    )
      return;
    setPending(true);
    setError(null);
    const configuration = action === "share" ? await hostConfiguration(transport) : null;
    const result =
      configuration?._tag === "Failure"
        ? configuration
        : configuration?._tag === "Success"
          ? await configure({ environmentId, input: configuration.value })
          : action === "stop"
            ? await revoke({ environmentId, input: {} })
            : await check({ environmentId, input: {} });
    setPending(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        const failure = squashAtomCommandFailure(result);
        setError(failure instanceof Error ? failure.message : "Could not update sharing.");
      }
      return;
    }
    setStatus(result.value);
  };
  const sharing = status?.brokerOrigin !== null && status?.brokerOrigin !== undefined;
  return (
    <SettingsRow
      title={label}
      description={
        error ??
        status?.error ??
        (sharing
          ? `Shared via ${status.transport === "lan" ? "LAN" : "Tailscale"} with ${status.brokerOrigin}. The broker can authorize other members.`
          : `${status ? "Not shared." : "Sharing status not checked."} Sharing lets the paired broker give other directory members access to this environment.`)
      }
      control={
        <div className="flex flex-wrap items-center gap-2">
          <Select
            value={transport}
            disabled={pending || !enrolled || !canShare}
            onValueChange={(value) => {
              if (value === "tailscale" || value === "lan") setTransport(value);
            }}
          >
            <SelectTrigger size="sm" aria-label={`Discovery transport for ${label}`}>
              <SelectValue />
            </SelectTrigger>
            <SelectPopup>
              <SelectItem value="tailscale">Tailscale</SelectItem>
              <SelectItem value="lan">LAN</SelectItem>
            </SelectPopup>
          </Select>
          <Button
            size="sm"
            variant="outline"
            disabled={pending || !enrolled || !canShare}
            onClick={() => void run("share")}
          >
            Share this environment
          </Button>
          <Button
            size="sm"
            variant="ghost-muted"
            disabled={pending || !canCheck}
            onClick={() => void run("status")}
          >
            Check sharing
          </Button>
          <Button
            size="sm"
            variant="ghost-muted"
            disabled={pending || !canRevoke || (status !== null && !sharing)}
            onClick={() => void run("stop")}
          >
            Stop sharing
          </Button>
        </div>
      }
    />
  );
}
