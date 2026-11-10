import type {
  ModelSelection,
  OrchestrationV2ModelSwitch,
  OrchestrationV2Run,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ProjectCloneSnapshot,
  ServerProvider,
  ServerProviderModel,
} from "@t3tools/contracts";
import { repositoryGroupingKeyOf } from "@t3tools/contracts";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import {
  getModelSelectionStringOptionValue,
  getProviderOptionCurrentValue,
} from "@t3tools/shared/model";
import { fileBasename } from "@t3tools/shared/path";

import { isReasoningSelect } from "./modelTraits.ts";
import type { EnvironmentProject, ThreadStructure } from "./state/models.ts";
import { REASONING_EFFORT_OPTION_IDS } from "./state/threadExecution.ts";

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

export function machineHandoffCloneReady(
  clone: Pick<ProjectCloneSnapshot, "phase"> | "pending" | null,
  hasRepositoryIdentity: boolean,
): boolean {
  return (
    clone !== "pending" && (clone?.phase === "done" || (clone === null && hasRepositoryIdentity))
  );
}

export async function relayMachineHandoff<Snapshot, Result>(input: {
  readonly eligibility: () => string | null;
  readonly exportSnapshot: () => Promise<Snapshot>;
  readonly importSnapshot: (snapshot: Snapshot) => Promise<Result>;
  readonly attempt?: { current: (() => Promise<Result>) | null };
}): Promise<Result> {
  const before = input.eligibility();
  if (before) throw new Error(before);
  let importSnapshot = input.attempt?.current;
  if (!importSnapshot) {
    const snapshot = await input.exportSnapshot();
    importSnapshot = () => input.importSnapshot(snapshot);
    if (input.attempt) input.attempt.current = importSnapshot;
  }
  const after = input.eligibility();
  if (after) throw new Error(after);
  return importSnapshot();
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
  projection:
    | (Pick<ThreadStructure, "runs" | "visibleTurnItems"> & {
        readonly thread?: Pick<ThreadStructure["thread"], "historyOrigin">;
      })
    | null
    | undefined,
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
  if (selection == null) return null;
  if (from === undefined) {
    return projection.thread?.historyOrigin === "machine_handoff"
      ? { from: [], to: selection }
      : null;
  }
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

export interface ModelSwitchChange {
  readonly modelChanged: boolean;
  /** Effort labels, set only when the effort changed. */
  readonly effort: { readonly from: string; readonly to: string } | null;
}

/**
 * What a recorded model switch visibly changed, or null when it changed neither the model nor the
 * effort. The composer omits an untouched effort, so an unset effort reads as the model's default.
 */
export function resolveModelSwitchChange(
  { from, to }: OrchestrationV2ModelSwitch,
  providers: ReadonlyArray<ServerProvider>,
): ModelSwitchChange | null {
  const modelsOf = (selection: ModelSelection) =>
    providers.find((provider) => provider.instanceId === selection.instanceId)?.models;
  const fromEffort = resolveEffort(from, modelsOf(from));
  const toEffort = resolveEffort(to, modelsOf(to));
  const modelChanged = from.model !== to.model;
  const effort =
    fromEffort && toEffort && fromEffort.value !== toEffort.value
      ? { from: fromEffort.label, to: toEffort.label }
      : null;
  return modelChanged || effort ? { modelChanged, effort } : null;
}

/** The composer's reasoning control for the model; stated values only when the catalog lacks it. */
function resolveEffort(
  selection: ModelSelection,
  models: ReadonlyArray<ServerProviderModel> | undefined,
): { readonly value: string; readonly label: string } | undefined {
  const model = models?.find((candidate) => candidate.slug === selection.model);
  if (model === undefined) {
    // Pi states its effort as `thinking`; the catalog would otherwise mark it a reasoning control.
    const value = [...REASONING_EFFORT_OPTION_IDS, "thinking"]
      .map((id) => getModelSelectionStringOptionValue(selection, id))
      .find((candidate) => candidate !== undefined);
    return value === undefined ? undefined : { value, label: value };
  }
  const descriptor = model.capabilities?.optionDescriptors?.find(isReasoningSelect);
  if (descriptor === undefined) return undefined;
  const value =
    getModelSelectionStringOptionValue(selection, descriptor.id) ??
    getProviderOptionCurrentValue(descriptor, selection);
  if (typeof value !== "string") return undefined;
  return { value, label: descriptor.options.find((option) => option.id === value)?.label ?? value };
}
