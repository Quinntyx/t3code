import appCss from "../index.css?inline";
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import * as shelfHooks from "../state/olderSettledShelf";
import { createWorkspaceFocusController, workspaceAreaProps } from "../lib/workspaceFocus";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import {
  DEFAULT_CLIENT_SETTINGS,
  EnvironmentId,
  type LocalApi,
  ProjectId,
  ThreadId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { isMacPlatform } from "@t3tools/shared/keybindings";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { act, fakeTimers, render } from "../../test/render";
import { openCommandPalette } from "../commandPaletteBus";
import { makeThreadFixture } from "../test-fixtures";
import { useHandleNewThread } from "../hooks/useHandleNewThread";
import { useNowMinute } from "../hooks/useNowMinute";
import { __setClientSettingsForTests, getClientSettings } from "../hooks/useSettings";
import { useThreadRouteTarget } from "../hooks/useThreadRouteTarget";
import { useProjects, useServerConfigs, useQuietThreadShells } from "../state/entities";
import { useConnectedEnvironmentIds } from "../state/environments";
import { readEnvironmentScope, useEnvironmentScope } from "../state/session";
import { useOrchestrationCommand } from "../state/use-orchestration-command";
import { useTerminalUiStateStore } from "../terminalUiStateStore";
import { readLocalApi } from "../localApi";
import type { Project } from "../types";
import type { ReactNode } from "react";
import Sidebar from "./Sidebar";
import { THREAD_JUMP_HINT_SHOW_DELAY_MS } from "./Sidebar.logic";
import { SortableThreadRow } from "./sidebar/SidebarThreadRow";
import { SidebarProvider } from "./ui/sidebar";

vi.mock(import("../state/olderSettledShelf"), async (original) => {
  const actual = await original();
  return { ...actual, useOlderSettledShelf: vi.fn(actual.useOlderSettledShelf) };
});
vi.mock("../state/entities", { spy: true });
vi.mock("../hooks/useHandleNewThread", { spy: true });
vi.mock("../hooks/useNowMinute", { spy: true });
vi.mock("../hooks/useThreadRouteTarget", { spy: true });
vi.mock("./sidebar/SidebarThreadRow", { spy: true });
vi.mock("../state/session", { spy: true });
vi.mock("../state/environments", { spy: true });
vi.mock("../state/use-orchestration-command", { spy: true });
vi.mock("../localApi", { spy: true });
vi.mock(import("../state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const { compileResolvedKeybindingsConfig } = await import("@t3tools/shared/keybindings");
  // The desktop defaults: holding Mod alone already matches a thread jump.
  const keybindings = compileResolvedKeybindingsConfig([
    { key: "mod+1", command: "thread.jump.1" },
    { key: "mod+2", command: "thread.jump.2" },
  ]);
  return { ...(await original()), primaryServerKeybindingsAtom: Atom.make(keybindings) };
});
vi.mock("../commandPaletteBus", () => ({
  openCommandPalette: vi.fn(),
  isCommandPaletteOpen: () => false,
}));
vi.mock("./sidebar/SidebarChrome", () => ({
  SidebarChromeHeader: ({ actions }: { actions?: ReactNode }) => actions ?? null,
  SidebarChromeFooter: ({ settled }: { settled?: ReactNode }) => settled ?? null,
}));

const layoutOverrides = vi.hoisted(() => ({
  sidebarSearch: "row" as "row" | "hidden",
  sidebarSections: "shelves" as "shelves" | "tabs",
}));
/**
 * Sets the layout the mocked hook reports, back to stock on dispose with the remembered tab
 * forgotten; each layout test calls it first.
 */
function setupLayout(layout: Partial<typeof layoutOverrides> = {}) {
  layoutOverrides.sidebarSearch = layout.sidebarSearch ?? "row";
  layoutOverrides.sidebarSections = layout.sidebarSections ?? "shelves";
  return {
    [Symbol.dispose]: () => {
      layoutOverrides.sidebarSearch = "row";
      layoutOverrides.sidebarSections = "shelves";
      localStorage.removeItem("t3code:sidebar:tab");
    },
  };
}
vi.mock(import("../hooks/useTheme"), async (original) => {
  const { DEFAULT_RESOLVED_THEME_LAYOUT } = await import("../themeEffects");
  return {
    ...(await original()),
    useThemeLayout: () => ({ ...DEFAULT_RESOLVED_THEME_LAYOUT, ...layoutOverrides }),
  };
});

function project(id: string): Project {
  return {
    id: ProjectId.make(id),
    environmentId: EnvironmentId.make("local"),
    title: id,
    workspaceRoot: `/projects/${id}`,
    repositoryIdentity: null,
    defaultModelSelection: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    scripts: [],
  };
}

describe("sidebar header new thread", () => {
  it.each([
    { mode: "normal", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: false, picker: true },
    { mode: "boring", count: 2, shift: true, picker: false },
    { mode: "boring", count: 1, shift: false, picker: false },
  ] as const)("$mode sidebar, $count projects, shift=$shift: picker=$picker", async (scenario) => {
    using stack = new DisposableStack();
    const previousSettings = getClientSettings();
    stack.defer(() => __setClientSettingsForTests(previousSettings));
    __setClientSettingsForTests({
      ...DEFAULT_CLIENT_SETTINGS,
      boringSidebarEnabled: scenario.mode === "boring",
    });
    const projects = [project("active"), project("idle")].slice(0, scenario.count);
    const currentProjectRef = {
      environmentId: projects[0]!.environmentId,
      projectId: projects[0]!.id,
    };
    const startThread = vi.fn().mockResolvedValue(null);
    vi.mocked(useProjects).mockReturnValue(projects);
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: currentProjectRef,
      defaultProjectFallbackReady: true,
      handleNewThread: startThread,
      routeDraftId: null,
      routeThreadRef: null,
    });
    vi.mocked(openCommandPalette).mockClear();
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "New thread", exact: true }), {
      modifiers: scenario.shift ? ["Shift"] : [],
    });

    if (scenario.picker) {
      expect(openCommandPalette).toHaveBeenCalledExactlyOnceWith({ open: "new-thread-in" });
      expect(startThread).not.toHaveBeenCalled();
    } else {
      expect(openCommandPalette).not.toHaveBeenCalled();
      expect(startThread).toHaveBeenCalledExactlyOnceWith(currentProjectRef);
    }
  });
});

function threadShell(projectId: ProjectId, index: number): EnvironmentThreadShell {
  return makeThreadFixture({
    environmentId: EnvironmentId.make("local"),
    id: ThreadId.make(`thread-${index}`),
    projectId,
    title: `Thread ${index}`,
  });
}

async function renderTabsSidebar(
  threads: (project: Project) => EnvironmentThreadShell[],
  /** The open thread, revealed as if just navigated to. */
  revealThreadId?: string,
  /** A fixed sidebar height, for layout checks. */
  height?: number,
) {
  const currentProject = project("active");
  const threadRef = {
    environmentId: currentProject.environmentId,
    threadId: ThreadId.make(revealThreadId ?? "thread-0"),
  };
  const revealKey =
    revealThreadId === undefined ? null : `${currentProject.environmentId}:${revealThreadId}`;
  vi.mocked(useProjects).mockReturnValue([currentProject]);
  vi.mocked(useQuietThreadShells).mockReturnValue(threads(currentProject));
  vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef });
  vi.mocked(useServerConfigs).mockReturnValue(
    new Map([
      [
        currentProject.environmentId,
        {
          scratchWorkspaceRoot: null,
          shellThreadFamilies: false,
        } as unknown as EnvironmentServerConfig,
      ],
    ]),
  );
  vi.mocked(useHandleNewThread).mockReturnValue({
    activeDraftThread: null,
    activeThread: null,
    defaultProjectRef: {
      environmentId: currentProject.environmentId,
      projectId: currentProject.id,
    },
    defaultProjectFallbackReady: true,
    handleNewThread: vi.fn().mockResolvedValue(null),
    routeDraftId: null,
    routeThreadRef: threadRef,
  });
  vi.mocked(useOrchestrationCommand).mockReturnValue(
    vi.fn().mockResolvedValue({ _tag: "Success" }),
  );
  vi.mocked(readEnvironmentScope).mockReturnValue(true);
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  vi.mocked(useConnectedEnvironmentIds).mockReturnValue([currentProject.environmentId]);
  return render(
    <SidebarProvider {...(height === undefined ? {} : { style: { height, minHeight: height } })}>
      <Sidebar routeReveal={{ observedKey: null, pendingKey: revealKey }} />
    </SidebarProvider>,
  );
}
const settledThread = (currentProject: Project, index: number) =>
  makeThreadFixture({
    environmentId: currentProject.environmentId,
    projectId: currentProject.id,
    id: ThreadId.make(`settled-${index}`),
    title: `Settled thread ${index}`,
    settledOverride: "settled",
    settledAt: "2026-01-01T00:00:00.000Z",
  });

describe("sidebar render isolation", () => {
  // regression: #33100 Cmd+J re-rendered every sidebar row, which took hundreds of ms with many threads
  it("does not re-render thread rows when a quick Mod shortcut opens and focuses the terminal", async () => {
    using stack = new DisposableStack();
    const activeProject = project("active");
    const threads = Array.from({ length: 5 }, (_, index) => threadShell(activeProject.id, index));
    const routeThreadRef: ScopedThreadRef = {
      environmentId: activeProject.environmentId,
      threadId: threads[0]!.id,
    };
    threads.unshift(threadShell(activeProject.id, 100));
    // A real wall-clock minute tick mid-test re-renders every row and reads as a leak.
    vi.mocked(useNowMinute).mockReturnValue("2026-01-01T00:00");
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef: routeThreadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef,
    });
    const terminal = document.createElement("div");
    terminal.dataset.terminalOwner = "drawer";
    const terminalInput = document.createElement("textarea");
    terminal.append(terminalInput);
    document.body.append(terminal);
    stack.defer(() => terminal.remove());
    stack.defer(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, false));
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    await expect.element(screen.getByText("Thread 4").first()).toBeInTheDocument();
    const rowRenders = () => vi.mocked(SortableThreadRow).mock.calls.length;

    using _timers = fakeTimers();
    const modifier = isMacPlatform(navigator.platform) ? "Meta" : "Control";
    const beforeShortcut = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => useTerminalUiStateStore.getState().setTerminalOpen(routeThreadRef, true));
    await act(() => terminalInput.focus());
    await userEvent.keyboard(`{/${modifier}}`);
    await act(() => terminalInput.blur());
    expect(
      rowRenders() - beforeShortcut,
      "thread rows re-rendered while opening the terminal with a quick Mod shortcut",
    ).toBe(0);

    const jumpLabelsSince = (start: number) =>
      vi
        .mocked(SortableThreadRow)
        .mock.calls.slice(start)
        .map(([props]) => props.jumpLabel)
        .filter((label) => label !== null);
    const beforeHold = rowRenders();
    await userEvent.keyboard(`{${modifier}>}`);
    await act(() => vi.advanceTimersByTime(THREAD_JUMP_HINT_SHOW_DELAY_MS));
    expect(jumpLabelsSince(beforeHold), "holding Mod showed no jump hints").toHaveLength(2);
    const beforeRelease = rowRenders();
    await userEvent.keyboard(`{/${modifier}}`);
    expect(rowRenders()).toBeGreaterThan(beforeRelease);
    expect(jumpLabelsSince(beforeRelease)).toEqual([]);
  });
});

describe("sidebar thread rename", () => {
  // regression: #35151 an untouched rename wrote back the title it opened with over a newer one
  it.each(["{Enter}", "{Tab}"])(
    "ending an untouched rename with %s keeps a title that arrived while it was open",
    async (finish) => {
      const activeProject = project("active");
      const routeThreadRef: ScopedThreadRef = {
        environmentId: activeProject.environmentId,
        threadId: ThreadId.make("thread-0"),
      };
      const shellTitled = (title: string) => ({ ...threadShell(activeProject.id, 0), title });
      const updateMetadata = vi.fn().mockResolvedValue({ _tag: "Success" });
      vi.mocked(useOrchestrationCommand).mockReturnValue(updateMetadata);
      vi.mocked(readEnvironmentScope).mockReturnValue(true);
      vi.mocked(useEnvironmentScope).mockReturnValue(true);
      vi.mocked(useProjects).mockReturnValue([activeProject]);
      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Fix the login redirect")]);
      vi.mocked(useThreadRouteTarget).mockReturnValue({
        kind: "server",
        threadRef: routeThreadRef,
      });
      vi.mocked(useHandleNewThread).mockReturnValue({
        activeDraftThread: null,
        activeThread: null,
        defaultProjectRef: {
          environmentId: activeProject.environmentId,
          projectId: activeProject.id,
        },
        defaultProjectFallbackReady: true,
        handleNewThread: vi.fn().mockResolvedValue(null),
        routeDraftId: null,
        routeThreadRef,
      });
      const tree = () => (
        <SidebarProvider>
          <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
        </SidebarProvider>
      );
      await using screen = await render(tree());
      await userEvent.dblClick(screen.getByText("Fix the login redirect").first());
      const input = screen.getByRole("textbox", { name: "Thread title" });
      await expect.element(input).toHaveValue("Fix the login redirect");

      vi.mocked(useQuietThreadShells).mockReturnValue([shellTitled("Generated title")]);
      await screen.rerender(tree());
      await userEvent.keyboard(finish);

      await expect.element(input).not.toBeInTheDocument();
      expect(updateMetadata).not.toHaveBeenCalled();
    },
  );
});

describe("sidebar thread menu", () => {
  it("tells the menu whether the keyboard opened it", async () => {
    const activeProject = project("active");
    const thread = threadShell(activeProject.id, 0);
    const threadRef = { environmentId: activeProject.environmentId, threadId: thread.id };
    const show = vi.fn().mockResolvedValue(null);
    vi.mocked(readLocalApi).mockReturnValue({ contextMenu: { show } } as unknown as LocalApi);
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue([thread]);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: threadRef,
    });
    await using screen = await render(
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const row = screen.getByText("Thread 0").first();
    await expect.element(row).toBeInTheDocument();
    row.element().closest<HTMLElement>("[data-sidebar-row]")!.focus();
    await userEvent.keyboard("{Shift>}{F10}{/Shift}");
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(1));
    expect(show.mock.lastCall?.[2]).toBe("keyboard");
    await userEvent.click(row, { button: "right" });
    await vi.waitFor(() => expect(show).toHaveBeenCalledTimes(2));
    expect(show.mock.lastCall?.[2]).toBe("mouse");
  });
});

describe("sidebar settled pagination", () => {
  it("keeps the viewport in place when showing more settled threads", async () => {
    using stack = new DisposableStack();
    const style = document.createElement("style");
    style.textContent = appCss;
    document.head.append(style);
    stack.defer(() => style.remove());
    const focusController = createWorkspaceFocusController(document);
    stack.defer(() => focusController.dispose());
    let loading = false;
    const originalShelf = vi.mocked(shelfHooks.useOlderSettledShelf).getMockImplementation()!;
    using _shelf = vi.spyOn(shelfHooks, "useOlderSettledShelf").mockImplementation((input) => ({
      ...originalShelf(input),
      loading,
      retry: () => {
        loading = true;
      },
    }));
    const activeProject = project("active");
    const threads = Array.from({ length: 70 }, (_, index) =>
      makeThreadFixture({
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
        id: ThreadId.make(`settled-${index}`),
        title: `Settled thread ${index}`,
        settledOverride: "settled",
        settledAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    threads.unshift(threadShell(activeProject.id, 100));
    vi.mocked(useProjects).mockReturnValue([activeProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue(threads);
    vi.mocked(useThreadRouteTarget).mockReturnValue({
      kind: "server",
      threadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: activeProject.environmentId,
        projectId: activeProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: { environmentId: activeProject.environmentId, threadId: threads[0]!.id },
    });
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([
        [
          activeProject.environmentId,
          {
            scratchWorkspaceRoot: null,
            shellThreadFamilies: false,
          } as unknown as EnvironmentServerConfig,
        ],
      ]),
    );
    await using screen = await render(
      <SidebarProvider
        {...workspaceAreaProps("sidebar", 0, "Threads")}
        style={{ height: 400, minHeight: 400 }}
      >
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>,
    );
    const shelf = screen.container.querySelector<HTMLElement>(
      '[data-sidebar-row="shelf:settled"]',
    )!;
    if (shelf.getAttribute("aria-expanded") === "false") await act(() => shelf.click());
    const more = screen.getByRole("button", { name: "Show 25 more", exact: true });
    await expect.element(more).toBeInTheDocument();
    const moreButton = more.element() as HTMLButtonElement;
    const viewport = moreButton.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    viewport.style.height = "300px";
    viewport.style.maxHeight = "300px";
    moreButton.scrollIntoView({ block: "nearest" });
    const before = viewport.scrollTop;
    expect(before).toBeGreaterThan(0);
    moreButton.focus({ preventScroll: true });
    await act(() => moreButton.click());
    await expect
      .element(screen.getByRole("button", { name: "Loading", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(screen.getByRole("button", { name: "Loading", exact: true }))
      .toHaveFocus();
    expect(viewport.scrollTop).toBe(before);
    const loadedRows = screen.container.querySelectorAll("[data-thread-item]").length;
    await act(() => moreButton.click());
    expect(screen.container.querySelectorAll("[data-thread-item]")).toHaveLength(loadedRows);
  });
});

describe("sidebar search layout", () => {
  it("hides the search row and moves its buttons into the brand row only for the hidden variant", async () => {
    using _layout = setupLayout();
    const currentProject = project("active");
    const threadRef = {
      environmentId: currentProject.environmentId,
      threadId: ThreadId.make("thread-0"),
    };
    vi.mocked(useProjects).mockReturnValue([currentProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue([threadShell(currentProject.id, 0)]);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef });
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: currentProject.environmentId,
        projectId: currentProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: threadRef,
    });
    const tree = () => (
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>
    );

    layoutOverrides.sidebarSearch = "row";
    await using rowScreen = await render(tree());
    await expect
      .element(rowScreen.getByRole("combobox", { name: "Search threads" }))
      .toBeInTheDocument();
    await expect
      .element(rowScreen.getByRole("button", { name: "New thread", exact: true }))
      .toBeInTheDocument();

    await userEvent.fill(rowScreen.getByRole("combobox", { name: "Search threads" }), "no match");
    await expect.element(rowScreen.getByText("Thread 0")).not.toBeInTheDocument();

    // Hiding the row takes its query with it: nothing could show or clear it.
    layoutOverrides.sidebarSearch = "hidden";
    await rowScreen.rerender(tree());
    expect(
      rowScreen.container.querySelector('[role="combobox"][aria-label="Search threads"]'),
    ).toBeNull();
    await expect.element(rowScreen.getByText("Thread 0")).toBeInTheDocument();
    await expect
      .element(rowScreen.getByRole("button", { name: "New thread", exact: true }))
      .toBeInTheDocument();
    await expect
      .element(rowScreen.getByRole("button", { name: "Add project", exact: true }))
      .toBeInTheDocument();
  });
});

describe("sidebar sections layout", () => {
  it("shows shelves by default and switchable tabs when the layout is tabs", async () => {
    using _layout = setupLayout();
    const currentProject = project("active");
    const settled = makeThreadFixture({
      environmentId: currentProject.environmentId,
      projectId: currentProject.id,
      id: ThreadId.make("settled-0"),
      title: "Settled 0",
      settledOverride: "settled",
      settledAt: "2026-01-01T00:00:00.000Z",
    });
    const threadRef = {
      environmentId: currentProject.environmentId,
      threadId: ThreadId.make("thread-0"),
    };
    vi.mocked(useProjects).mockReturnValue([currentProject]);
    vi.mocked(useQuietThreadShells).mockReturnValue([settled]);
    vi.mocked(useThreadRouteTarget).mockReturnValue({ kind: "server", threadRef });
    vi.mocked(useServerConfigs).mockReturnValue(
      new Map([
        [
          currentProject.environmentId,
          {
            scratchWorkspaceRoot: null,
            shellThreadFamilies: false,
          } as unknown as EnvironmentServerConfig,
        ],
      ]),
    );
    vi.mocked(useHandleNewThread).mockReturnValue({
      activeDraftThread: null,
      activeThread: null,
      defaultProjectRef: {
        environmentId: currentProject.environmentId,
        projectId: currentProject.id,
      },
      defaultProjectFallbackReady: true,
      handleNewThread: vi.fn().mockResolvedValue(null),
      routeDraftId: null,
      routeThreadRef: threadRef,
    });
    const tree = () => (
      <SidebarProvider>
        <Sidebar routeReveal={{ observedKey: null, pendingKey: null }} />
      </SidebarProvider>
    );

    layoutOverrides.sidebarSections = "shelves";
    await using shelvesScreen = await render(tree());
    expect(
      shelvesScreen.container.querySelector('[data-testid="sidebar-settled-shelf-toggle"]'),
    ).not.toBeNull();
    expect(shelvesScreen.container.querySelector('[role="tablist"]')).toBeNull();

    layoutOverrides.sidebarSections = "tabs";
    await using tabsScreen = await render(tree());
    expect(
      tabsScreen.container.querySelector('[data-testid="sidebar-settled-shelf-toggle"]'),
    ).toBeNull();
    await expect
      .element(tabsScreen.getByRole("tablist", { name: "Thread lists" }))
      .toBeInTheDocument();
    const workingTab = tabsScreen.getByRole("tab", { name: /Working/ });
    await expect.element(workingTab).toHaveAttribute("aria-selected", "false");
    await userEvent.click(workingTab);
    await expect.element(workingTab).toHaveAttribute("aria-selected", "true");
    expect(tabsScreen.container.querySelector('[data-sidebar-column="working"]')).not.toBeNull();
    await userEvent.keyboard("{ArrowRight}");
    await expect
      .element(tabsScreen.getByRole("tab", { name: /Snoozed/ }))
      .toHaveAttribute("aria-selected", "true");
  });
});

describe("sidebar tabs", () => {
  it("brings the open thread's tab forward when it is revealed", async () => {
    using _layout = setupLayout({ sidebarSections: "tabs" });
    await using screen = await renderTabsSidebar(
      (currentProject) => [
        makeThreadFixture({
          environmentId: currentProject.environmentId,
          projectId: currentProject.id,
          id: ThreadId.make("snoozed-0"),
          title: "Snoozed thread 0",
          snoozedAt: "2026-01-01T00:00:00.000Z",
          snoozedUntil: "2099-01-01T00:00:00.000Z",
        }),
      ],
      "snoozed-0",
    );
    await expect
      .element(screen.getByRole("tab", { name: /Snoozed/ }))
      .toHaveAttribute("aria-selected", "true");
  });

  it("has no Working tab when the Working shelf is off", async () => {
    using _layout = setupLayout({ sidebarSections: "tabs" });
    const previousSettings = getClientSettings();
    using _settings = { [Symbol.dispose]: () => __setClientSettingsForTests(previousSettings) };
    __setClientSettingsForTests({ ...previousSettings, sidebarWorkingShelfEnabled: false });
    await using screen = await renderTabsSidebar((currentProject) => [
      settledThread(currentProject, 0),
    ]);
    await expect.element(screen.getByRole("tab", { name: /Snoozed/ })).toBeInTheDocument();
    expect(
      screen
        .getByRole("tab")
        .elements()
        .map((tab) => tab.textContent),
    ).toEqual(["Idle", "Snoozed0"]);
  });

  it("scrolls each tab column on its own", async () => {
    using _layout = setupLayout({ sidebarSections: "tabs" });
    using stack = new DisposableStack();
    const style = document.head.appendChild(document.createElement("style"));
    style.textContent = appCss;
    stack.defer(() => style.remove());
    await using screen = await renderTabsSidebar(
      (currentProject) =>
        Array.from({ length: 40 }, (_, index) => threadShell(currentProject.id, index)),
      undefined,
      400,
    );
    await expect.element(screen.getByText("Thread 0", { exact: true })).toBeVisible();
    const column = screen.container.querySelector<HTMLElement>('[data-sidebar-column="idle"]')!;
    const viewport = column.closest<HTMLElement>('[data-slot="scroll-area-viewport"]')!;
    // The column overflows and scrolls; the sidebar's own viewport has nothing to scroll.
    expect(column.scrollHeight).toBeGreaterThan(column.clientHeight);
    expect(viewport.scrollHeight).toBe(viewport.clientHeight);
  });

  it("leaves the tabs to the user while a settled thread is open", async () => {
    using _layout = setupLayout({ sidebarSections: "tabs" });
    await using screen = await renderTabsSidebar(
      (currentProject) => [settledThread(currentProject, 0)],
      "settled-0",
    );
    const working = screen.getByRole("tab", { name: /Working/ });
    await userEvent.click(working);
    await expect.element(working).toHaveAttribute("aria-selected", "true");
  });

  it("lists settled threads with un-settle and view actions when sections are tabs", async () => {
    using _layout = setupLayout({ sidebarSections: "tabs" });
    // Left open in the shelves layout; tabs page settled threads only in the popover.
    localStorage.setItem("t3code:sidebar:settled-expanded", "true");
    using _shelf = {
      [Symbol.dispose]: () => localStorage.removeItem("t3code:sidebar:settled-expanded"),
    };
    await using screen = await renderTabsSidebar((currentProject) =>
      Array.from({ length: 12 }, (_, index) => settledThread(currentProject, index)),
    );
    const button = screen.getByRole("button", { name: "Recently settled" });
    await expect.element(button).toBeInTheDocument();
    await userEvent.click(button);
    await expect.element(page.getByText("Settled thread 0", { exact: true })).toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: /^Un-settle Settled thread 0,/ }))
      .toBeInTheDocument();
    await expect
      .element(page.getByRole("button", { name: /Open Settled thread 0 without un-settling/ }))
      .toBeInTheDocument();
    // The popover pages like the Settled shelf: its first page, then the rest.
    await expect.element(page.getByRole("button", { name: /^Un-settle / }).nth(9)).toBeVisible();
    expect(page.getByRole("button", { name: /^Un-settle / }).elements()).toHaveLength(10);
    expect(screen.container.querySelector('[data-sidebar-row="settled:more"]')).toBeNull();
    await userEvent.click(page.getByRole("button", { name: "Show 2 more" }));
    await expect.element(page.getByRole("button", { name: /^Un-settle / }).nth(11)).toBeVisible();
  });

  it("takes an Idle row dragged onto the Recently settled button", async () => {
    using _layout = setupLayout({ sidebarSections: "tabs" });
    await using screen = await renderTabsSidebar((currentProject) => [
      settledThread(currentProject, 0),
      makeThreadFixture({
        environmentId: currentProject.environmentId,
        projectId: currentProject.id,
        id: ThreadId.make("idle-0"),
        title: "Idle thread 0",
      }),
    ]);
    const row = screen.getByText("Idle thread 0");
    const button = screen.getByRole("button", { name: "Recently settled" });
    await expect.element(row).toBeVisible();
    await expect.element(button).toBeVisible();
    const from = row.element().getBoundingClientRect();
    const to = button.element().getBoundingClientRect();
    const pointer = (type: string, x: number, y: number) =>
      new PointerEvent(type, {
        bubbles: true,
        cancelable: true,
        pointerId: 1,
        isPrimary: true,
        button: 0,
        buttons: 1,
        clientX: x,
        clientY: y,
      });
    using _release = {
      [Symbol.dispose]: () =>
        document.dispatchEvent(new KeyboardEvent("keydown", { code: "Escape", bubbles: true })),
    };
    await act(() => {
      row.element().dispatchEvent(pointer("pointerdown", from.x + 10, from.y + 5));
      document.dispatchEvent(pointer("pointermove", from.x + 10, from.y + 30));
    });
    await act(() =>
      document.dispatchEvent(pointer("pointermove", to.x + to.width / 2, to.y + to.height / 2)),
    );
    await expect.element(button).toHaveAttribute("data-drop-target", "");
  });
});
