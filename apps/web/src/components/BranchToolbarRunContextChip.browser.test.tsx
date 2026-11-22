import { EnvironmentId, ProjectId, type EnvironmentMachineKind } from "@t3tools/contracts";
import { useState } from "react";
import { expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import type { EnvironmentOption } from "./BranchToolbar.logic";
import { BranchToolbarRunContextChip } from "./BranchToolbarRunContextChip";

const moveTarget: EnvironmentOption = {
  environmentId: EnvironmentId.make("devbox"),
  projectId: ProjectId.make("project"),
  label: "devbox",
  isPrimary: false,
  machine: "local" as EnvironmentMachineKind,
};

function props() {
  return {
    machine: {
      kind: "server" as EnvironmentMachineKind,
      label: "studio",
      connection: "studio.local:3773",
    },
    workspace: { kind: "worktree" as const, label: "Worktree", path: "/work/t3-4f2a91c0" },
    branchName: "t3/blur-fix",
    branchDetail: "2 ahead · 1 behind",
    prSummary: "#27513: Fix blur",
    showGitControls: true,
    canMove: true,
    moveBusy: false,
    moveDisabled: false,
    moveTargets: [moveTarget],
    addTargets: [],
    onMoveTo: () => {},
    onAddToMachine: () => {},
    onCopyWorkspacePath: () => {},
    open: false,
    view: "info" as const,
    onOpenChange: () => {},
    onViewChange: () => {},
    branchPicker: <div>branch picker</div>,
    ariaLabel: "Run context: studio, Worktree, t3/blur-fix",
    tooltip: "studio · Worktree · t3/blur-fix",
    onContextMenu: () => {},
  };
}

function Chip() {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<"info" | "move" | "branch">("info");
  return (
    <BranchToolbarRunContextChip
      {...props()}
      open={open}
      onOpenChange={setOpen}
      view={view}
      onViewChange={setView}
    />
  );
}

it("shows each run-context fact with its action in the chip popover", async () => {
  await using _screen = await render(<Chip />);

  const chip = page.getByRole("button", { name: /Run context/ });
  await expect.element(chip).toBeVisible();
  await userEvent.click(chip);

  await expect.element(page.getByRole("group", { name: "Machine" })).toBeVisible();
  await expect.element(page.getByRole("group", { name: "Workspace" })).toBeVisible();
  await expect.element(page.getByRole("group", { name: "Branch" })).toBeVisible();
  await expect.element(page.getByText("2 ahead · 1 behind")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Move…" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Copy full path" })).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Switch…" })).toBeVisible();
});
