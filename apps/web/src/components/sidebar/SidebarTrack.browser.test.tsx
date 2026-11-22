import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { SIDEBAR_TABS } from "./SidebarTabs";
import { SidebarTrack } from "./SidebarTrack";

const columns = { idle: "Idle list", working: "Working list", snoozed: "Snoozed list" };

it("unmounts the previous column at once when reduced motion drops the slide", async () => {
  using themed = new DisposableStack();
  const sheet = document.head.appendChild(document.createElement("style"));
  themed.defer(() => sheet.remove());
  // What motion-reduce leaves: a duration with no transitioned property, so no transitionend.
  sheet.textContent =
    ":has(> [data-sidebar-column]) { transition: transform 320ms; transition-property: none; }";
  await using screen = await render(
    <SidebarTrack tabs={SIDEBAR_TABS} active="idle" columns={columns} />,
  );
  await screen.rerender(<SidebarTrack tabs={SIDEBAR_TABS} active="working" columns={columns} />);
  await expect.element(screen.getByText("Working list")).toBeInTheDocument();
  await expect.element(screen.getByText("Idle list")).not.toBeInTheDocument();
});
