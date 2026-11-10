import {
  isAtomCommandInterrupted,
  settlePromise,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { readConfigString } from "@t3tools/client-runtime/provider-settings/instance";
import type { EnvironmentId, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
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
  return (
    <SettingsSection title="Setup">
      <FieldBlock
        label="Runs on"
        description={props.environmentLabel}
        trailing={
          !props.enabled && !props.readOnly ? (
            <Button label="Turn on" tone="secondary" onPress={() => void props.onEnable()} />
          ) : null
        }
      />
      {props.readOnly ? (
        <FieldBlock
          label="Setup unavailable"
          description="Provider setup is read-only."
          separated
        />
      ) : props.provider?.setup === undefined ? (
        <FieldBlock
          label="Update required"
          description="Update this environment to manage Antigravity."
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
  const target = { environmentId, input: { instanceId } };
  const authQuery = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const installQuery = useEnvironmentQuery(serverEnvironment.providerInstallState(target));
  const auth = authQuery.data;
  const installation = installQuery.data;
  const options = { reportFailure: false, reportDefect: false };
  const startInstall = useAtomCommand(serverEnvironment.startProviderInstall, options);
  const cancelInstall = useAtomCommand(serverEnvironment.cancelProviderInstall, options);
  const removeInstall = useAtomCommand(serverEnvironment.removeProviderInstallation, options);
  const [pending, setPending] = useState<string | null>(null);
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
  const status =
    installation?.phase === "downloading"
      ? `Downloading ${(installation.downloadedBytes / 1_000_000).toFixed(1)} MB${installation.totalBytes === null ? "" : ` of ${(installation.totalBytes / 1_000_000).toFixed(1)} MB`}`
      : installation?.phase === "extracting"
        ? "Extracting Antigravity"
        : installation?.phase === "verifying"
          ? "Checking the downloaded runtime"
          : installed
            ? "Installed"
            : customBinary
              ? enabled
                ? "The configured Antigravity runtime is unavailable"
                : "The configured Antigravity runtime has not been checked"
              : installation?.totalBytes
                ? `Not installed · ${Math.ceil(installation.totalBytes / 1_000_000)} MB download`
                : "Not installed";
  const installLabel = installation?.installedVersion
    ? installation.version && installation.version !== installation.installedVersion
      ? "Update Antigravity"
      : "Reinstall Antigravity"
    : installation?.phase === "failed" || installation?.phase === "cancelled"
      ? "Retry installation"
      : installed
        ? "Install managed runtime"
        : "Install Antigravity";

  async function run<A, E>(label: string, request: () => Promise<AtomCommandResult<A, E>>) {
    if (pendingRef.current) return;
    pendingRef.current = true;
    setPending(label);
    setError(null);
    const settled = await settlePromise(request);
    pendingRef.current = false;
    setPending(null);
    if (settled._tag === "Failure") {
      setError("Provider setup failed. Try again.");
      return;
    }
    const result = settled.value;
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Provider setup failed.");
    }
  }

  return (
    <>
      <FieldBlock
        label="Runtime"
        separated
        description={
          customBinary
            ? "Uses the custom binary path in Runtime settings. Installation keeps that path."
            : !installed && !provider.setup?.canInstall
              ? "Automatic installation is unavailable. Set a binary path or use another environment."
              : undefined
        }
      >
        <Text
          accessibilityLiveRegion="polite"
          textRole="footnote"
          className="text-foreground-muted"
        >
          {pending ?? status}
        </Text>
        {installation?.phase === "downloading" &&
        installation.totalBytes !== null &&
        installation.totalBytes > 0 ? (
          <Progress
            label="Antigravity download"
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
            label="Cancel installation"
            tone="secondary"
            disabled={disabled}
            onPress={() => {
              const operationId = installation.operationId;
              if (!operationId) return;
              void run("Cancelling installation", () =>
                cancelInstall({ environmentId, input: { instanceId, operationId } }),
              );
            }}
          />
        ) : !installActive && provider.setup?.canInstall ? (
          <Button
            label={installLabel}
            icon="arrow.down.circle"
            tone="secondary"
            loading={pending === "Starting installation"}
            disabled={disabled || installation === null || authActive}
            onPress={() => void run("Starting installation", () => startInstall(target))}
          />
        ) : null}
      </FieldBlock>
      {installation?.canRemove && !installActive ? (
        <View className="border-t border-border-subtle">
          <ListActionRow
            icon="trash"
            label="Remove downloaded runtime"
            tone="danger"
            disabled={disabled || authActive}
            onPress={() =>
              Dialog.confirm({
                title: "Remove runtime?",
                message: `Removes the downloaded Antigravity runtime from ${environmentLabel}. Google sign-in and thread history are kept.`,
                confirmText: "Remove",
                destructive: true,
                onConfirm: () => void run("Removing runtime", () => removeInstall(target)),
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
              label="Retry setup status"
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
