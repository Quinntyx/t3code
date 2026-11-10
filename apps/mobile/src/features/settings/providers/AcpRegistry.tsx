import type { MenuAction } from "@react-native-menu/menu";
import {
  ACP_REGISTRY_SEARCH_DEBOUNCE_MS,
  acpRegistryPrepareErrorMessage,
  applyAcpRegistryPrepareResult,
  FIRST_CLASS_REGISTRY_AGENT_IDS,
  parseProviderHeaders,
} from "@t3tools/client-runtime/provider-settings/acp-registry";
import { isConfiguredAcpRegistryAgent } from "@t3tools/client-runtime/provider-settings/add-instance";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ACP_REGISTRY_MAX_AGENTS,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthProvidersManageScope,
  type AcpRegistryConfigurableProvider,
  type AcpRegistrySearchAgent,
  type AcpRegistrySession,
  type EnvironmentId,
  type ProjectId,
  type ProviderInstanceId,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import { useRef, useState } from "react";
import { Linking, View, type TextInputInstance } from "react-native";

import { ProviderIcon } from "../../../components/ProviderIcon";
import * as Dialog from "../../../components/ui/Dialog";
import { AppActivityIndicator } from "../../../components/ui/AppActivityIndicator";
import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { ControlPill } from "../../../components/ui/ControlPill";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { Menu } from "../../../components/ui/Menu";
import { SearchField } from "../../../components/ui/SearchField";
import { useProjects } from "../../../state/entities";
import { useDebouncedValue } from "../../../state/queries";
import { useEnvironmentQuery } from "../../../state/query";
import { serverEnvironment } from "../../../state/server";
import { readEnvironmentScope, useEnvironmentScope } from "../../../state/session";
import { useAtomCommand } from "../../../state/use-atom-command";
import { SettingsSection } from "../components/SettingsSection";
import { FieldBlock } from "./ProviderFields";
import { reportCommandFailure } from "./useProviderSettings";

export function AcpRegistryPicker(props: {
  readonly environmentId: EnvironmentId;
  readonly providerInstances: ServerSettings["providerInstances"];
  readonly onPrepared: (agent: AcpRegistrySearchAgent) => void;
  readonly onManualConfiguration: () => void;
  readonly onLocalConfiguration: () => void;
}) {
  const inputRef = useRef<TextInputInstance | null>(null);
  const canManage = useEnvironmentScope(props.environmentId, AuthProvidersManageScope);
  const [query, setQuery] = useState("");
  const submittedQuery = useDebouncedValue(query.trim(), ACP_REGISTRY_SEARCH_DEBOUNCE_MS);
  const [preparingId, setPreparingId] = useState<string | null>(null);
  const [prepareError, setPrepareError] = useState<string | null>(null);
  const search = useEnvironmentQuery(
    serverEnvironment.searchAcpRegistry({
      environmentId: props.environmentId,
      input: submittedQuery
        ? { query: submittedQuery }
        : { query: "", limit: ACP_REGISTRY_MAX_AGENTS },
    }),
  );
  const prepareAgent = useAtomCommand(serverEnvironment.prepareAcpRegistryAgent, {
    reportFailure: false,
  });

  const prepare = async (agent: AcpRegistrySearchAgent) => {
    if (!readEnvironmentScope(props.environmentId, AuthProvidersManageScope)) return;
    setPrepareError(null);
    setPreparingId(agent.id);
    const result = await prepareAgent({
      environmentId: props.environmentId,
      input: { agentId: agent.id },
    });
    setPreparingId(null);
    if (result._tag === "Success") {
      props.onPrepared(applyAcpRegistryPrepareResult(agent, result.value));
      return;
    }
    if (!isAtomCommandInterrupted(result)) {
      setPrepareError(acpRegistryPrepareErrorMessage(squashAtomCommandFailure(result)));
    }
  };

  const results =
    search.data?.agents.filter((agent) => !FIRST_CLASS_REGISTRY_AGENT_IDS.has(agent.id)) ?? null;
  const error = prepareError ?? search.error;
  const busy = preparingId !== null;

  return (
    <View className="gap-6">
      <SettingsSection>
        <View className="flex-row items-center gap-2 px-3 py-3">
          <SearchField
            inputRef={inputRef}
            autoFocus={false}
            accessibilityLabel="Search ACP Registry"
            clearAccessibilityLabel="Clear search"
            placeholder="Search agents"
            value={query}
            onChangeText={(text) => {
              setPrepareError(null);
              setQuery(text);
            }}
          />
          {search.isPending && results !== null ? (
            <AppActivityIndicator colorClassName="accent-icon" />
          ) : null}
        </View>
        {error ? (
          <Text
            accessibilityRole="alert"
            textRole="footnote"
            className="px-4 pb-3 text-danger-foreground"
          >
            {error}
          </Text>
        ) : null}
        {results === null ? (
          search.isPending ? (
            <View className="min-h-20 flex-row items-center justify-center gap-2 border-t border-border-subtle px-4">
              <AppActivityIndicator colorClassName="accent-icon" />
              <Text textRole="footnote" className="text-foreground-muted">
                Searching the registry…
              </Text>
            </View>
          ) : null
        ) : results.length === 0 ? (
          <View className="min-h-24 items-center justify-center gap-1 border-t border-border-subtle px-4 py-4">
            <Text textRole="body" className="text-foreground">
              No compatible agents found
            </Text>
            <Text textRole="footnote" className="text-foreground-muted">
              Try a broader search.
            </Text>
          </View>
        ) : (
          results.map((agent) => (
            <AcpRegistryAgentRow
              key={agent.id}
              agent={agent}
              alreadyAdded={isConfiguredAcpRegistryAgent(props.providerInstances, agent.id)}
              canAdd={canManage && !busy}
              preparing={preparingId === agent.id}
              onAdd={() => void prepare(agent)}
            />
          ))
        )}
      </SettingsSection>
      <SettingsSection footer="Not listed? Enter an official registry ID, or run an ACP executable already installed on this device.">
        <ListActionRow
          icon="pencil"
          label="Enter registry ID manually"
          disabled={busy}
          onPress={props.onManualConfiguration}
        />
        <View className="border-t border-border-subtle">
          <ListActionRow
            icon="terminal"
            label="Local ACP command"
            disabled={busy}
            onPress={props.onLocalConfiguration}
          />
        </View>
      </SettingsSection>
    </View>
  );
}

function AcpRegistryAgentRow(props: {
  readonly agent: AcpRegistrySearchAgent;
  readonly alreadyAdded: boolean;
  readonly canAdd: boolean;
  readonly preparing: boolean;
  readonly onAdd: () => void;
}) {
  const { agent } = props;
  const aboutUrl = agent.website || agent.repository;
  const progressLabel = agent.distribution === "binary" ? "Downloading" : "Preparing";
  return (
    <View className="min-h-16 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3">
      <View className="size-9 items-center justify-center rounded-xl bg-subtle">
        <ProviderIcon provider="acpRegistry" iconUrl={agent.icon} size={20} />
      </View>
      <View className="min-w-0 flex-1 gap-0.5">
        <Text textRole="body" className="text-foreground" numberOfLines={1}>
          {agent.name}
        </Text>
        {agent.description ? (
          <Text textRole="footnote" className="text-foreground-muted" numberOfLines={2}>
            {agent.description}
          </Text>
        ) : null}
      </View>
      {aboutUrl ? (
        <ControlPill
          icon="arrow.up.right"
          accessibilityLabel={`About ${agent.name}`}
          onPress={() => void Linking.openURL(aboutUrl).catch(() => undefined)}
        />
      ) : null}
      {props.preparing ? (
        <View
          accessible
          accessibilityLabel={`${progressLabel} ${agent.name}`}
          className="flex-row items-center gap-1.5"
        >
          <AppActivityIndicator colorClassName="accent-icon" />
          <Text textRole="footnote" className="text-foreground-muted">
            {progressLabel}
          </Text>
        </View>
      ) : props.alreadyAdded ? (
        <Text
          accessibilityLabel={`${agent.name} already added`}
          textRole="footnote"
          className="text-foreground-muted"
        >
          Added
        </Text>
      ) : (
        <ControlPill
          variant="primary"
          label="Add"
          accessibilityLabel={`Add ${agent.name}`}
          disabled={!props.canAdd}
          onPress={props.onAdd}
        />
      )}
    </View>
  );
}

type ProviderDraft = {
  readonly apiType: string;
  readonly baseUrl: string;
  readonly headers: string;
};

function initialProviderDraft(provider: AcpRegistryConfigurableProvider): ProviderDraft {
  return {
    apiType: provider.current?.apiType ?? provider.supported[0] ?? "",
    baseUrl: provider.current?.baseUrl ?? "",
    headers: "",
  };
}

export function AcpSessionsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly provider: ServerProvider;
  readonly readOnly: boolean;
}) {
  const { environmentId, instanceId, provider } = props;
  const projects = useProjects().filter((project) => project.environmentId === environmentId);
  const canOperate = useEnvironmentScope(environmentId, AuthOrchestrationOperateScope);
  const canRead = useEnvironmentScope(environmentId, AuthOrchestrationReadScope);
  const [selectedProjectId, setProjectId] = useState<ProjectId | null>(null);
  const projectId =
    projects.find((project) => project.id === selectedProjectId)?.id ?? projects[0]?.id ?? null;
  const [sessions, setSessions] = useState<ReadonlyArray<AcpRegistrySession>>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [importingSessionId, setImportingSessionId] = useState<string | null>(null);
  const [deletingSessionId, setDeletingSessionId] = useState<string | null>(null);
  const [loggingOut, setLoggingOut] = useState(false);
  const [agentProviders, setAgentProviders] = useState<
    ReadonlyArray<AcpRegistryConfigurableProvider>
  >([]);
  const [loadingProviders, setLoadingProviders] = useState(false);
  const [savingProviderId, setSavingProviderId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Readonly<Record<string, ProviderDraft>>>({});
  const options = { reportFailure: false };
  const listSessions = useAtomCommand(serverEnvironment.listAcpRegistrySessions, options);
  const importSession = useAtomCommand(serverEnvironment.importAcpRegistrySession, options);
  const deleteSession = useAtomCommand(serverEnvironment.deleteAcpRegistrySession, options);
  const listProviders = useAtomCommand(serverEnvironment.listAcpRegistryProviders, options);
  const setProvider = useAtomCommand(serverEnvironment.setAcpRegistryProvider, options);
  const disableProvider = useAtomCommand(serverEnvironment.disableAcpRegistryProvider, options);
  const logout = useAtomCommand(serverEnvironment.logoutAcpRegistry, options);

  const canList = provider.nativeSessions?.canList === true;
  const canImport =
    provider.nativeSessions?.canLoad === true || provider.nativeSessions?.canResume === true;
  const canDelete = provider.nativeSessions?.canDelete === true;
  const canLogout = provider.auth.canLogout === true && !provider.setup?.canAuthenticate;
  const canConfigureProviders = provider.configurableProviders === true;
  const projectOperationPending =
    loading ||
    importingSessionId !== null ||
    deletingSessionId !== null ||
    loadingProviders ||
    savingProviderId !== null;

  if (!canList && !canLogout && !canConfigureProviders) return null;

  const selectProject = (next: ProjectId) => {
    setProjectId(next);
    setSessions([]);
    setNextCursor(null);
    setAgentProviders([]);
    setDrafts({});
  };

  const loadSessions = async (cursor?: string) => {
    if (projectId === null || loading) return;
    setLoading(true);
    const result = await listSessions({
      environmentId,
      input: { instanceId, projectId, ...(cursor === undefined ? {} : { cursor }) },
    });
    setLoading(false);
    if (result._tag === "Success") {
      setSessions((current) =>
        cursor === undefined ? result.value.sessions : [...current, ...result.value.sessions],
      );
      setNextCursor(result.value.nextCursor);
      return;
    }
    reportCommandFailure(result, "Could not list ACP sessions", "The ACP operation failed.");
  };

  const importNativeSession = async (session: AcpRegistrySession) => {
    if (
      !readEnvironmentScope(environmentId, AuthOrchestrationOperateScope) ||
      projectId === null ||
      importingSessionId !== null
    )
      return;
    setImportingSessionId(session.sessionId);
    const result = await importSession({
      environmentId,
      input: {
        instanceId,
        projectId,
        sessionId: session.sessionId,
        title: session.title,
        updatedAt: session.updatedAt,
      },
    });
    setImportingSessionId(null);
    if (result._tag === "Success") {
      setSessions((current) =>
        current.map((candidate) =>
          candidate.sessionId === session.sessionId
            ? { ...candidate, importedThreadId: result.value.threadId }
            : candidate,
        ),
      );
      return;
    }
    reportCommandFailure(result, "Could not import ACP session", "The ACP operation failed.");
  };

  const deleteNativeSession = (session: AcpRegistrySession) => {
    if (projectId === null || deletingSessionId !== null || session.importedThreadId !== null)
      return;
    Dialog.confirm({
      title: "Delete session?",
      message: `Permanently deletes the native ACP session "${session.title ?? session.sessionId}".`,
      confirmText: "Delete",
      destructive: true,
      onConfirm: () => {
        if (!readEnvironmentScope(environmentId, AuthOrchestrationOperateScope)) return;
        setDeletingSessionId(session.sessionId);
        void deleteSession({
          environmentId,
          input: { instanceId, projectId, sessionId: session.sessionId },
        }).then((result) => {
          setDeletingSessionId(null);
          if (result._tag === "Success") {
            setSessions((current) =>
              current.filter((candidate) => candidate.sessionId !== session.sessionId),
            );
            return;
          }
          reportCommandFailure(result, "Could not delete ACP session", "The ACP operation failed.");
        });
      },
    });
  };

  const loadProviders = async () => {
    if (projectId === null || loadingProviders) return;
    setLoadingProviders(true);
    const result = await listProviders({ environmentId, input: { instanceId, projectId } });
    setLoadingProviders(false);
    if (result._tag === "Success") {
      setAgentProviders(result.value.providers);
      setDrafts(
        Object.fromEntries(
          result.value.providers.map((entry) => [entry.providerId, initialProviderDraft(entry)]),
        ),
      );
      return;
    }
    reportCommandFailure(result, "Could not list ACP providers", "The ACP operation failed.");
  };

  const saveProvider = async (entry: AcpRegistryConfigurableProvider) => {
    if (
      !readEnvironmentScope(environmentId, AuthProvidersManageScope) ||
      projectId === null ||
      savingProviderId !== null
    )
      return;
    const draft = drafts[entry.providerId] ?? initialProviderDraft(entry);
    if (draft.apiType.length === 0 || draft.baseUrl.length === 0) return;
    const parsed = parseProviderHeaders(draft.headers);
    if (!parsed.ok) {
      Dialog.alert("Invalid provider headers", parsed.error);
      return;
    }
    setSavingProviderId(entry.providerId);
    const result = await setProvider({
      environmentId,
      input: {
        instanceId,
        projectId,
        providerId: entry.providerId,
        apiType: draft.apiType,
        baseUrl: draft.baseUrl,
        ...(parsed.headers === undefined ? {} : { headers: parsed.headers }),
      },
    });
    setSavingProviderId(null);
    if (result._tag === "Success") {
      await loadProviders();
      return;
    }
    reportCommandFailure(result, "Could not configure ACP provider", "The ACP operation failed.");
  };

  const disableAgentProvider = (entry: AcpRegistryConfigurableProvider) => {
    if (projectId === null || savingProviderId !== null || entry.required) return;
    Dialog.confirm({
      title: `Disable ${entry.providerId}?`,
      message: "The agent stops routing requests through this provider.",
      confirmText: "Disable",
      destructive: true,
      onConfirm: () => {
        if (!readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
        setSavingProviderId(entry.providerId);
        void disableProvider({
          environmentId,
          input: { instanceId, projectId, providerId: entry.providerId },
        }).then(async (result) => {
          setSavingProviderId(null);
          if (result._tag === "Success") {
            await loadProviders();
            return;
          }
          reportCommandFailure(
            result,
            "Could not disable ACP provider",
            "The ACP operation failed.",
          );
        });
      },
    });
  };

  const logoutAgent = () => {
    Dialog.confirm({
      title: "Log out of this agent?",
      message: "Signs the ACP agent out on this device. Imported threads are kept.",
      confirmText: "Log out",
      destructive: true,
      onConfirm: () => {
        if (loggingOut || !readEnvironmentScope(environmentId, AuthProvidersManageScope)) return;
        setLoggingOut(true);
        void logout({ environmentId, input: { instanceId } }).then((result) => {
          setLoggingOut(false);
          if (result._tag === "Success") {
            setSessions([]);
            setNextCursor(null);
            return;
          }
          reportCommandFailure(
            result,
            "Could not log out of ACP agent",
            "The ACP operation failed.",
          );
        });
      },
    });
  };

  const projectPicker = (separated: boolean) => (
    <ProjectPickerRow
      projects={projects}
      projectId={projectId}
      disabled={!canRead || projectOperationPending}
      separated={separated}
      onSelect={selectProject}
    />
  );

  return (
    <>
      {canList || canLogout ? (
        <SettingsSection
          title="Native sessions"
          footer={
            canList && projects.length === 0
              ? "Add a project before importing sessions."
              : canList
                ? "Resume agent-owned conversations as T3 threads."
                : undefined
          }
        >
          {canList && projects.length > 0 ? (
            <>
              {projectPicker(false)}
              <View className="border-t border-border-subtle">
                <ListActionRow
                  icon="arrow.clockwise"
                  label={sessions.length === 0 ? "List sessions" : "Refresh sessions"}
                  loading={loading && nextCursor === null}
                  disabled={!canRead || projectId === null}
                  onPress={() => void loadSessions()}
                />
              </View>
              {sessions.map((session) => (
                <SessionRow
                  key={session.sessionId}
                  session={session}
                  canImport={canOperate && canImport && importingSessionId === null}
                  importing={importingSessionId === session.sessionId}
                  canDelete={canDelete}
                  deleteDisabled={!canOperate || deletingSessionId !== null}
                  deleting={deletingSessionId === session.sessionId}
                  onImport={() => void importNativeSession(session)}
                  onDelete={() => deleteNativeSession(session)}
                />
              ))}
              {nextCursor !== null ? (
                <View className="border-t border-border-subtle">
                  <ListActionRow
                    icon="chevron.down"
                    label="Load more"
                    loading={loading}
                    disabled={!canRead}
                    onPress={() => void loadSessions(nextCursor)}
                  />
                </View>
              ) : null}
            </>
          ) : null}
          {canLogout ? (
            <View
              className={
                canList && projects.length > 0 ? "border-t border-border-subtle" : undefined
              }
            >
              <ListActionRow
                icon="xmark.circle.fill"
                label="Log out of agent"
                tone="danger"
                loading={loggingOut}
                disabled={props.readOnly}
                onPress={logoutAgent}
              />
            </View>
          ) : null}
        </SettingsSection>
      ) : null}

      {canConfigureProviders ? (
        <SettingsSection
          title="Agent providers"
          footer="Configure non-secret routing. Headers are write-only."
        >
          {!canList && projects.length > 1 ? projectPicker(false) : null}
          <View
            className={
              !canList && projects.length > 1 ? "border-t border-border-subtle" : undefined
            }
          >
            <ListActionRow
              icon="arrow.clockwise"
              label={agentProviders.length === 0 ? "List providers" : "Refresh providers"}
              loading={loadingProviders}
              disabled={!canRead || projectId === null}
              onPress={() => void loadProviders()}
            />
          </View>
          {agentProviders.map((entry) => (
            <AgentProviderEditor
              key={entry.providerId}
              entry={entry}
              draft={drafts[entry.providerId] ?? initialProviderDraft(entry)}
              disabled={props.readOnly || savingProviderId !== null}
              saving={savingProviderId === entry.providerId}
              onChange={(draft) =>
                setDrafts((current) => ({ ...current, [entry.providerId]: draft }))
              }
              onSave={() => void saveProvider(entry)}
              onDisable={() => disableAgentProvider(entry)}
            />
          ))}
        </SettingsSection>
      ) : null}
    </>
  );
}

function ProjectPickerRow(props: {
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly projectId: ProjectId | null;
  readonly disabled: boolean;
  readonly separated: boolean;
  readonly onSelect: (projectId: ProjectId) => void;
}) {
  const current = props.projects.find((project) => project.id === props.projectId);
  const actions: MenuAction[] = props.projects.map((project) => ({
    id: project.id,
    title: project.title,
    state: project.id === props.projectId ? "on" : "off",
  }));
  return (
    <FieldBlock
      label="Project"
      separated={props.separated}
      trailing={
        <Menu
          accessible
          accessibilityRole="button"
          accessibilityLabel={`Project: ${current?.title ?? "None"}`}
          title="Project"
          actions={actions}
          onPressAction={({ nativeEvent }) => {
            if (props.disabled) return;
            const next = props.projects.find((project) => project.id === nativeEvent.event);
            if (next) props.onSelect(next.id);
          }}
        >
          <ControlPill variant="pill" label={current?.title ?? "None"} disabled={props.disabled} />
        </Menu>
      }
    />
  );
}

function SessionRow(props: {
  readonly session: AcpRegistrySession;
  readonly canImport: boolean;
  readonly importing: boolean;
  readonly canDelete: boolean;
  readonly deleteDisabled: boolean;
  readonly deleting: boolean;
  readonly onImport: () => void;
  readonly onDelete: () => void;
}) {
  const { session } = props;
  const imported = session.importedThreadId !== null;
  const title = session.title ?? session.sessionId;
  return (
    <View className="min-h-16 flex-row items-center gap-3 border-t border-border-subtle px-4 py-3">
      <View className="min-w-0 flex-1 gap-0.5">
        <Text textRole="body" className="text-foreground" numberOfLines={1}>
          {title}
        </Text>
        <Text
          selectable
          textRole="footnote"
          className="font-mono text-foreground-muted"
          numberOfLines={1}
          ellipsizeMode="middle"
        >
          {session.sessionId}
        </Text>
      </View>
      {props.importing ? (
        <AppActivityIndicator colorClassName="accent-icon" />
      ) : imported ? (
        <Text textRole="footnote" className="text-foreground-muted">
          Imported
        </Text>
      ) : (
        <ControlPill
          variant="pill"
          label="Import"
          accessibilityLabel={`Import ${title}`}
          disabled={!props.canImport}
          onPress={props.onImport}
        />
      )}
      {props.canDelete && !imported ? (
        props.deleting ? (
          <AppActivityIndicator colorClassName="accent-danger-foreground" />
        ) : (
          <ControlPill
            icon="trash"
            accessibilityLabel={`Delete ${title}`}
            disabled={props.deleteDisabled}
            onPress={props.onDelete}
          />
        )
      ) : null}
    </View>
  );
}

function AgentProviderEditor(props: {
  readonly entry: AcpRegistryConfigurableProvider;
  readonly draft: ProviderDraft;
  readonly disabled: boolean;
  readonly saving: boolean;
  readonly onChange: (draft: ProviderDraft) => void;
  readonly onSave: () => void;
  readonly onDisable: () => void;
}) {
  const { entry, draft } = props;
  const protocolActions: MenuAction[] = entry.supported.map((protocol) => ({
    id: protocol,
    title: protocol,
    state: protocol === draft.apiType ? "on" : "off",
  }));
  return (
    <View className="gap-3 border-t border-border-subtle px-4 py-3">
      <View className="flex-row items-center gap-3">
        <View className="min-w-0 flex-1 gap-0.5">
          <Text textRole="body" className="text-foreground" numberOfLines={1}>
            {entry.providerId}
          </Text>
          <Text textRole="footnote" className="text-foreground-muted">
            {`${entry.current === null ? "Disabled" : "Configured"}${entry.required ? " · Required" : ""}`}
          </Text>
        </View>
        <Menu
          accessible
          accessibilityRole="button"
          accessibilityLabel={`${entry.providerId} protocol: ${draft.apiType || "None"}`}
          title="Protocol"
          actions={protocolActions}
          onPressAction={({ nativeEvent }) => {
            if (!props.disabled) props.onChange({ ...draft, apiType: nativeEvent.event });
          }}
        >
          <ControlPill
            variant="pill"
            label={draft.apiType || "Protocol"}
            disabled={props.disabled}
          />
        </Menu>
      </View>
      <AppTextInput
        accessibilityLabel={`${entry.providerId} base URL`}
        value={draft.baseUrl}
        placeholder="https://api.example.com"
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        editable={!props.disabled}
        className="min-h-11 rounded-xl px-3 py-2 text-base"
        onChangeText={(baseUrl) => props.onChange({ ...draft, baseUrl })}
      />
      <AppTextInput
        accessibilityLabel={`${entry.providerId} write-only headers JSON`}
        value={draft.headers}
        placeholder='Headers JSON, e.g. {"Authorization":"Bearer …"}'
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        editable={!props.disabled}
        className="min-h-11 rounded-xl px-3 py-2 font-mono text-sm"
        onChangeText={(headers) => props.onChange({ ...draft, headers })}
      />
      <View className="flex-row justify-end gap-2">
        {!entry.required && entry.current !== null ? (
          <ControlPill
            variant="pill"
            label="Disable"
            accessibilityLabel={`Disable ${entry.providerId}`}
            disabled={props.disabled}
            onPress={props.onDisable}
          />
        ) : null}
        <ControlPill
          variant="primary"
          label={props.saving ? "Saving" : "Save"}
          accessibilityLabel={`Save ${entry.providerId}`}
          disabled={props.disabled || draft.apiType.length === 0 || draft.baseUrl.length === 0}
          onPress={props.onSave}
        />
      </View>
    </View>
  );
}
