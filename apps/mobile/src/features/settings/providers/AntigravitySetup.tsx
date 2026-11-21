import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { readConfigString } from "@t3tools/client-runtime/provider-settings/instance";
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { useGT } from "gt-react-native";
import { useRef, useState } from "react";
import { View } from "react-native";

import * as Dialog from "../../../components/ui/Dialog";
import { AppText as Text } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { Progress } from "../../../components/ui/Progress";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsSection } from "../components/SettingsSection";
import { FieldBlock } from "./ProviderFields";
import { ProviderSignInSection } from "./ProviderSignInSection";

export function AntigravitySetupSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly config: unknown;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly onEnable: () => Promise<boolean>;
}) {
  const gt = useGT();
  return (
    <SettingsSection title={gt("Setup")}>
      <FieldBlock
        label={gt("Runs on")}
        description={props.environmentLabel}
        trailing={
          !props.enabled && !props.readOnly ? (
            <Button label={gt("Turn on")} tone="secondary" onPress={() => void props.onEnable()} />
          ) : null
        }
      />
      {props.readOnly ? (
        <FieldBlock
          label={gt("Setup unavailable")}
          description={gt("Provider setup is read-only.")}
          separated
        />
      ) : props.provider?.setup === undefined ? (
        <FieldBlock
          label={gt("Update required")}
          description={gt("Update this environment to manage {provider}.", {
            provider: "Antigravity",
          })}
          separated
        />
      ) : (
        <AntigravitySetupActions
          key={`${props.environmentId}:${props.instanceId}`}
          environmentId={props.environmentId}
          environmentLabel={props.environmentLabel}
          instanceId={props.instanceId}
          provider={props.provider}
          binaryPath={readConfigString(props.config, "binaryPath") ?? ""}
          enabled={props.enabled}
        />
      )}
    </SettingsSection>
  );
}

type PendingSetupAction = "cancel" | "start" | "remove";

function AntigravitySetupActions({
  environmentId,
  environmentLabel,
  instanceId,
  provider,
  binaryPath,
  enabled,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly binaryPath: string;
  readonly enabled: boolean;
}) {
  const gt = useGT();
  const target = { environmentId, input: { instanceId } };
  const authQuery = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const installQuery = useEnvironmentQuery(serverEnvironment.providerInstallState(target));
  const auth = authQuery.data;
  const installation = installQuery.data;
  const options = { reportFailure: false, reportDefect: false };
  const startInstall = useAtomCommand(serverEnvironment.startProviderInstall, options);
  const cancelInstall = useAtomCommand(serverEnvironment.cancelProviderInstall, options);
  const removeInstall = useAtomCommand(serverEnvironment.removeProviderInstallation, options);
  const [pending, setPending] = useState<PendingSetupAction | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const authActive =
    auth?.phase === "starting" || auth?.phase === "waiting" || auth?.phase === "verifying";
  const installActive =
    installation?.phase === "downloading" ||
    installation?.phase === "extracting" ||
    installation?.phase === "verifying";
  const customBinary = binaryPath.length > 0;
  const installed = provider.installed || (!customBinary && installation?.installedVersion != null);
  const queryError = authQuery.error ?? installQuery.error;
  const disabled = pending !== null || queryError !== null;
  const pendingLabel =
    pending === "cancel"
      ? gt("Cancelling installation")
      : pending === "start"
        ? gt("Starting installation")
        : pending === "remove"
          ? gt("Removing runtime")
          : null;
  const status =
    installation === null
      ? gt("Checking the {provider} runtime", { provider: "Antigravity" })
      : installation.phase === "downloading"
        ? installation.totalBytes === null
          ? gt("Downloading {downloaded} MB", {
              downloaded: (installation.downloadedBytes / 1_000_000).toFixed(1),
            })
          : gt("Downloading {downloaded} MB of {total} MB", {
              downloaded: (installation.downloadedBytes / 1_000_000).toFixed(1),
              total: (installation.totalBytes / 1_000_000).toFixed(1),
            })
        : installation?.phase === "extracting"
          ? gt("Extracting {provider}", { provider: "Antigravity" })
          : installation?.phase === "verifying"
            ? gt("Checking the downloaded runtime")
            : installed
              ? gt("Installed")
              : customBinary
                ? enabled
                  ? gt("The configured {provider} runtime is unavailable", {
                      provider: "Antigravity",
                    })
                  : gt("The configured {provider} runtime has not been checked", {
                      provider: "Antigravity",
                    })
                : installation?.totalBytes
                  ? gt("Not installed · {megabytes} MB download", {
                      megabytes: Math.ceil(installation.totalBytes / 1_000_000),
                    })
                  : gt("Not installed");
  const installLabel = installation?.installedVersion
    ? installation.version && installation.version !== installation.installedVersion
      ? gt("Update {provider}", { provider: "Antigravity" })
      : gt("Reinstall {provider}", { provider: "Antigravity" })
    : installation?.phase === "failed" || installation?.phase === "cancelled"
      ? gt("Retry installation")
      : installed
        ? gt("Install managed runtime")
        : gt("Install {provider}", { provider: "Antigravity" });

  async function run<A, E>(
    action: PendingSetupAction,
    request: () => Promise<AtomCommandResult<A, E>>,
  ) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(action);
    setError(null);
    const settled = await settlePromise(request);
    pendingRef.current = false;
    setPending(null);
    if (settled._tag === "Failure") {
      setError(gt("Provider setup failed. Try again."));
      return;
    }
    const result = settled.value;
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : gt("Provider setup failed."));
    }
  }

  return (
    <>
      <FieldBlock
        label={gt("Runtime")}
        separated
        description={
          customBinary
            ? gt("Uses the custom binary path in Runtime settings. Installation keeps that path.")
            : !installed && !provider.setup?.canInstall
              ? gt(
                  "Automatic installation is unavailable. Set a binary path or use another environment.",
                )
              : undefined
        }
      >
        <Text
          accessibilityLiveRegion="polite"
          textRole="footnote"
          className="text-foreground-muted"
        >
          {pendingLabel ?? status}
        </Text>
        {installation?.phase === "downloading" &&
        installation.totalBytes !== null &&
        installation.totalBytes > 0 ? (
          <Progress
            label={gt("{provider} download", { provider: "Antigravity" })}
            value={installation.downloadedBytes / installation.totalBytes}
          />
        ) : null}
        {!installActive && installation?.message && installation.message !== status ? (
          <Text textRole="footnote" className="text-foreground-muted">
            {installation.message}
          </Text>
        ) : null}
        {installActive && installation.operationId ? (
          <Button
            label={gt("Cancel installation")}
            tone="secondary"
            disabled={disabled}
            onPress={() => {
              const operationId = installation.operationId;
              if (!operationId) return;
              void run("cancel", () =>
                cancelInstall({ environmentId, input: { instanceId, operationId } }),
              );
            }}
          />
        ) : !installActive && provider.setup?.canInstall ? (
          <Button
            label={installLabel}
            icon="arrow.down.circle"
            tone="secondary"
            loading={pending === "start"}
            disabled={disabled || authActive}
            onPress={() => void run("start", () => startInstall(target))}
          />
        ) : null}
      </FieldBlock>
      {installation?.canRemove && !installActive ? (
        <View className="border-t border-border-subtle">
          <ListActionRow
            icon="trash"
            label={gt("Remove downloaded runtime")}
            tone="danger"
            disabled={disabled || authActive}
            onPress={() =>
              Dialog.confirm({
                title: gt("Remove runtime?"),
                message: gt(
                  "Removes the downloaded {provider} runtime from {environment}. {account} sign-in and thread history are kept.",
                  {
                    provider: "Antigravity",
                    environment: environmentLabel,
                    account: "Google",
                  },
                ),
                confirmText: gt("Remove"),
                destructive: true,
                onConfirm: () => void run("remove", () => removeInstall(target)),
              })
            }
          />
        </View>
      ) : null}
      <View className="border-t border-border-subtle">
        <ProviderSignInSection
          environment={{ environmentId, label: environmentLabel }}
          provider={provider}
        />
      </View>
      {error || queryError ? (
        <View className="gap-2 border-t border-border-subtle px-4 py-3">
          <Text accessibilityRole="alert" textRole="footnote" className="text-danger-foreground">
            {error ?? queryError}
          </Text>
          {queryError ? (
            <Button
              label={gt("Retry setup status")}
              tone="secondary"
              onPress={() => {
                authQuery.refresh();
                installQuery.refresh();
              }}
            />
          ) : null}
        </View>
      ) : null}
    </>
  );
}
