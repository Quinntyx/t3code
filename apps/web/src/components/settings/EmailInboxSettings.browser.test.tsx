import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";
import { render } from "../../../test/render";

const state = vi.hoisted(() => ({
  settings: {} as typeof DEFAULT_UNIFIED_SETTINGS,
  update: vi.fn(),
}));

vi.mock(import("./useScopedSettings"), () => ({
  useScopedSettings: (() => state.settings) as never,
  useScopedSettingsMixed: () => false,
  useUpdateScopedSettings: () => state.update,
}));
vi.mock(import("./settingsLayout"), () => ({
  SettingsSection: ({ children }) => <section>{children}</section>,
  SettingsRow: ({ title, control }) => (
    <div>
      {title}
      {control}
    </div>
  ),
}));

import { EmailInboxSettings } from "./EmailInboxSettings";

it("rejects invalid account scopes and refresh argv without replacing configured values", async () => {
  state.settings = { ...DEFAULT_UNIFIED_SETTINGS, emailInboxEnabled: true };
  state.update.mockReset();
  await using screen = await render(<EmailInboxSettings />);
  const accounts = screen.getByRole("textbox", { name: "Inbox account scopes" });
  const command = screen.getByRole("textbox", { name: "Mail refresh command" });
  for (const value of [
    "not JSON",
    '[{"name":"work","query":"*"},{"name":"work","query":"tag:inbox"}]',
  ]) {
    await userEvent.fill(accounts, value);
    await userEvent.keyboard("{Enter}");
    await expect
      .element(
        screen.getByText("Enter a JSON array of unique account names and nonempty query scopes."),
      )
      .toBeVisible();
    expect(state.update).not.toHaveBeenCalled();
  }
  await userEvent.fill(accounts, '[{"name":"work","query":"path:work/**"}]');
  await userEvent.keyboard("{Enter}");
  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    emailInboxAccounts: [{ name: "work", query: "path:work/**" }],
  });
  state.update.mockClear();
  await userEvent.fill(command, '["   "]');
  await userEvent.keyboard("{Enter}");
  await expect
    .element(
      screen.getByText("Enter a JSON array containing the executable and its arguments, or []."),
    )
    .toBeVisible();
  expect(state.update).not.toHaveBeenCalled();
  await userEvent.fill(command, '["/fixture/sync","--normal"]');
  await userEvent.keyboard("{Enter}");
  expect(state.update).toHaveBeenCalledExactlyOnceWith({
    emailRefreshCommand: ["/fixture/sync", "--normal"],
  });
});
