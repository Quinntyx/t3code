import { useAtomValue } from "@effect/atom-react";
import type { MenuAction } from "@react-native-menu/menu";
import { StackActions, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import {
  settleAuthorizationPage,
  settleProviderInstall,
} from "@t3tools/client-runtime/provider-settings/codex-setup";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
  type AtomCommandResult,
} from "@t3tools/client-runtime/state/runtime";
import { waitForQuerySettled } from "@t3tools/client-runtime/state/wait-for-query-settled";
import {
  AuthProvidersManageScope,
  ProviderDriverKind,
  ProviderInstanceId,
  resolveProviderInstanceEnabled,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ServerProvider,
} from "@t3tools/contracts";
import { CHATGPT_USAGE_URL } from "@t3tools/shared/usageLimits";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { Linking, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../../components/ui/Dialog";
import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListRowLayout } from "../../../components/ui/ListRowLayout";
import { Menu } from "../../../components/ui/Menu";
import { Progress } from "../../../components/ui/Progress";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { uuidv4 } from "../../../lib/uuid";
import { appAtomRegistry } from "../../../state/atom-registry";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsScreen } from "../components/SettingsScreen";
import { SettingsSection } from "../components/SettingsSection";
import { FieldBlock } from "./ProviderFields";
import { useEnvironmentProviders, useProviderInstanceActions } from "./useProviderSettings";

const CODEX_DRIVER = ProviderDriverKind.make("codex");
const CHANGE_ACCOUNT_METHOD = "chatgpt-change-account";

export function CodexSetupSection(props: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly provider: ServerProvider | undefined;
  readonly readOnly: boolean;
  readonly onModeChange: (mode: "managed" | "existing") => Promise<boolean>;
}) {
  if (!props.provider?.setup?.canAuthenticate) {
    return (
      <SettingsSection title="ChatGPT account">
        <FieldBlock label="ChatGPT account" description="Preparing sign-in." />
      </SettingsSection>
    );
  }
  return (
    <ManagedCodexSetup
      key={`${props.environmentId}:${props.instanceId}`}
      environmentId={props.environmentId}
      instanceId={props.instanceId}
      provider={props.provider}
      enabled={resolveProviderInstanceEnabled(props.instance)}
      readOnly={props.readOnly}
      autoStart={false}
      onUseExistingCli={() => void props.onModeChange("existing")}
    />
  );
}

/**
 * The phone's browser can't reach the server's localhost callback, so sign-in always uses the
 * client callback: the page opens here, and the user pastes the final localhost address back.
 */
function ManagedCodexSetup({
  environmentId,
  instanceId,
  provider,
  enabled,
  readOnly,
  autoStart,
  onUseExistingCli,
  onSignInCancelled,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly autoStart: boolean;
  readonly onUseExistingCli?: () => void;
  readonly onSignInCancelled?: () => void;
}) {
  const target = { environmentId, input: { instanceId } };
  const authQuery = useEnvironmentQuery(serverEnvironment.providerAuthState(target));
  const installQuery = useEnvironmentQuery(serverEnvironment.providerInstallState(target));
  const auth = authQuery.data;
  const installation = installQuery.data;
  const options = { reportFailure: false, reportDefect: false };
  const startAuth = useAtomCommand(serverEnvironment.startProviderAuth, options);
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, options);
  const completeAuth = useAtomCommand(serverEnvironment.completeProviderAuth, options);
  const cancelAuth = useAtomCommand(serverEnvironment.cancelProviderAuth, options);
  const logoutAuth = useAtomCommand(serverEnvironment.logoutProviderAuth, options);
  const removeAuthMethod = useAtomCommand(serverEnvironment.removeProviderAuthMethod, options);
  const canRemoveAuthMethod = useAtomValue(
    serverEnvironment.removeProviderAuthMethod.permissionAtom(environmentId),
  );
  const startInstall = useAtomCommand(serverEnvironment.startProviderInstall, options);
  const cancelInstall = useAtomCommand(serverEnvironment.cancelProviderInstall, options);
  const [requestedMethodId, setRequestedMethodId] = useState("chatgpt");
  const [callbackDraft, setCallbackDraft] = useState({ flowId: "", value: "" });
  const callbackUrl = callbackDraft.flowId === auth?.flowId ? callbackDraft.value : "";
  const [pending, setPending] = useState(false);
  const pendingRef = useRef(false);
  const [awaitingProvider, setAwaitingProvider] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The setup this screen started; Cancel, a new attempt, or leaving the screen aborts its follow-ups.
  const operation = useRef<AbortController | null>(null);
  const beginOperation = () => {
    operation.current?.abort();
    const controller = new AbortController();
    operation.current = controller;
    return controller.signal;
  };
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- aborts the in-flight setup or sign-in AbortController on unmount
  useEffect(() => () => operation.current?.abort(), []);
  const [autoStartHandled, setAutoStartHandled] = useState(false);

  const profiles =
    auth?.methods?.filter((method) => method.id.startsWith("chatgpt-profile:")) ?? [];
  const reconnectEmail = auth?.methods?.find((method) => method.id === "chatgpt")?.accountEmail;
  const requestedAccountEmail = auth?.methods?.find(
    (method) => method.id === requestedMethodId,
  )?.accountEmail;
  const url =
    auth?.interaction?.type === "browser" || auth?.interaction?.type === "deviceCode"
      ? auth.interaction.url
      : auth?.authorizationUrl;
  const installed = installation?.installedVersion != null;
  const authenticated = provider?.auth.status === "authenticated";
  const updateAvailable =
    installed &&
    installation?.source !== "local" &&
    installation?.version != null &&
    installation.version !== installation.installedVersion;
  const finishingSignIn = awaitingProvider && !authenticated && auth?.phase === "succeeded";
  if (
    awaitingProvider &&
    (authenticated || auth?.phase === "failed" || auth?.phase === "cancelled")
  ) {
    setAwaitingProvider(false);
  }
  // The server does not refresh the provider snapshot when a sign-in flow succeeds.
  const refreshAfterSignIn = useEffectEvent(
    () => void refreshProviders({ environmentId, input: { instanceId } }),
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- asks the server to refresh the provider snapshot once the sign-in flow succeeds
  useEffect(() => {
    if (awaitingProvider && auth?.phase === "succeeded") refreshAfterSignIn();
  }, [awaitingProvider, auth?.phase]);

  const startingAutomatically = autoStart && !autoStartHandled;
  const waitingForAuthState =
    awaitingProvider && !authenticated && (auth === null || auth.phase === "idle");
  const authInProgress =
    finishingSignIn ||
    waitingForAuthState ||
    auth?.phase === "starting" ||
    auth?.phase === "waiting" ||
    auth?.phase === "verifying";
  const installActive =
    installation?.phase === "downloading" ||
    installation?.phase === "extracting" ||
    installation?.phase === "verifying";
  const authActive = startingAutomatically || authInProgress || (pending && !installActive);
  const unavailable =
    readOnly || !enabled || pending || authQuery.error !== null || installQuery.error !== null;
  const busy = pending || authInProgress || installActive;

  const run = async <A, E>(
    request: () => Promise<AtomCommandResult<A, E>>,
    onSuccess?: (value: A) => void,
  ) => {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    setError(null);
    const result = await request();
    pendingRef.current = false;
    setPending(false);
    if (result._tag === "Success") {
      onSuccess?.(result.value);
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Codex setup failed. Try again.");
    }
    return false;
  };

  const openPage = (page: string) =>
    Linking.openURL(page).catch(() => setError("Could not open the ChatGPT sign-in page."));

  const signIn = async (methodId: string, signal: AbortSignal) => {
    if (pendingRef.current) return;
    setRequestedMethodId(methodId);
    await run(
      () =>
        startAuth({
          environmentId,
          input: { instanceId, methodId, callbackMode: "client" },
        }),
      (started) => {
        setAwaitingProvider(true);
        const flowId = started.flowId;
        if (flowId === null) return;
        const startedPage = settleAuthorizationPage(started, flowId);
        void (
          startedPage !== undefined
            ? Promise.resolve(startedPage)
            : waitForQuerySettled({
                registry: appAtomRegistry,
                atom: serverEnvironment.providerAuthState(target),
                settle: (state) => settleAuthorizationPage(state, flowId),
                signal,
              })
        ).then((page) => {
          if (page && !signal.aborted) void openPage(page);
        });
      },
    );
  };

  const setup = async (methodId = "chatgpt") => {
    if (unavailable || busy) return;
    const signal = beginOperation();
    if (installed && !updateAvailable) {
      await signIn(methodId, signal);
      return;
    }
    await run(
      () => startInstall({ environmentId, input: { instanceId } }),
      (started) => {
        void waitForQuerySettled({
          registry: appAtomRegistry,
          atom: serverEnvironment.providerInstallState(target),
          settle: (current) => settleProviderInstall(started, current),
          signal,
        }).then((ready) => {
          if (ready && !signal.aborted) void signIn(methodId, signal);
        });
      },
    );
  };

  const cancelSignIn = () => {
    operation.current?.abort();
    setAwaitingProvider(false);
    const flowId = auth?.flowId;
    if (flowId) void run(() => cancelAuth({ environmentId, input: { instanceId, flowId } }));
    onSignInCancelled?.();
  };

  if (
    autoStart &&
    !autoStartHandled &&
    !unavailable &&
    !busy &&
    installation !== null &&
    provider?.setup?.canInstall
  ) {
    setAutoStartHandled(true);
  }
  const startAutomatically = useEffectEvent(() => void setup());
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- dispatches the automatic setup server command after the auto-start flag commits
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- Starting setup dispatches a server command, which marks itself pending before it awaits.
    if (autoStartHandled) startAutomatically();
  }, [autoStartHandled]);

  const installDescription =
    installation?.phase === "downloading"
      ? `Downloading ${(installation.downloadedBytes / 1_000_000).toFixed(1)}${installation.totalBytes === null ? "" : ` of ${(installation.totalBytes / 1_000_000).toFixed(1)}`} MB.`
      : installation?.phase === "extracting"
        ? "Installing Codex."
        : installation?.phase === "verifying"
          ? "Checking Codex."
          : null;
  const accountDescription = finishingSignIn
    ? "Finishing sign-in…"
    : installDescription
      ? installDescription
      : authActive || auth?.phase === "failed" || auth?.phase === "cancelled"
        ? auth?.phase === "waiting" && requestedAccountEmail
          ? `Continue as ${requestedAccountEmail} on OpenAI.`
          : (auth?.message ?? "Finish signing in in your browser.")
        : authenticated
          ? "Signed in with ChatGPT."
          : (reconnectEmail ?? "Use your ChatGPT subscription.");
  const runtimeDescription = installed
    ? `${installation?.source === "local" ? "Using your installed Codex" : "Managed by T3 Code"}${installation?.installedVersion ? ` · v${installation.installedVersion}` : ""}.`
    : (installation?.message ?? "T3 Code downloads and manages Codex for you.");
  const logoutWarning =
    auth?.phase === "idle" && auth.message?.startsWith("Signed out locally.") ? auth.message : null;
  const queryError = authQuery.error ?? installQuery.error;
  const shownError =
    error ??
    (installation?.phase === "failed"
      ? installation.message
      : queryError
        ? "Could not read Codex setup status. Reconnect and try again."
        : null);
  const cannotStart =
    unavailable ||
    busy ||
    (!installed ? !provider?.setup?.canInstall : !provider?.setup?.canAuthenticate);
  const removableProfiles = profiles.filter((profile) => profile.canRemove);
  const removeDisabled = unavailable || busy || !canRemoveAuthMethod;
  const accountActions: MenuAction[] = [
    ...profiles.map((profile) => ({ id: profile.id, title: profile.name })),
    { id: CHANGE_ACCOUNT_METHOD, title: "Use a different account" },
    ...(removableProfiles.length > 0
      ? [
          {
            id: "remove",
            title: "Remove connection",
            attributes: { disabled: removeDisabled },
            subactions: removableProfiles.map((profile) => ({
              id: `remove:${profile.id}`,
              title: profile.name,
              attributes: { destructive: true, disabled: removeDisabled },
            })),
          } satisfies MenuAction,
        ]
      : []),
  ];
  const chooseAccount = (methodId: string) => {
    if (methodId.startsWith("remove:")) {
      // iOS keeps a disabled submenu's children selectable, so removal guards here too.
      const removeId = methodId.slice("remove:".length);
      if (removeDisabled || !removableProfiles.some((profile) => profile.id === removeId)) return;
      void run(() =>
        removeAuthMethod({ environmentId, input: { instanceId, methodId: removeId } }),
      );
      return;
    }
    void setup(
      auth?.methods?.some((method) => method.id === methodId) ? methodId : CHANGE_ACCOUNT_METHOD,
    );
  };

  return (
    <SettingsSection
      title="ChatGPT account"
      footer={
        authActive && auth?.phase === "waiting"
          ? "After you sign in, the browser lands on a localhost page that won't load. Copy that page's address and paste it here."
          : runtimeDescription
      }
    >
      <View className="gap-1 px-4 py-3">
        <View className="min-h-6 flex-row items-center justify-between gap-3">
          <Text textRole="body" className="shrink text-foreground">
            ChatGPT account
          </Text>
          {pending || installActive || finishingSignIn ? (
            <AppActivityIndicator colorClassName="accent-icon" />
          ) : null}
        </View>
        <Text
          accessibilityLiveRegion="polite"
          textRole="footnote"
          className="text-foreground-muted"
        >
          {accountDescription}
        </Text>
        {authenticated && !authActive && provider?.auth.email ? (
          <RevealableAccountEmail email={provider.auth.email.trim()} />
        ) : null}
        {installation?.phase === "downloading" &&
        installation.totalBytes !== null &&
        installation.totalBytes > 0 ? (
          <Progress
            className="mt-2"
            label="Codex download"
            value={installation.downloadedBytes / installation.totalBytes}
          />
        ) : null}
        {auth?.interaction?.type === "deviceCode" ? (
          <Text selectable className="mt-1 font-mono text-base text-foreground">
            {`Code: ${auth.interaction.userCode}`}
          </Text>
        ) : null}
      </View>

      {authActive ? (
        <>
          {auth?.phase === "waiting" && url ? (
            <>
              <Divided>
                <ListActionRow
                  icon="globe"
                  label="Open ChatGPT sign-in"
                  onPress={() => void openPage(url)}
                />
              </Divided>
              {auth.interaction?.type !== "deviceCode" ? (
                <View className="gap-2 border-t border-border-subtle px-4 py-3">
                  <AppTextInput
                    accessibilityLabel="ChatGPT sign-in redirect URL"
                    placeholder="Paste the localhost address"
                    secureTextEntry
                    autoCapitalize="none"
                    autoCorrect={false}
                    maxLength={16_384}
                    editable={!pending && !readOnly}
                    value={callbackUrl}
                    className="min-h-11 rounded-xl px-3 py-2 text-base"
                    onChangeText={(value) => setCallbackDraft({ flowId: auth.flowId ?? "", value })}
                  />
                  <Button
                    label="Connect"
                    disabled={pending || readOnly || !callbackUrl.trim()}
                    onPress={() => {
                      const flowId = auth.flowId;
                      const value = callbackUrl.trim();
                      if (!flowId || !value) return;
                      void run(() =>
                        completeAuth({
                          environmentId,
                          input: { instanceId, flowId, callbackUrl: value },
                        }),
                      ).then((connected) => {
                        if (connected) setCallbackDraft({ flowId, value: "" });
                      });
                    }}
                  />
                </View>
              ) : null}
            </>
          ) : null}
          {!finishingSignIn ? (
            <Divided>
              <ListActionRow
                icon="xmark"
                label="Cancel sign-in"
                disabled={pending || readOnly}
                onPress={cancelSignIn}
              />
            </Divided>
          ) : null}
        </>
      ) : installActive ? (
        <Divided>
          <ListActionRow
            icon="xmark"
            label="Cancel installation"
            disabled={pending || readOnly || !installation?.operationId}
            onPress={() => {
              const operationId = installation?.operationId;
              if (!operationId) return;
              operation.current?.abort();
              void run(() => cancelInstall({ environmentId, input: { instanceId, operationId } }));
            }}
          />
        </Divided>
      ) : authenticated ? (
        <>
          <Divided>
            <AccountMenu
              actions={accountActions}
              disabled={unavailable || busy}
              label="Change account"
              onSelect={chooseAccount}
            />
          </Divided>
          <Divided>
            <ListActionRow
              icon="chart.bar.xaxis"
              label="Manage usage"
              onPress={() =>
                void Linking.openURL(CHATGPT_USAGE_URL).catch(() =>
                  setError("Could not open ChatGPT usage settings."),
                )
              }
            />
          </Divided>
          {onUseExistingCli && !readOnly ? (
            <Divided>
              <ListActionRow
                icon="terminal"
                label="Use existing Codex CLI instead"
                description="Sign in with the Codex CLI already on this environment."
                disabled={busy}
                onPress={onUseExistingCli}
              />
            </Divided>
          ) : null}
          <Divided>
            <ListActionRow
              icon="xmark.circle.fill"
              label="Disconnect"
              tone="danger"
              disabled={unavailable || busy}
              onPress={() =>
                Dialog.confirm({
                  title: "Disconnect ChatGPT?",
                  message: "Running threads on this account stop. Thread history is kept.",
                  confirmText: "Disconnect",
                  destructive: true,
                  onConfirm: () => void run(() => logoutAuth(target)),
                })
              }
            />
          </Divided>
        </>
      ) : (
        <>
          <View className="border-t border-border-subtle px-4 py-3">
            {profiles.length > 0 ? (
              <Menu
                accessible
                accessibilityRole="button"
                accessibilityLabel="Reconnect ChatGPT account"
                title="On OpenAI, sign in with the account you choose here."
                actions={accountActions}
                onPressAction={({ nativeEvent }) => {
                  if (!cannotStart) chooseAccount(nativeEvent.event);
                }}
              >
                <View pointerEvents="none">
                  <Button
                    label={pending ? "Setting up…" : "Reconnect account"}
                    tone="primary"
                    disabled={cannotStart}
                    fullWidth
                    onPress={() => undefined}
                  />
                </View>
              </Menu>
            ) : (
              <Button
                label={pending ? "Setting up…" : "Continue with ChatGPT"}
                tone="primary"
                loading={pending}
                disabled={cannotStart}
                fullWidth
                onPress={() => void setup()}
              />
            )}
          </View>
          {onUseExistingCli && !readOnly ? (
            <Divided>
              <ListActionRow
                icon="terminal"
                label="Use existing Codex CLI instead"
                description="Sign in with the Codex CLI already on this environment."
                disabled={busy}
                onPress={onUseExistingCli}
              />
            </Divided>
          ) : null}
        </>
      )}

      {logoutWarning ? (
        <Text
          textRole="footnote"
          className="border-t border-border-subtle px-4 py-3 text-foreground-muted"
        >
          {logoutWarning}
        </Text>
      ) : null}
      {shownError ? (
        <View className="gap-2 border-t border-border-subtle px-4 py-3">
          <Text accessibilityRole="alert" textRole="footnote" className="text-danger-foreground">
            {shownError}
          </Text>
          {queryError ? (
            <Button
              label="Retry setup status"
              onPress={() => {
                authQuery.refresh();
                installQuery.refresh();
              }}
            />
          ) : null}
        </View>
      ) : null}
    </SettingsSection>
  );
}

function Divided(props: { readonly children: ReactNode }) {
  return <View className="border-t border-border-subtle">{props.children}</View>;
}

function AccountMenu(props: {
  readonly actions: MenuAction[];
  readonly disabled: boolean;
  readonly label: string;
  readonly onSelect: (methodId: string) => void;
}) {
  return (
    <Menu
      accessible
      accessibilityRole="button"
      accessibilityLabel={props.label}
      title="On OpenAI, sign in with the account you choose here."
      actions={props.actions}
      onPressAction={({ nativeEvent }) => {
        if (!props.disabled) props.onSelect(nativeEvent.event);
      }}
    >
      <ListRowLayout icon="person.crop.circle" label={props.label} disabled={props.disabled} />
    </Menu>
  );
}

function RevealableAccountEmail(props: { readonly email: string }) {
  const [revealed, setRevealed] = useState(false);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={revealed ? `Signed in as ${props.email}` : "Show account email"}
      onPress={() => setRevealed((value) => !value)}
      hitSlop={6}
    >
      <Text textRole="footnote" className="text-foreground-muted">
        {revealed ? props.email : "••••••@••••••"}
      </Text>
    </Pressable>
  );
}

export function CodexManagedRuntimeFields({
  environmentId,
  instanceId,
  provider,
}: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider | undefined;
}) {
  const installation = useEnvironmentQuery(
    serverEnvironment.providerInstallState({ environmentId, input: { instanceId } }),
  );
  const paths = provider?.runtimePaths;
  const rows = [
    {
      label: "Binary path",
      description: "Selected by T3 Code.",
      value: installation.data?.executablePath ?? null,
      empty: installation.error ? "Could not read runtime path" : "Not installed",
    },
    {
      label: "CODEX_HOME path",
      description: "Shared Codex config, sessions, and state.",
      value: paths?.homePath ?? null,
      empty: "Unavailable",
    },
    {
      label: "Shadow home path",
      description: paths?.shadowHomePath
        ? "Account-specific home sharing the Codex state above."
        : "This instance uses the shared Codex home directly.",
      value: paths?.shadowHomePath ?? null,
      empty: paths ? "Not used" : "Unavailable",
    },
  ];
  return rows.map((row, index) => (
    <FieldBlock
      key={row.label}
      label={row.label}
      description={row.description}
      separated={index > 0}
    >
      <Text
        selectable
        className={
          row.value ? "font-mono text-sm text-foreground" : "text-sm text-foreground-muted"
        }
      >
        {row.value ?? row.empty}
      </Text>
    </FieldBlock>
  ));
}

export function AddChatGptAccountRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId }>) {
  return (
    <AddChatGptAccount
      key={route.params.environmentId}
      environmentId={route.params.environmentId}
    />
  );
}

function AddChatGptAccount({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const actions = useProviderInstanceActions(environmentId);
  const providers = useEnvironmentProviders(environmentId);
  const canManage = useEnvironmentScope(environmentId, AuthProvidersManageScope);
  const [name, setName] = useState("Personal");
  const [instanceId, setInstanceId] = useState<ProviderInstanceId | null>(null);
  const [pending, setPending] = useState(false);
  const displayName = `ChatGPT - ${name.trim()}`;
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  const connected = provider?.auth.status === "authenticated";
  const hasSignedInCodex = providers.some(
    (candidate) => candidate.driver === CODEX_DRIVER && candidate.auth.status === "authenticated",
  );
  const openInstance = () => {
    if (instanceId) {
      navigation.dispatch(
        StackActions.replace("SettingsProviderInstance", { environmentId, instanceId }),
      );
    } else if (navigation.canGoBack()) {
      navigation.goBack();
    }
  };

  const createAccount = async () => {
    if (pending || !name.trim() || !readEnvironmentScope(environmentId, AuthProvidersManageScope))
      return;
    setPending(true);
    const id = ProviderInstanceId.make(`codex_${uuidv4()}`);
    const created = await actions.createInstance(id, {
      driver: CODEX_DRIVER,
      displayName,
      enabled: true,
      config: { enabled: true, setupMode: "managed" },
    });
    setPending(false);
    if (created) setInstanceId(id);
  };

  return (
    <SettingsScreen title={instanceId ? displayName : "Add ChatGPT account"}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        <Text textRole="footnote" className="px-1 text-foreground-muted">
          Each account has its own Codex instance and sign-in. Choose the other account on the
          sign-in page.
        </Text>
        {instanceId === null ? (
          <>
            <SettingsSection
              footer={
                hasSignedInCodex
                  ? "Managing several Codex accounts in T3 Code is not recommended."
                  : undefined
              }
            >
              <FieldBlock
                label="Account name"
                description="Shown in the provider list and model picker."
              >
                <AppTextInput
                  accessibilityLabel="Account name"
                  value={name}
                  editable={!pending}
                  placeholder="e.g. Personal or Work"
                  autoCorrect={false}
                  returnKeyType="done"
                  className="min-h-11 rounded-xl px-3 py-2 text-base"
                  onChangeText={setName}
                  onSubmitEditing={() => void createAccount()}
                />
              </FieldBlock>
            </SettingsSection>
            <Button
              label={pending ? "Adding account…" : "Continue"}
              tone="primary"
              loading={pending}
              disabled={pending || !name.trim() || !canManage}
              fullWidth
              onPress={() => void createAccount()}
            />
          </>
        ) : (
          <>
            {provider?.setup ? (
              <ManagedCodexSetup
                key={instanceId}
                environmentId={environmentId}
                instanceId={instanceId}
                provider={provider}
                enabled
                readOnly={!canManage}
                autoStart
              />
            ) : (
              <SettingsSection title="ChatGPT account">
                <FieldBlock label="Codex runtime" description="Preparing managed setup." />
              </SettingsSection>
            )}
            <Button
              label={connected ? "Done" : "Finish later"}
              tone={connected ? "primary" : "secondary"}
              fullWidth
              onPress={openInstance}
            />
          </>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}
