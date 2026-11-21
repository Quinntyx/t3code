import {
  AuthSettingsWriteScope,
  mcpServerIdFromName,
  type RegisteredMcpServerEntry,
  type RegisteredMcpServersState,
} from "@t3tools/contracts";
import { parseMcpRegistration, type ParsedMcpRegistration } from "@t3tools/shared/mcpRegistration";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { toastManager } from "../ui/toast";
import { defaultToolName, validateEntry } from "./CapabilitiesSettings.logic";
import { McpServerStatusBadge } from "./McpServerStatusBadge";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { useSettingsScope } from "./SettingsScopeContext";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function CapabilitiesSettingsPanel() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, scope } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const canRead = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const { data } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.registeredMcpServersState({ environmentId, input: {} }),
  );
  const states: RegisteredMcpServersState = data ?? { servers: [] };
  const stateOf = (id: string) => states.servers.find((server) => server.id === id);

  const entries = settings.registeredMcpServers;

  // A server runs on the machine that registered it, so its list is that machine's alone.
  if (scope.kind !== "environment" || environment === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection id="capabilities" title="MCP servers">
          <SettingsScopeNotice target="environment" inline>
            Choose one environment to manage the MCP servers it runs.
          </SettingsScopeNotice>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection id="capabilities" title="MCP servers">
        <SettingsRow
          serverScoped
          settingKeys={["registeredMcpServers"]}
          {...searchableSetting("mcp-servers")}
          title="Local MCP servers"
          description="T3 Code starts each enabled server on this machine and gives its tools to agents as native tools. Only servers it can launch itself (stdio) are supported."
          status={
            entries.length === 0 ? undefined : (
              <span className="text-muted-foreground">
                {entries.filter((entry) => entry.enabled).length} enabled
              </span>
            )
          }
        />
      </SettingsSection>

      <RegisterServerForm
        existing={entries}
        onAdd={(entry) => {
          updateSettings({ registeredMcpServers: { [entry.id]: entry } });
          toastManager.add({ type: "success", title: `${entry.name} registered` });
        }}
      />

      <SettingsSection id="registered-servers" title="Registered servers">
        {!canRead ? (
          <SettingsRow
            {...searchableSetting("registered-servers")}
            description="You need settings access on this environment to see its MCP servers."
          />
        ) : entries.length === 0 ? (
          <SettingsRow
            {...searchableSetting("registered-servers")}
            description="No MCP servers are registered yet."
          />
        ) : (
          entries.map((entry) => {
            const runtime = stateOf(entry.id);
            return (
              <SettingsRow
                key={entry.id}
                id={`mcp-server-${entry.id}`}
                title={entry.name}
                description={
                  runtime?.status === "failed" && runtime.stderrTail
                    ? runtime.stderrTail
                    : `${entry.toolName}_ prefix · ${
                        runtime?.tools.length ? `${runtime.tools.length} tools` : "no tools"
                      }${
                        runtime?.skippedTools?.length
                          ? ` · ${runtime.skippedTools.length} name clash`
                          : ""
                      }`
                }
                status={<McpServerStatusBadge status={runtime?.status ?? "stopped"} />}
                control={
                  <EnableSwitch
                    checked={entry.enabled}
                    onChange={(enabled) =>
                      updateSettings({
                        registeredMcpServers: { [entry.id]: { ...entry, enabled } },
                      })
                    }
                  />
                }
                resetAction={
                  <Button
                    size="icon-xs"
                    variant="ghost-destructive"
                    aria-label={`Remove ${entry.name}`}
                    onClick={() => updateSettings({ registeredMcpServers: { [entry.id]: null } })}
                  >
                    <Trash2Icon className="size-3.5" />
                  </Button>
                }
              />
            );
          })
        )}
      </SettingsSection>
    </SettingsPageContainer>
  );
}

function EnableSwitch({
  checked,
  onChange,
}: {
  checked: boolean;
  onChange: (enabled: boolean) => void;
}) {
  return (
    <Switch
      checked={checked}
      onCheckedChange={(next) => onChange(Boolean(next))}
      aria-label={checked ? "Disable this server" : "Enable this server"}
    />
  );
}

function RegisterServerForm({
  existing,
  onAdd,
}: {
  existing: ReadonlyArray<RegisteredMcpServerEntry>;
  onAdd: (entry: RegisteredMcpServerEntry) => void;
}) {
  const [document, setDocument] = useState("");
  const [bundleDir, setBundleDir] = useState("");
  const [parsed, setParsed] = useState<ParsedMcpRegistration | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState("");
  const [toolName, setToolName] = useState("");

  const readDocument = (next: string) => {
    setDocument(next);
    setError(null);
    if (next.trim() === "") {
      setParsed(null);
      return;
    }
    let json: unknown;
    try {
      json = JSON.parse(next);
    } catch {
      setParsed(null);
      setError("That is not valid JSON. Paste the whole server.json or MCPB manifest.json.");
      return;
    }
    const result = parseMcpRegistration(json);
    if (!result.ok) {
      setParsed(null);
      setError(result.message);
      return;
    }
    setParsed(result.registration);
    setName(result.registration.name);
    setToolName(defaultToolName(result.registration.name));
  };

  const add = () => {
    if (parsed === null) return;
    let json: unknown;
    try {
      json = JSON.parse(document);
    } catch {
      setError("That is not valid JSON.");
      return;
    }
    const trimmedName = name.trim() || parsed.name;
    const candidate: RegisteredMcpServerEntry = {
      id: mcpServerIdFromName(trimmedName),
      name: trimmedName,
      toolName: toolName.trim(),
      enabled: true,
      source:
        parsed.sourceKind === "mcpb"
          ? { kind: "mcpb", manifest: json, bundleDir: bundleDir.trim() }
          : { kind: "server.json", document: json },
      config: {},
    };
    const problem = validateEntry(candidate, existing);
    if (problem !== null) {
      setError(problem);
      return;
    }
    if (
      parsed.sourceKind === "mcpb" &&
      candidate.source.kind === "mcpb" &&
      candidate.source.bundleDir === ""
    ) {
      setError("Set the bundle directory the manifest's files live in.");
      return;
    }
    onAdd(candidate);
    setDocument("");
    setBundleDir("");
    setParsed(null);
    setName("");
    setToolName("");
    setError(null);
  };

  return (
    <SettingsSection id="register-mcp-server" title="Add an MCP server">
      <SettingsRow
        {...searchableSetting("register-mcp-server")}
        title="Register a server"
        description="Paste the server.json from the MCP Registry, or an MCPB manifest.json. T3 runs it from this machine; remote servers are not supported."
      >
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label="Server document"
            className="min-h-32 w-full"
            spellCheck={false}
            placeholder='{"name": "io.acme/team-notes", "packages": [ … ]}'
            value={document}
            onChange={(event) => readDocument(event.currentTarget.value)}
          />
          {parsed?.sourceKind === "mcpb" ? (
            <Input
              aria-label="Bundle directory"
              spellCheck={false}
              placeholder="Directory holding the MCPB manifest and its files"
              value={bundleDir}
              onChange={(event) => {
                setBundleDir(event.currentTarget.value);
                setError(null);
              }}
            />
          ) : null}
          {parsed === null ? null : (
            <div className="grid gap-2 sm:grid-cols-2">
              <Input
                aria-label="Server name"
                placeholder={parsed.name}
                value={name}
                onChange={(event) => {
                  setName(event.currentTarget.value);
                  setError(null);
                }}
              />
              <Input
                aria-label="Tool name prefix"
                spellCheck={false}
                placeholder={defaultToolName(name || parsed.name)}
                value={toolName}
                onChange={(event) => {
                  setToolName(event.currentTarget.value);
                  setError(null);
                }}
              />
            </div>
          )}
          {error === null ? null : <p className="text-xs text-destructive-foreground">{error}</p>}
          <div className="flex items-center justify-end">
            <Button size="sm" variant="secondary" disabled={parsed === null} onClick={add}>
              <PlusIcon className="size-3.5" />
              Register
            </Button>
          </div>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
