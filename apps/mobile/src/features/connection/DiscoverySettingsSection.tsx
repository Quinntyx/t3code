import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId } from "@t3tools/contracts";
import type { DiscoverHostStatus, DiscoverTransport } from "@t3tools/contracts/discover";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { directoryDiscovery, discoveryHost } from "../../state/discover";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

export function DiscoverySettingsSection() {
  const state = useAtomValue(directoryDiscovery.stateValueAtom);
  const refresh = useAtomCommand(directoryDiscovery.refresh, { reportFailure: false });
  const disconnect = useAtomCommand(directoryDiscovery.disconnect, { reportFailure: false });
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: "refresh" | "disconnect") => {
    if (pending) return;
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
    <View className="mt-5">
      <SettingsSection
        title="Discovery"
        footer="Enrolling this device does not share any environment. Open an environment to share it explicitly. Disconnecting discovery leaves existing direct connections."
      >
        <View className="gap-1 p-4">
          <Text className="text-base text-foreground">
            {state.directory?.label ?? "No discovery directory"}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {state.directory
              ? `${state.directory.brokerOrigin} · ${state.hosts.length} discovered environments`
              : "Use Add environment to paste or scan a discovery enrollment URL."}
          </Text>
          {(error ?? state.error) ? (
            <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
              {error ?? state.error}
            </Text>
          ) : null}
        </View>
        {state.directory ? (
          <>
            <ListActionRow
              label="Refresh discovery"
              icon="arrow.clockwise"
              loading={pending || state.refreshing}
              onPress={() => void run("refresh")}
            />
            <ListActionRow
              label="Disconnect discovery"
              tone="danger"
              disabled={pending}
              onPress={() => {
                Dialog.alert(
                  "Disconnect discovery?",
                  "Existing direct environment connections remain. To stop sharing an environment, use Stop sharing in its settings.",
                  [
                    { text: "Cancel", style: "cancel" },
                    {
                      text: "Disconnect",
                      style: "destructive",
                      onPress: () => void run("disconnect"),
                    },
                  ],
                );
              }}
            />
          </>
        ) : null}
      </SettingsSection>
    </View>
  );
}

export function DiscoveryHostSection({
  environmentId,
  label,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}) {
  const directory = useAtomValue(directoryDiscovery.stateValueAtom).directory;
  const canShare = useAtomValue(discoveryHost.configure.permissionAtom(environmentId));
  const canRevoke = useAtomValue(discoveryHost.revoke.permissionAtom(environmentId));
  const canCheck = useAtomValue(discoveryHost.status.permissionAtom(environmentId));
  const hostConfiguration = useAtomCommand(directoryDiscovery.hostConfiguration, {
    reportFailure: false,
  });
  const configure = useAtomCommand(discoveryHost.configure, { reportFailure: false });
  const revoke = useAtomCommand(discoveryHost.revoke, { reportFailure: false });
  const check = useAtomCommand(discoveryHost.status, { reportFailure: false });
  const [status, setStatus] = useState<DiscoverHostStatus | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (
    action: "share" | "stop" | "status",
    transport: DiscoverTransport = "tailscale",
  ) => {
    if (pending) return;
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
    <SettingsSection
      title="Discovery sharing"
      footer="Sharing lets the paired discovery broker give other directory members access to this environment."
    >
      <View className="gap-1 p-4">
        <Text className="text-sm text-foreground-muted">
          {sharing
            ? `Shared via ${status.transport === "lan" ? "LAN" : "Tailscale"} with ${status.brokerOrigin}`
            : status
              ? "Not shared"
              : "Sharing status not checked"}
        </Text>
        {!directory ? (
          <Text className="text-sm text-foreground-muted">
            Enroll this device in a discovery directory before sharing.
          </Text>
        ) : null}
        {(error ?? status?.error) ? (
          <Text accessibilityRole="alert" className="text-sm text-danger-foreground">
            {error ?? status?.error}
          </Text>
        ) : null}
      </View>
      <ListActionRow
        label="Check sharing"
        icon="arrow.clockwise"
        disabled={!canCheck}
        loading={pending}
        onPress={() => void run("status")}
      />
      <ListActionRow
        label="Share this environment"
        icon="square.and.arrow.up"
        disabled={pending || !directory || !canShare}
        onPress={() => {
          Dialog.alert(
            `Share ${label}?`,
            "The paired discovery broker can authorize other directory members to access this environment with the same access as a normal pairing link. Choose the network members can reach.",
            [
              { text: "Cancel", style: "cancel" },
              { text: "Share via Tailscale", onPress: () => void run("share", "tailscale") },
              { text: "Share via LAN", onPress: () => void run("share", "lan") },
            ],
          );
        }}
      />
      <ListActionRow
        label="Stop sharing"
        tone="danger"
        disabled={pending || !canRevoke || (status !== null && !sharing)}
        onPress={() => void run("stop")}
      />
    </SettingsSection>
  );
}
