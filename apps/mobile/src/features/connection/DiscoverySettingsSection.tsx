import { useAtomValue } from "@effect/atom-react";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useGT } from "gt-react-native";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import * as Dialog from "../../components/ui/Dialog";
import { ListActionRow } from "../../components/ui/ListActionRow";
import { directoryDiscovery } from "../../state/discover";
import { useAtomCommand } from "../../state/use-atom-command";
import { SettingsSection } from "../settings/components/SettingsSection";

export function DiscoverySettingsSection() {
  const gt = useGT();
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
      setError(failure instanceof Error ? failure.message : gt("Could not update discovery."));
    }
  };
  return (
    <View className="mt-5">
      <SettingsSection
        title={gt("Discovery")}
        footer={gt(
          "Discovered environments appear in your existing environment list. Disconnecting discovery leaves existing direct connections.",
        )}
      >
        <View className="gap-1 p-4">
          <Text className="text-base text-foreground">
            {state.directory?.label ?? gt("No discovery directory")}
          </Text>
          <Text className="text-sm text-foreground-muted">
            {state.directory
              ? gt("{origin} · {count} discovered environments", {
                  origin: state.directory.brokerOrigin,
                  count: state.hosts.length,
                })
              : gt("Use Add environment to paste or scan a discovery enrollment URL.")}
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
              label={gt("Refresh discovery")}
              icon="arrow.clockwise"
              loading={pending || state.refreshing}
              onPress={() => void run("refresh")}
            />
            <ListActionRow
              label={gt("Disconnect discovery")}
              tone="danger"
              disabled={pending}
              onPress={() => {
                Dialog.alert(
                  gt("Disconnect discovery?"),
                  gt("Existing direct environment connections remain."),
                  [
                    { text: gt("Cancel"), style: "cancel" },
                    {
                      text: gt("Disconnect"),
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
