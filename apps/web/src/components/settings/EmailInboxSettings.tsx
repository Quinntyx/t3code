import { useState } from "react";
import { EmailInboxAccountConfig, ServerSettings } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { useGT } from "gt-react";

import { DraftInput } from "../ui/draft-input";
import { ScopedSwitch } from "./ScopedSwitch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const decodeAccounts = Schema.decodeOption(
  Schema.fromJsonString(Schema.Array(EmailInboxAccountConfig)),
);
const decodeCommand = Schema.decodeOption(
  Schema.fromJsonString(ServerSettings.fields.emailRefreshCommand),
);

export function EmailInboxSettings() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const update = useUpdateScopedSettings();
  const [accountsError, setAccountsError] = useState<string | null>(null);
  const [commandError, setCommandError] = useState<string | null>(null);

  return (
    <SettingsSection id="email-inbox" title={gt("Inbox")}>
      <SettingsRow
        serverScoped
        settingKeys={["emailInboxEnabled"]}
        {...searchableSetting("email-inbox-enabled")}
        description={gt(
          "Let agents in this environment search and read configured inboxes through native tools. Reading preserves unread flags. External MCP clients do not gain inbox access.",
        )}
        control={
          <ScopedSwitch
            settingKeys={["emailInboxEnabled"]}
            checked={settings.emailInboxEnabled}
            onCheckedChange={(value) => update({ emailInboxEnabled: Boolean(value) })}
            aria-label={gt("Agents can read inboxes")}
          />
        }
      />
      {settings.emailInboxEnabled ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["emailTaggingEnabled"]}
            {...searchableSetting("email-tagging-enabled")}
            description={gt(
              "Allow explicitly authorized tag changes, including marking reviewed mail read. Sending still requires your review and Send in a draft card.",
            )}
            control={
              <ScopedSwitch
                settingKeys={["emailTaggingEnabled"]}
                checked={settings.emailTaggingEnabled}
                onCheckedChange={(value) => update({ emailTaggingEnabled: Boolean(value) })}
                aria-label={gt("Agents can tag messages")}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["emailNotmuchConfigFile"]}
            {...searchableSetting("email-notmuch-config")}
            description={gt(
              "The notmuch config on the server machine. Leave empty for that host's existing default. T3 does not create a mailbox or run sync when reading.",
            )}
            control={
              <div className="w-full sm:w-96">
                <DraftInput
                  size="sm"
                  value={settings.emailNotmuchConfigFile}
                  onCommit={(value) => update({ emailNotmuchConfigFile: value })}
                  placeholder="~/.notmuch-config"
                  aria-label={gt("Inbox notmuch config")}
                  spellCheck={false}
                />
              </div>
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["emailInboxAccounts"]}
            {...searchableSetting("email-inbox-accounts")}
            description={gt(
              "JSON account scopes, for example {example}. Use the sender account name for native replies. Only these scopes are accessible.",
              { example: '[{"name":"work","query":"path:work/**"}]' },
            )}
            control={
              <div className="w-full sm:w-96">
                <DraftInput
                  size="sm"
                  value={JSON.stringify(settings.emailInboxAccounts)}
                  aria-label={gt("Inbox account scopes")}
                  spellCheck={false}
                  onCommit={(value) => {
                    const decoded = decodeAccounts(value);
                    if (
                      Option.isNone(decoded) ||
                      new Set(decoded.value.map((account) => account.name)).size !==
                        decoded.value.length
                    ) {
                      setAccountsError(
                        gt("Enter a JSON array of unique account names and nonempty query scopes."),
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
            description={gt(
              'Trusted sync argv as JSON, e.g. ["/path/to/mail-sync.sh"]. [] disables refresh. Sync may reconcile flags, expunge mail and run routing hooks; reads never run it automatically.',
            )}
            control={
              <div className="w-full sm:w-96">
                <DraftInput
                  size="sm"
                  value={JSON.stringify(settings.emailRefreshCommand)}
                  aria-label={gt("Mail refresh command")}
                  spellCheck={false}
                  onCommit={(value) => {
                    const decoded = decodeCommand(value);
                    if (Option.isNone(decoded)) {
                      setCommandError(
                        gt(
                          "Enter a JSON array containing the executable and its arguments, or [].",
                        ),
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
