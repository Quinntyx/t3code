import { mcpServerIdFromName, type RegisteredMcpServerEntry } from "@t3tools/contracts";
import { parseMcpRegistration, type ParsedMcpRegistration } from "@t3tools/shared/mcpRegistration";
import { T, useGT } from "gt-react";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { Textarea } from "../ui/textarea";
import { defaultToolName, validateEntry } from "./CapabilitiesSettings.logic";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function CapabilitiesSettingsPanel() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, scope } = useSettingsScope();

  const entries = settings.registeredMcpServers;

  // A server runs on the machine that registered it, so its list is that machine's alone.
  if (scope.kind !== "environment" || environment === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection id="capabilities" title={gt("MCP servers")}>
          <SettingsScopeNotice target="environment" inline>
            {gt("Choose one environment to manage the MCP servers it runs.")}
          </SettingsScopeNotice>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  return (
    <SettingsPageContainer>
      <SettingsSection id="capabilities" title={gt("MCP servers")}>
        <SettingsRow
          serverScoped
          settingKeys={["registeredMcpServers"]}
          {...searchableSetting("mcp-servers")}
          title={gt("Local MCP servers")}
          description={gt(
            "T3 Code starts each enabled server on this machine and gives its tools to agents as native tools. Only servers it can launch itself (stdio) are supported.",
          )}
        />
      </SettingsSection>

      <RegisterServerForm
        existing={entries}
        onAdd={(entry) => updateSettings({ registeredMcpServers: { [entry.id]: entry } })}
      />

      <SettingsSection id="registered-servers" title={gt("Registered servers")}>
        {entries.length === 0 ? (
          <SettingsRow
            {...searchableSetting("registered-servers")}
            description={gt("No MCP servers are registered yet.")}
          />
        ) : (
          entries.map((entry) => (
            <SettingsRow
              key={entry.id}
              id={`mcp-server-${entry.id}`}
              title={entry.name}
              description={gt("Agents call its tools as {toolName}_<tool>.", {
                toolName: entry.toolName,
              })}
              control={
                <EnableSwitch
                  checked={entry.enabled}
                  onChange={(enabled) =>
                    updateSettings({
                      registeredMcpServers: { [entry.id]: { enabled } },
                    })
                  }
                />
              }
              resetAction={
                <Button
                  size="icon-xs"
                  variant="ghost-destructive"
                  aria-label={gt("Remove {name}", { name: entry.name })}
                  onClick={() => updateSettings({ registeredMcpServers: { [entry.id]: null } })}
                >
                  <Trash2Icon className="size-3.5" />
                </Button>
              }
            />
          ))
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
  const gt = useGT();
  return (
    <Switch
      checked={checked}
      onCheckedChange={(next) => onChange(Boolean(next))}
      aria-label={checked ? gt("Disable this server") : gt("Enable this server")}
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
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const [document, setDocument] = useState("");
  const [bundleDir, setBundleDir] = useState("");
  const [parsed, setParsed] = useState<ParsedMcpRegistration | null>(null);
  const [error, setError] = useState<string | null>(null);
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
      setError(gt("That is not valid JSON. Paste the whole server.json or MCPB manifest.json."));
      return;
    }
    const result = parseMcpRegistration(json);
    if (!result.ok) {
      setParsed(null);
      setError(result.message);
      return;
    }
    setParsed(result.registration);
    setToolName(defaultToolName(result.registration.name));
  };

  const add = () => {
    if (parsed === null) return;
    let json: unknown;
    try {
      json = JSON.parse(document);
    } catch {
      setError(gt("That is not valid JSON."));
      return;
    }
    const candidate: RegisteredMcpServerEntry = {
      id: mcpServerIdFromName(parsed.name),
      name: parsed.name,
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
      setError(gt("Set the bundle directory the manifest's files live in."));
      return;
    }
    onAdd(candidate);
    setDocument("");
    setBundleDir("");
    setParsed(null);
    setToolName("");
    setError(null);
  };

  return (
    <SettingsSection id="register-mcp-server" title={gt("Add an MCP server")}>
      <SettingsRow
        {...searchableSetting("register-mcp-server")}
        title={gt("Register a server")}
        description={gt(
          "Paste the server.json from the MCP Registry, or an MCPB manifest.json. T3 runs it from this machine; remote servers are not supported.",
        )}
      >
        <div className="flex flex-col gap-2">
          <Textarea
            aria-label={gt("Server document")}
            className="min-h-32 w-full"
            spellCheck={false}
            // oxlint-disable-next-line t3code/no-untranslated-copy -- literal JSON snippet example
            placeholder='{"name": "io.acme/team-notes", "packages": [ … ]}'
            value={document}
            onChange={(event) => readDocument(event.currentTarget.value)}
          />
          {parsed?.sourceKind === "mcpb" ? (
            <Input
              aria-label={gt("Bundle directory")}
              spellCheck={false}
              placeholder={gt("Directory holding the MCPB manifest and its files")}
              value={bundleDir}
              onChange={(event) => {
                setBundleDir(event.currentTarget.value);
                setError(null);
              }}
            />
          ) : null}
          {parsed === null ? null : (
            <Input
              aria-label={gt("Tool name prefix")}
              spellCheck={false}
              placeholder={defaultToolName(parsed.name)}
              value={toolName}
              onChange={(event) => {
                setToolName(event.currentTarget.value);
                setError(null);
              }}
            />
          )}
          {error === null ? null : <p className="text-xs text-destructive-foreground">{error}</p>}
          <div className="flex items-center justify-end">
            <Button size="sm" variant="secondary" disabled={parsed === null} onClick={add}>
              <PlusIcon className="size-3.5" />
              <T>Register</T>
            </Button>
          </div>
        </div>
      </SettingsRow>
    </SettingsSection>
  );
}
