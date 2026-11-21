import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { FloatingPanelControls } from "./PanelLayoutControls";

import "~/index.css";

function MovingPanelControls() {
  const [rightPanelOpen, setRightPanelOpen] = useState(true);
  return (
    <>
      <button type="button">Outside controls</button>
      <div className={rightPanelOpen ? "relative h-80 w-80" : "relative h-80 w-160"}>
        <FloatingPanelControls
          maximize={null}
          terminalAvailable
          terminalOpen={false}
          terminalShortcutLabel={null}
          threadPanelOpen={false}
          threadPanelPresentation="inline"
          threadPanelShortcutLabel={null}
          rightPanelAvailable
          rightPanelOpen={rightPanelOpen}
          rightPanelShortcutLabel={null}
          onToggleTerminal={() => {}}
          onToggleThreadPanel={() => {}}
          onToggleRightPanel={() => setRightPanelOpen((open) => !open)}
        />
      </div>
    </>
  );
}

it("folds after a pointer toggle moves away, but stays expanded for keyboard focus", async () => {
  await using screen = await render(<MovingPanelControls />);
  const bubble = screen.container.querySelector("[data-floating-panel-controls]") as HTMLElement;
  const drawer = bubble.querySelector(".grid") as HTMLElement;
  const rightPanel = screen.getByRole("button", { name: "Toggle right panel" });

  expect(drawer.getBoundingClientRect().height).toBe(0);
  await userEvent.hover(page.elementLocator(bubble));
  await vi.waitFor(() => expect(drawer.getBoundingClientRect().height).toBeGreaterThan(0));
  await userEvent.click(rightPanel);

  await expect.element(rightPanel).toHaveAttribute("aria-pressed", "false");
  await expect.element(rightPanel).toHaveFocus();
  await vi.waitFor(() => expect(bubble.matches(":hover")).toBe(false));
  await vi.waitFor(() => expect(drawer.getBoundingClientRect().height).toBe(0));

  await userEvent.tab({ shift: true });
  await expect
    .element(screen.getByRole("button", { name: "Toggle terminal drawer" }))
    .toHaveFocus();
  await vi.waitFor(() => expect(drawer.getBoundingClientRect().height).toBeGreaterThan(0));

  await userEvent.tab({ shift: true });
  await expect
    .element(screen.getByRole("button", { name: "Toggle thread details panel" }))
    .toHaveFocus();
  await userEvent.tab({ shift: true });
  await expect.element(screen.getByRole("button", { name: "Outside controls" })).toHaveFocus();
  await vi.waitFor(() => expect(drawer.getBoundingClientRect().height).toBe(0));
});
