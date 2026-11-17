import { maxMcpToolPrefixLength, type RegisteredMcpServerEntry } from "@t3tools/contracts";
import {
  isValidMcpToolName,
  parseMcpRegistration,
  type McpConfigField,
  type McpConfigValue,
} from "@t3tools/shared/mcpRegistration";
import { useParams } from "@tanstack/react-router";
import { useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Badge } from "../ui/badge";
import { DraftInput } from "../ui/draft-input";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { toastManager } from "../ui/toast";
import { SettingsPageContainer, SettingsRow, SettingsSection } from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const valueOf = (config: Readonly<Record<string, McpConfigValue>>, field: McpConfigField) =>
  config[field.key] ?? field.default;

/**
 * A server's own settings form, generated from what its document declares. Values live in the
 * entry's `config`, so a save is one settings write.
 */
export function McpServerSettingsPanel() {
  const { serverId } = useParams({ from: "/_chat/settings/mcp/$serverId" });
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment, scope } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const { data } = useEnvironmentQuery(
    environmentId === null
      ? null
      : serverEnvironment.registeredMcpServersState({ environmentId, input: {} }),
  );
  const runtime = data?.servers.find((server) => server.id === serverId);
  const entry = settings.registeredMcpServers.find((server) => server.id === serverId);
  const [notFound] = useState(() => entry === undefined);

  // The server runs on the machine that registered it, so these settings are that machine's.
  if (scope.kind !== "environment" || environment === null) {
    return (
      <SettingsPageContainer>
        <SettingsSection id="mcp-server-scope" title="MCP server">
          <SettingsScopeNotice target="environment" inline>
            Choose the environment this server runs on to change its settings.
          </SettingsScopeNotice>
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  if (entry === undefined) {
    return (
      <SettingsPageContainer>
        <SettingsSection id="mcp-server-missing" title="MCP server">
          <SettingsRow
            title="Not registered"
            description={
              notFound
                ? "This server is no longer registered. Add it again from Settings → Capabilities."
                : "Loading…"
            }
          />
        </SettingsSection>
      </SettingsPageContainer>
    );
  }

  const save = (next: RegisteredMcpServerEntry) =>
    updateSettings({
      registeredMcpServers: settings.registeredMcpServers.map((candidate) =>
        candidate.id === next.id ? next : candidate,
      ),
    });

  const parsed = parseMcpRegistration(
    entry.source.kind === "server.json" ? entry.source.document : entry.source.manifest,
  );
  const fields = parsed.ok ? parsed.registration.fields : [];

  return (
    <SettingsPageContainer>
      <SettingsSection id="mcp-server" title={entry.name}>
        <SettingsRow
          serverScoped
          settingKeys={["registeredMcpServers"]}
          title="Enabled"
          description="While on, T3 Code runs this server and its tools are available to agents."
          status={statusBadge(runtime?.status ?? (entry.enabled ? "starting" : "stopped"))}
          control={
            <Switch
              checked={entry.enabled}
              onCheckedChange={(next) => save({ ...entry, enabled: Boolean(next) })}
              aria-label="Run this MCP server"
            />
          }
        />
        <SettingsRow
          serverScoped
          settingKeys={["registeredMcpServers"]}
          title="Tool name"
          description={`Agents call this server's tools as ${entry.toolName}_<tool>. Lowercase letters, digits, _ and - only.`}
          control={
            <ToolNameInput
              value={entry.toolName}
              others={settings.registeredMcpServers.filter(
                (candidate) => candidate.id !== entry.id,
              )}
              onCommit={(toolName) => save({ ...entry, toolName })}
            />
          }
        />
        {runtime?.status === "failed" && runtime.stderrTail ? (
          <SettingsRow
            title="Last failure"
            description={
              <span className="block max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-xs">
                {runtime.stderrTail}
              </span>
            }
          />
        ) : null}
        {data === null ? null : runtime === undefined ? null : (
          <SettingsRow
            title="Tools"
            description={
              runtime.tools.length === 0
                ? "No tools are available while the server is not running."
                : runtime.tools.join(", ")
            }
          />
        )}
        {runtime?.skippedTools === undefined || runtime.skippedTools.length === 0 ? null : (
          <SettingsRow
            title="Not exposed"
            description={`${runtime.skippedTools.join(", ")}: another tool already answers to the name. Change this server's Tool name.`}
          />
        )}
      </SettingsSection>

      {fields.length === 0 ? null : (
        <SettingsSection id="mcp-server-config" title="Configuration">
          {fields.map((field) => (
            <SettingsRow
              key={field.key}
              title={field.label}
              description={field.description ?? field.key}
              status={
                field.secret && configuredSecret(entry, field.key) ? (
                  <Badge variant="outline">Saved</Badge>
                ) : undefined
              }
              control={
                <FieldControl
                  field={field}
                  entry={entry}
                  onChange={(value) =>
                    save({
                      ...entry,
                      config:
                        value === undefined
                          ? Object.fromEntries(
                              Object.entries(entry.config).filter(([key]) => key !== field.key),
                            )
                          : { ...entry.config, [field.key]: value },
                    })
                  }
                />
              }
            />
          ))}
        </SettingsSection>
      )}
    </SettingsPageContainer>
  );
}

/** A saved secret arrives as the redaction marker, never the value, so any text means "set". */
const configuredSecret = (entry: RegisteredMcpServerEntry, key: string) => {
  const value = entry.config[key];
  return typeof value === "string" && value.length > 0;
};

function statusBadge(status: "running" | "starting" | "failed" | "stopped") {
  switch (status) {
    case "running":
      return <Badge variant="success">Running</Badge>;
    case "starting":
      return <Badge variant="info">Starting</Badge>;
    case "failed":
      return <Badge variant="error">Failed</Badge>;
    case "stopped":
      return <Badge variant="outline">Stopped</Badge>;
  }
}

function ToolNameInput({
  value,
  others,
  onCommit,
}: {
  value: string;
  others: ReadonlyArray<RegisteredMcpServerEntry>;
  onCommit: (toolName: string) => void;
}) {
  const [draft, setDraft] = useState(value);
  const problem = !isValidMcpToolName(draft)
    ? `Start with a lowercase letter and use only a-z, 0-9, _ and - (up to ${maxMcpToolPrefixLength}).`
    : others.some((entry) => entry.toolName === draft)
      ? "Another registered server already uses that tool name."
      : null;
  return (
    <div className="flex flex-col items-end gap-1">
      <Input
        size="sm"
        className="w-52"
        spellCheck={false}
        aria-label="Tool name prefix"
        aria-invalid={problem !== null}
        value={draft}
        onChange={(event) => setDraft(event.currentTarget.value)}
        onBlur={() => {
          if (problem !== null) {
            setDraft(value);
            toastManager.add({
              type: "warning",
              title: "Tool name not saved",
              description: problem,
            });
            return;
          }
          if (draft !== value) onCommit(draft);
        }}
      />
      {problem === null ? null : (
        <span className="text-xs text-destructive-foreground">{problem}</span>
      )}
    </div>
  );
}

function FieldControl({
  field,
  entry,
  onChange,
}: {
  field: McpConfigField;
  entry: RegisteredMcpServerEntry;
  onChange: (value: McpConfigValue | undefined) => void;
}) {
  const value = valueOf(entry.config, field);

  if (field.type === "boolean") {
    return (
      <Switch
        checked={value === true}
        onCheckedChange={(next) => onChange(Boolean(next))}
        aria-label={field.label}
      />
    );
  }
  if (field.type === "choice" && field.choices !== undefined) {
    return (
      <Select
        value={typeof value === "string" ? value : ""}
        onValueChange={(next) => {
          if (next !== null) onChange(next);
        }}
        aria-label={field.label}
      >
        <SelectTrigger size="sm" className="w-56">
          <SelectValue placeholder="Choose…" />
        </SelectTrigger>
        <SelectContent>
          {field.choices.map((choice) => (
            <SelectItem key={choice} value={choice}>
              {choice}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }
  if (field.type === "number") {
    return (
      <Input
        size="sm"
        type="number"
        className="w-28"
        aria-label={field.label}
        min={field.min}
        max={field.max}
        value={typeof value === "number" ? String(value) : ""}
        onChange={(event) => {
          const next = Number(event.currentTarget.value);
          onChange(
            event.currentTarget.value.trim() === "" || Number.isNaN(next) ? undefined : next,
          );
        }}
      />
    );
  }
  if (field.secret) {
    // A saved secret is shown only as "saved"; typing replaces it.
    return (
      <div className="flex w-full max-w-72 items-center gap-2">
        <DraftInput
          size="sm"
          type="password"
          autoComplete="off"
          spellCheck={false}
          className="min-w-0 flex-1"
          aria-label={field.label}
          value=""
          placeholder={configuredSecret(entry, field.key) ? "Saved, type to replace" : "Not set"}
          onCommit={(next) => {
            if (next === "") return;
            onChange(next);
          }}
        />
      </div>
    );
  }
  return (
    <DraftInput
      size="sm"
      className="w-full max-w-72"
      spellCheck={field.type !== "path"}
      aria-label={field.label}
      placeholder={field.required ? "Required" : "Optional"}
      value={typeof value === "string" ? value : ""}
      onCommit={(next) => onChange(next === "" ? undefined : next)}
    />
  );
}
