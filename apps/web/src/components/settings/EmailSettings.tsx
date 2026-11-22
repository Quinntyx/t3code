import { AuthSettingsWriteScope, DEFAULT_SERVER_SETTINGS } from "@t3tools/contracts";
import { T, useGT } from "gt-react";

import { RefreshIcon } from "~/components/ui/refresh-icon";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { ScopedSwitch } from "./ScopedSwitch";
import { EmailInboxSettings } from "./EmailInboxSettings";
import { useSettingsScope } from "./SettingsScopeContext";
import { useSearchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

export function EmailSettingsPanel() {
  const gt = useGT();
  const searchableSetting = useSearchableSetting();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const { environment } = useSettingsScope();
  const environmentId = environment?.environmentId ?? null;
  const canRead = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const enabled = settings.emailEnabled;
  const { data, error, isPending, refresh } = useEnvironmentQuery(
    environmentId === null || !canRead || !enabled
      ? null
      : serverEnvironment.emailAccounts({ environmentId, input: {} }),
  );

  return (
    <SettingsPageContainer>
      <SettingsSection id="email" title={gt("Email")}>
        <SettingsRow
          serverScoped
          settingKeys={["emailEnabled"]}
          {...searchableSetting("email-enabled")}
          description={gt(
            "Agents draft emails in a card in the thread. Nothing is sent until you review it and press Send.",
          )}
          control={
            <ScopedSwitch
              settingKeys={["emailEnabled"]}
              checked={enabled}
              onCheckedChange={(checked) => updateSettings({ emailEnabled: Boolean(checked) })}
              aria-label={gt("Agents can draft emails")}
            />
          }
        />
        {enabled ? (
          <SettingsRow
            serverScoped
            settingKeys={["emailAccountsFile"]}
            {...searchableSetting("email-accounts-file")}
            description={gt(
              "Emails send with the accounts in this aerc config. Leave empty for aerc's default.",
            )}
            resetAction={
              settings.emailAccountsFile !== DEFAULT_SERVER_SETTINGS.emailAccountsFile ? (
                <SettingResetButton
                  ariaLabel={gt("Reset aerc accounts file to default")}
                  onClick={() => updateSettings({ emailAccountsFile: "" })}
                />
              ) : null
            }
            control={
              <DraftInput
                size="sm"
                className="w-full sm:w-72"
                value={settings.emailAccountsFile}
                onCommit={(next) => updateSettings({ emailAccountsFile: next })}
                placeholder="~/.config/aerc/accounts.conf"
                spellCheck={false}
                aria-label={gt("aerc accounts file")}
              />
            }
          />
        ) : null}
      </SettingsSection>

      <EmailInboxSettings />

      {enabled ? (
        <SettingsSection
          id="email-accounts"
          title={gt("Accounts")}
          headerAction={
            canRead ? (
              <Button
                size="icon-xs"
                variant="ghost-muted"
                aria-label={gt("Reload accounts")}
                disabled={isPending}
                onClick={refresh}
              >
                <RefreshIcon refreshing={isPending} />
              </Button>
            ) : null
          }
        >
          {!canRead ? (
            <SettingsRow
              {...searchableSetting("email-accounts")}
              description={gt(
                "You need settings access on this environment to see its mail accounts.",
              )}
            />
          ) : error !== null ? (
            <SettingsRow {...searchableSetting("email-accounts")} description={error} />
          ) : data === null ? null : data.fileProblem !== undefined ||
            data.accounts.length === 0 ? (
            <SettingsRow
              {...searchableSetting("email-accounts")}
              title={data.file}
              description={data.fileProblem ?? gt("No accounts in this file.")}
            />
          ) : (
            data.accounts.map((account) => (
              <SettingsRow
                key={account.name}
                title={account.from ?? account.name}
                description={account.problem ?? account.sending}
                status={
                  account.problem === undefined ? (
                    <span className="text-muted-foreground">{account.name}</span>
                  ) : (
                    <Badge variant="warning">
                      <T>Can't send</T>
                    </Badge>
                  )
                }
              />
            ))
          )}
        </SettingsSection>
      ) : null}
    </SettingsPageContainer>
  );
}
