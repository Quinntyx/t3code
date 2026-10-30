import "../index.css";
import { useState, type ComponentType } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";
import { act, render } from "../../test/render";
import { RightPanelFrame } from "./RightPanelFrame";
import { PreviewPanelShell } from "./preview/PreviewPanelShell";

function Harness({
  Frame,
  storageKey,
}: {
  Frame: ComponentType<Parameters<typeof RightPanelFrame>[0]>;
  storageKey: string;
}) {
  const [open, setOpen] = useState(true);
  const [maximized, setMaximized] = useState(false);
  return (
    <div className="flex h-80 w-full">
      <div>
        <button data-right-panel-toggle onClick={() => setOpen(!open)}>
          Toggle panel
        </button>
        <button onClick={() => setMaximized(!maximized)}>Maximize</button>
      </div>
      <Frame
        mode="inline"
        open={open}
        maximized={maximized}
        widthStorageKey={storageKey}
        defaultWidth={400}
      >
        <button onClick={() => setOpen(false)}>Close inside</button>
      </Frame>
    </div>
  );
}

describe("shared right panel frame", () => {
  it.each([
    ["project", RightPanelFrame],
    ["existing-thread", PreviewPanelShell],
  ] as const)("retains resize, maximize and close focus for %s", async (name, Frame) => {
    await page.viewport(1280, 800);
    const storageKey = `deus-step08-frame-${name}`;
    localStorage.removeItem(storageKey);
    await using screen = await render(<Harness Frame={Frame} storageKey={storageKey} />);
    const separator = screen.container.querySelector<HTMLElement>('[role="separator"]')!;
    const pointer = { bubbles: true, cancelable: true, pointerId: 1, button: 0, clientY: 40 };
    await act(() => {
      separator.dispatchEvent(new PointerEvent("pointerdown", { ...pointer, clientX: 500 }));
      separator.dispatchEvent(new PointerEvent("pointermove", { ...pointer, clientX: 440 }));
      separator.dispatchEvent(new PointerEvent("pointerup", { ...pointer, clientX: 440 }));
    });
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toBe(460);
    await userEvent.click(screen.getByRole("button", { name: "Close inside" }));
    const host = screen.container.querySelector<HTMLElement>('[data-preview-panel-mode="inline"]')!;
    await vi.waitFor(() => expect(host.inert).toBe(true));
    await vi.waitFor(() =>
      expect(document.activeElement).toBe(
        screen.container.querySelector("[data-right-panel-toggle]"),
      ),
    );
    await userEvent.click(screen.getByRole("button", { name: "Toggle panel" }));
    await expect.element(screen.getByRole("button", { name: "Close inside" })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Maximize", exact: true }));
    await expect.element(screen.getByRole("separator")).not.toBeInTheDocument();
    expect(host.dataset.previewPanelMaximized).toBe("true");
    localStorage.removeItem(storageKey);
  });
});
