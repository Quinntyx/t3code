import type {
  ModelSelection,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { repositoryGroupingKeyOf } from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { fileBasename } from "@t3tools/shared/path";

import type { EnvironmentProject, ThreadStructure } from "./state/models.ts";

type MachineHandoffProject = Pick<
  EnvironmentProject,
  "environmentId" | "workspaceRoot" | "repositoryIdentity"
>;

function machineHandoffProjectSubdirectory(
  project: Pick<MachineHandoffProject, "workspaceRoot" | "repositoryIdentity">,
): string | null {
  return sourceProjectSubdirectory(project.repositoryIdentity?.rootPath, project.workspaceRoot);
}

export function matchingMachineHandoffProjects<T extends MachineHandoffProject>(
  source: MachineHandoffProject,
  projects: ReadonlyArray<T>,
): ReadonlyArray<T> {
  const identity = source.repositoryIdentity;
  const subdirectory = machineHandoffProjectSubdirectory(source);
  if (!identity || subdirectory === null) return [];
  return projects.filter(
    (project) =>
      project.environmentId !== source.environmentId &&
      project.repositoryIdentity &&
      repositoryGroupingKeyOf(project.repositoryIdentity) === repositoryGroupingKeyOf(identity) &&
      machineHandoffProjectSubdirectory(project) === subdirectory,
  );
}

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

export type HandoffTimelineRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "providerInstanceId" | "modelSelection"
>;

export type HandoffEndpoints = ReturnType<typeof resolveHandoffEndpoints>;

export function resolvePendingHandoff(
  projection: ThreadStructure | null | undefined,
  selection: ModelSelection | null | undefined,
  providers: ReadonlyArray<ServerProvider>,
): HandoffEndpoints | null {
  // A thread with an empty timeline has nothing to hand off. Any loaded row
  // counts: paging can leave a window of only tool rows.
  if (!projection?.visibleTurnItems.length) return null;
  // The handoff row is committed before the provider starts. Use its destination
  // during startup so the footer does not duplicate the committed handoff.
  const from = projection.runs.findLast(
    (run) =>
      run.status !== "rolled_back" &&
      (run.startedAt !== null || (run.status === "starting" && run.contextHandoffId !== null)),
  )?.modelSelection;
  if (from === undefined || selection == null) return null;
  const source = providers.find((provider) => provider.instanceId === from.instanceId);
  const target = providers.find((provider) => provider.instanceId === selection.instanceId);
  const needsHandoff =
    from.instanceId !== selection.instanceId &&
    (source?.continuation?.groupKey === undefined ||
      source.driver !== target?.driver ||
      source.continuation.groupKey !== target.continuation?.groupKey);
  return needsHandoff ? { from: [from], to: selection } : null;
}

export function resolveHandoffEndpoints(
  item: Pick<
    Extract<OrchestrationV2TurnItem, { type: "handoff" }>,
    "runId" | "fromModelSelections" | "fromProviderInstanceIds" | "toModel" | "toProviderInstanceId"
  >,
  runs: ReadonlyArray<HandoffTimelineRun>,
) {
  const handoffRun = item.runId === null ? undefined : runs.find((run) => run.id === item.runId);
  const toModel =
    item.toModel ??
    (handoffRun !== undefined && handoffRun.providerInstanceId === item.toProviderInstanceId
      ? handoffRun.modelSelection.model
      : undefined);
  const fromEndpoints: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly model?: string | undefined;
  }> =
    item.fromModelSelections !== undefined && item.fromModelSelections.length > 0
      ? item.fromModelSelections
      : item.fromProviderInstanceIds.map((instanceId) => ({
          instanceId,
          model: latestRunModelBefore(runs, instanceId, handoffRun?.ordinal),
        }));
  return { from: fromEndpoints, to: { instanceId: item.toProviderInstanceId, model: toModel } };
}

function latestRunModelBefore(
  runs: ReadonlyArray<HandoffTimelineRun>,
  instanceId: ProviderInstanceId,
  beforeOrdinal: number | undefined,
): string | undefined {
  let latest: HandoffTimelineRun | undefined;
  for (const run of runs) {
    if (run.providerInstanceId !== instanceId) continue;
    if (beforeOrdinal !== undefined && run.ordinal >= beforeOrdinal) continue;
    if (latest === undefined || run.ordinal > latest.ordinal) latest = run;
  }
  return latest?.modelSelection.model;
}

export function isHandoffFile(path: string): boolean {
  return fileBasename(path).toLowerCase() === "handoff.md";
}

/** The trailing space lets the composer render the link as a file chip. */
export function handoffFilePrompt(path: string): string {
  return `Continue from ${serializeComposerFileLink(path)} `;
}
