import type { RegisteredMcpServerEntry } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  registeredMcpServers: [] as ReadonlyArray<RegisteredMcpServerEntry>,
  updateSettings:
    vi.fn<
      (
        patch: unknown,
        options?: { readonly onFailed?: () => void; readonly onSettled?: () => void },
      ) => void
    >(),
}));

vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useParams: (() => ({ serverId: "notes" })) as never,
}));
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      registeredMcpServersState: (() => null) as never,
    },
  };
});
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({ data: null, error: null, isPending: false })) as never,
}));
vi.mock(import("./useScopedSettings"), async (original) => ({
  ...(await original()),
  useScopedSettings: (() => ({ registeredMcpServers: state.registeredMcpServers })) as never,
  useUpdateScopedSettings: (() => state.updateSettings) as never,
}));
vi.mock(import("./SettingsScopeContext"), async (original) => ({
  ...(await original()),
  useSettingsScope: (() => ({
    scope: { kind: "environment", environmentIds: ["local"] },
    environment: { environmentId: "local" },
    connectedEnvironments: [],
    targets: [],
    target: null,
  })) as never,
}));
vi.mock(import("./settingsLayout"), async (original) => ({
  ...(await original()),
  SettingsPageContainer: (({ children }: { children: ReactNode }) => children) as never,
  SettingsSection: (({ children }: { children: ReactNode }) => children) as never,
  SettingsRow: (({ title, control }: { title: ReactNode; control?: ReactNode }) => (
    <div>
      <h3>{title}</h3>
      {control}
    </div>
  )) as never,
}));
vi.mock(import("./SettingsScopeNotice"), async (original) => ({
  ...(await original()),
  SettingsScopeNotice: (() => null) as never,
}));
vi.mock(import("./McpServerStatusBadge"), async (original) => ({
  ...(await original()),
  McpServerStatusBadge: (() => null) as never,
}));

import { McpServerSettingsPanel } from "./McpServerSettingsPanel";
import { act, render } from "../../../test/render";

const entry: RegisteredMcpServerEntry = {
  id: "notes",
  name: "Notes",
  toolName: "notes",
  enabled: true,
  source: {
    kind: "mcpb",
    bundleDir: "/bundle",
    manifest: {
      manifest_version: "0.2",
      name: "acme-notes",
      display_name: "Acme Notes",
      server: { mcp_config: { command: "node", args: ["index.js"], env: {} } },
      user_config: {
        workspace: { type: "string", title: "Workspace" },
        region: { type: "string", title: "Region" },
        retries: { type: "number", title: "Retries" },
      },
    },
  },
  config: {},
};

/** Saves land in the list the page reads, as a server round trip would deliver them. */
const setup = async () => {
  state.registeredMcpServers = [entry];
  state.updateSettings.mockReset().mockImplementation((patch: unknown) => {
    const changes = (
      patch as {
        registeredMcpServers: Record<string, RegisteredMcpServerEntry | null>;
      }
    ).registeredMcpServers;
    for (const [id, value] of Object.entries(changes)) {
      state.registeredMcpServers =
        value === null
          ? state.registeredMcpServers.filter((candidate) => candidate.id !== id)
          : state.registeredMcpServers.some((candidate) => candidate.id === id)
            ? state.registeredMcpServers.map((candidate) =>
                candidate.id === id ? value : candidate,
              )
            : [...state.registeredMcpServers, value];
    }
  });
  return render(<McpServerSettingsPanel />);
};

describe("registered MCP server settings", () => {
  it("keeps an earlier edit when a later field is saved before the first round trip", async () => {
    await using screen = await setup();
    // No save is echoed back, so each one has to start from the page's own earlier edits.
    state.updateSettings.mockReset();

    // Unstyled here, the switch has no box for a pointer click, so it is clicked through the DOM.
    (screen.getByRole("switch", { name: "Run this MCP server" }).element() as HTMLElement).click();
    await userEvent.fill(screen.getByRole("textbox", { name: "Workspace" }), "acme");
    await userEvent.tab();
    await userEvent.fill(screen.getByRole("textbox", { name: "Region" }), "eu");
    await userEvent.tab();

    const [last] = state.updateSettings.mock.lastCall as [
      { registeredMcpServers: Record<string, RegisteredMcpServerEntry | null> },
    ];
    expect(last.registeredMcpServers["notes"]).toMatchObject({
      enabled: false,
      config: { workspace: "acme", region: "eu" },
    });
  });

  it("drops the draft after a save is acknowledged so later edits use the server's value", async () => {
    await using screen = await setup();
    let acknowledge: () => void = () => {};
    state.updateSettings.mockReset().mockImplementation((_patch, options) => {
      acknowledge = () => options?.onSettled?.();
    });

    await userEvent.fill(screen.getByRole("textbox", { name: "Workspace" }), "stale");
    await userEvent.tab();
    expect(state.updateSettings).toHaveBeenCalledTimes(1);

    // Another client changes the server's settings while the save is still in flight.
    state.registeredMcpServers = [{ ...entry, toolName: "other" }];
    await act(() => acknowledge());

    await act(() => {
      (
        screen.getByRole("switch", { name: "Run this MCP server" }).element() as HTMLElement
      ).click();
    });
    expect(state.updateSettings).toHaveBeenCalledTimes(2);
    const [last] = state.updateSettings.mock.lastCall as [
      { registeredMcpServers: Record<string, RegisteredMcpServerEntry | null> },
    ];
    expect(last.registeredMcpServers["notes"]).toMatchObject({
      enabled: false,
      toolName: "other",
      config: {},
    });
  });

  it("uses the secret control for secret list and number fields", async () => {
    const source = entry.source;
    if (source.kind !== "mcpb") throw new Error("unreachable");
    state.registeredMcpServers = [
      {
        ...entry,
        source: {
          ...source,
          manifest: {
            manifest_version: "0.2",
            name: "acme-notes",
            server: { mcp_config: { command: "node", args: [], env: {} } },
            user_config: {
              labels: { type: "string", title: "Labels", sensitive: true, multiple: true },
              quota: { type: "number", title: "Quota", sensitive: true },
            },
          },
        },
        config: { labels: "saved-label", quota: "42" },
      },
    ];
    state.updateSettings.mockReset();
    await using screen = await render(<McpServerSettingsPanel />);

    expect(screen.container.querySelectorAll('input[type="password"]')).toHaveLength(2);
    expect(screen.container.querySelector('input[type="number"]')).toBeNull();
    expect(screen.container.querySelector("textarea")).toBeNull();
    expect(screen.getByRole("button", { name: "Clear Labels" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Clear Quota" })).toBeDefined();
  });

  it("commits a number field on blur instead of every keystroke", async () => {
    await using screen = await setup();
    state.updateSettings.mockClear();

    const input = screen.getByRole("spinbutton", { name: "Retries" });
    await userEvent.fill(input, "12");
    expect(state.updateSettings).not.toHaveBeenCalled();

    await userEvent.tab();
    expect(state.updateSettings).toHaveBeenCalledTimes(1);
    expect(state.registeredMcpServers[0]?.config).toEqual({ retries: 12 });
  });
});
