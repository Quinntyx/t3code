import { useState } from "react";
import { EmailInboxAccountConfig, ServerSettings } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { DraftInput } from "../ui/draft-input";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const decodeAccounts = Schema.decodeOption(
  Schema.fromJsonString(Schema.Array(EmailInboxAccountConfig)),
);
const decodeCommand = Schema.decodeOption(
  Schema.fromJsonString(ServerSettings.fields.emailRefreshCommand),
);

export function EmailInboxSettings() {
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);

  return (
    <SettingsSection id="email-inbox" title="Inbox">
      <SettingsRow
        serverScoped
        settingKeys={["emailInboxEnabled"]}
        {...searchableSetting("email-inbox-enabled")}
        description="Let agents in this environment search and read configured inboxes through native tools. Reading preserves unread flags. External MCP clients do not gain inbox access."
        control={
          <ScopedSwitch
            settingKeys={["emailInboxEnabled"]}
            checked={settings.emailInboxEnabled}
            onCheckedChange={(value) => update({ emailInboxEnabled: Boolean(value) })}
            aria-label="Agents can read inboxes"
          />
        }
      />
      {settings.emailInboxEnabled ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["emailTaggingEnabled"]}
            {...searchableSetting("email-tagging-enabled")}
            description="Allow explicitly authorized tag changes, including marking reviewed mail read. Sending still requires your review and Send in a draft card."
            control={
              <ScopedSwitch
                settingKeys={["emailTaggingEnabled"]}
                checked={settings.emailTaggingEnabled}
                onCheckedChange={(value) => update({ emailTaggingEnabled: Boolean(value) })}
                aria-label="Agents can tag messages"
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["emailNotmuchConfigFile"]}
            {...searchableSetting("email-notmuch-config")}
            description="The notmuch config on the server machine. Leave empty for that host's existing default. T3 does not create a mailbox or run sync when reading."
            control={
              <div className="w-full sm:w-96">
                <DraftInput
                  size="sm"
                  value={settings.emailNotmuchConfigFile}
                  onCommit={(value) => update({ emailNotmuchConfigFile: value })}
                  placeholder="~/.notmuch-config"
                  aria-label="Inbox notmuch config"
                  spellCheck={false}
                />
              </div>
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["emailInboxAccounts"]}
            {...searchableSetting("email-inbox-accounts")}
            description={
              'JSON account scopes, for example [{"name":"work","query":"path:work/**"}]. Use the sender account name for native replies. Only these scopes are accessible.'
            }
            control={
              <div className="w-full sm:w-96">
                <DraftInput
                  size="sm"
                  value={JSON.stringify(settings.emailInboxAccounts)}
                  aria-label="Inbox account scopes"
                  spellCheck={false}
                  onCommit={(value) => {
                    const decoded = decodeAccounts(value);
                    if (
                      Option.isNone(decoded) ||
                      new Set(decoded.value.map((account) => account.name)).size !==
                        decoded.value.length
                    ) {
                      setAccountsError(
                        "Enter a JSON array of unique account names and nonempty query scopes.",
                      );
                      return;
                    }
                    setAccountsError(null);
                    update({ emailInboxAccounts: decoded.value });
                  }}
                />
                {accountsError ? (
                  <p role="alert" className="text-destructive text-xs">
                    {accountsError}
                  </p>
                ) : null}
              </div>
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["emailRefreshCommand"]}
            {...searchableSetting("email-refresh-command")}
            description={
              'Trusted sync argv as JSON, e.g. ["/path/to/mail-sync.sh"]. [] disables refresh. Sync may reconcile flags, expunge mail and run routing hooks; reads never run it automatically.'
            }
            control={
              <div className="w-full sm:w-96">
                <DraftInput
                  size="sm"
                  value={JSON.stringify(settings.emailRefreshCommand)}
                  aria-label="Mail refresh command"
                  spellCheck={false}
                  onCommit={(value) => {
                    const decoded = decodeCommand(value);
                    if (Option.isNone(decoded)) {
                      setCommandError(
                        "Enter a JSON array containing the executable and its arguments, or [].",
                      );
                      return;
                    }
                    setCommandError(null);
                    update({ emailRefreshCommand: decoded.value });
                  }}
                />
                {commandError ? (
                  <p role="alert" className="text-destructive text-xs">
                    {commandError}
                  </p>
                ) : null}
              </div>
            }
          />
        </>
      ) : null}
    </SettingsSection>
  );
}
