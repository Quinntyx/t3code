export function machineHandoffBlocker(input: {
  readonly sourceAvailable: boolean;
  readonly sourceStatus: string | undefined;
  readonly sourceConnected: boolean;
  readonly targetConnected: boolean;
  readonly sourceSupported: boolean;
  readonly targetSupported: boolean;
  readonly canExport: boolean;
  readonly canImport: boolean;
  readonly projectSelected: boolean;
  readonly modelReady: boolean;
}): string | null {
  if (!input.sourceAvailable) return "The source thread or project is no longer available.";
  if (
    ["preparing", "queued", "starting", "running", "waiting"].includes(input.sourceStatus ?? "")
  ) {
    return "Stop the current turn before handing off this thread.";
  }
  if (!input.sourceConnected || !input.targetConnected) return "Both machines must be connected.";
  if (!input.sourceSupported || !input.targetSupported)
    return "Both machines must support machine handoffs. Update the server if needed.";
  if (!input.canExport || !input.canImport)
    return "Permission to transfer threads and working files is required on both machines.";
  if (!input.projectSelected)
    return "Choose the destination project, or clone the repository first.";
  if (!input.modelReady)
    return "Choose an available provider and model on the destination machine.";
  return null;
}

export async function relayMachineHandoff<Snapshot, Result>(input: {
  readonly eligibility: () => string | null;
  readonly exportSnapshot: () => Promise<Snapshot>;
  readonly importSnapshot: (snapshot: Snapshot) => Promise<Result>;
}): Promise<Result> {
  const before = input.eligibility();
  if (before) throw new Error(before);
  const snapshot = await input.exportSnapshot();
  const after = input.eligibility();
  if (after) throw new Error(after);
  return input.importSnapshot(snapshot);
}

export function sourceProjectSubdirectory(
  rootPath: string | undefined,
  workspaceRoot: string,
): string | null {
  if (!rootPath) return null;
  const root = rootPath.replaceAll("\\", "/").replace(/\/+$/, "");
  const workspace = workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "");
  const relative =
    workspace === root
      ? ""
      : workspace.startsWith(`${root}/`)
        ? workspace.slice(root.length + 1)
        : null;
  return relative?.split("/").some((segment) => segment === ".." || segment === ".")
    ? null
    : relative;
}
