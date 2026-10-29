import { type ConfirmDialogOptions, type ContextMenuItem } from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const showContextMenuFallbackMock =
  vi.fn<
    <T extends string>(
      items: readonly ContextMenuItem<T>[],
      position?: { x: number; y: number },
    ) => Promise<T | null>
  >();
const dismissContextMenuMock = vi.fn<() => void>();

const requestConfirmDialogMock =
  vi.fn<(message: string, options?: ConfirmDialogOptions) => Promise<boolean> | undefined>();

vi.mock("./contextMenuFallback", () => ({
  showContextMenuFallback: showContextMenuFallbackMock,
  dismissContextMenu: dismissContextMenuMock,
}));

vi.mock("./confirmDialog", () => ({
  requestConfirmDialog: requestConfirmDialogMock,
}));

function createLocalStorageStub(): Storage {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => {
      values.set(key, value);
    },
    removeItem: (key) => {
      values.delete(key);
    },
    clear: () => values.clear(),
    key: (index) => [...values.keys()][index] ?? null,
    get length() {
      return values.size;
    },
  };
}

function testWindow(): Window & typeof globalThis {
  return globalThis.window ?? (globalThis as unknown as Window & typeof globalThis);
}

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  if (globalThis.window === undefined) {
    Object.defineProperty(globalThis, "window", {
      configurable: true,
      value: globalThis,
    });
  }
  Reflect.deleteProperty(testWindow(), "desktopBridge");
  Object.defineProperty(testWindow(), "localStorage", {
    configurable: true,
    value: createLocalStorageStub(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("LocalApi", () => {
  it("fails closed in a browser when no themed host is available", async () => {
    requestConfirmDialogMock.mockReturnValue(undefined);
    const { createLocalApi } = await import("./localApi");

    await expect(createLocalApi().dialogs.confirm("Delete this thread?")).resolves.toBe(false);
  });

  it.each([
    ["darwin", true],
    ["linux", false],
    ["win32", false],
  ] as const)("on %s desktop, uses the native context menu: %s", async (platform, native) => {
    const showContextMenu = vi.fn(async () => "native");
    Object.defineProperty(testWindow(), "desktopBridge", {
      configurable: true,
      value: { getClientPlatform: () => platform, showContextMenu },
    });
    showContextMenuFallbackMock.mockResolvedValue("fallback");
    const { createLocalApi } = await import("./localApi");
    const api = createLocalApi();

    await expect(api.contextMenu.show([{ id: "rename", label: "Rename" }])).resolves.toBe(
      native ? "native" : "fallback",
    );
    await api.contextMenu.close();
    expect(showContextMenu).toHaveBeenCalledTimes(native ? 1 : 0);
    expect(dismissContextMenuMock).toHaveBeenCalledTimes(native ? 0 : 1);
  });
});
