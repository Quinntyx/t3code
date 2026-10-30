import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  matchingMachineHandoffProjects,
  machineHandoffBlocker,
  relayMachineHandoff,
} from "@t3tools/client-runtime/handoff";
import { canCreateProjectInEnvironment } from "@t3tools/client-runtime/operations/projects";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  resolveEnvironmentMachineKind,
  type EnvironmentId,
  type ModelSelection,
} from "@t3tools/contracts";
import { useRef, useState } from "react";

import { useAddProjectTargets } from "../hooks/useAddProjectTargets";
import { newThreadId, randomUUID } from "../lib/utils";
import { providerInstanceEntriesFor, isProviderInstancePickerReady } from "../providerInstances";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useProject, useProjects, useServerConfigs, useThreadShell } from "../state/entities";
import { useEnvironments, useEnvironmentProviders } from "../state/environments";
import { environmentPresentations } from "../state/presentation";
import { environmentProjects } from "../state/projects";
import { serverEnvironment } from "../state/server";
import { environmentThreadShells, threadEnvironment } from "../state/threads";
import { buildThreadRouteParams } from "../threadRoutes";
import { openAddProjectToMachine } from "./AddProjectToMachineDialog";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { ProviderModelPicker } from "./chat/ProviderModelPicker";
import { HandoffRow } from "./chat/V2LifecycleRow";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Label } from "./ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "./ui/select";

import {
  closeMachineHandoff as close,
  openMachineHandoff,
  useMachineHandoffRequest as useRequest,
  type MachineHandoffRequest,
} from "./machineHandoffRequest";

export function MachineHandoffDialogHost() {
  const request = useRequest((state) => state.request);
  const session = useRequest((state) => state.session);
  return request ? <MachineHandoffDialog key={session} request={request} /> : null;
}

function MachineHandoffDialog({ request }: { request: MachineHandoffRequest }) {
  const navigate = useNavigate();
  const thread = useThreadShell(request.threadRef);
  const sourceRef = thread
    ? { environmentId: request.threadRef.environmentId, projectId: thread.projectId }
    : null;
  const sourceProject = useProject(sourceRef);
  const projects = useProjects();
  const { environments } = useEnvironments();
  const providersByEnvironment = useEnvironmentProviders();
  const configs = useServerConfigs();
  const matching = sourceProject ? matchingMachineHandoffProjects(sourceProject, projects) : [];
  const candidates = matching.map((project) => ({ environmentId: project.environmentId }));
  const cloneTargets = useAddProjectTargets(sourceProject, candidates);
  const source = environments.find(
    (environment) => environment.environmentId === request.threadRef.environmentId,
  );
  const targets = environments.filter(
    (environment) =>
      environment.environmentId !== request.threadRef.environmentId &&
      canCreateProjectInEnvironment(environment.connection.phase) &&
      (projects.some((project) => project.environmentId === environment.environmentId) ||
        cloneTargets.some((target) => target.environmentId === environment.environmentId)),
  );
  const [targetId, setTargetId] = useState(
    request.destination?.environmentId ?? targets[0]?.environmentId ?? null,
  );
  const target = targets.find((environment) => environment.environmentId === targetId) ?? null;
  const matchedProjects = matching.filter((project) => project.environmentId === targetId);
  const targetProjects =
    matchedProjects.length > 0
      ? matchedProjects
      : projects.filter((project) => project.environmentId === targetId);
  const [projectId, setProjectId] = useState(request.destination?.projectId ?? null);
  const destinationProject =
    targetProjects.find((project) => project.id === projectId) ??
    matchedProjects[0] ??
    (request.destination?.environmentId === targetId
      ? projects.find(
          (project) =>
            project.id === request.destination?.projectId && project.environmentId === targetId,
        )
      : null) ??
    null;
  const config = targetId ? configs.get(targetId) : null;
  const destinationProviders = targetId ? (providersByEnvironment.get(targetId) ?? []) : [];
  const entries = config
    ? providerInstanceEntriesFor(
        destinationProviders,
        config.settings,
        destinationProject?.id ?? null,
      )
    : [];
  const ready = entries.filter(isProviderInstancePickerReady);
  const inheritedEntry = ready.find(
    (entry) =>
      entry.instanceId === thread?.modelSelection.instanceId &&
      entry.models.some((model) => model.slug === thread.modelSelection.model),
  );
  const defaultEntry = inheritedEntry ?? ready[0];
  const defaultSelection = inheritedEntry
    ? thread?.modelSelection
    : defaultEntry?.models[0]
      ? { instanceId: defaultEntry.instanceId, model: defaultEntry.models[0].slug }
      : undefined;
  const [chosen, setChosen] = useState<{
    environmentId: EnvironmentId;
    selection: ModelSelection;
  } | null>(null);
  const selection = chosen?.environmentId === targetId ? chosen.selection : defaultSelection;
  const selectionReady =
    selection &&
    ready.some(
      (entry) =>
        entry.instanceId === selection.instanceId &&
        entry.models.some((model) => model.slug === selection.model),
    );
  const canExport = useAtomValue(
    threadEnvironment.exportMachineHandoff.permissionAtom(request.threadRef.environmentId),
  );
  const canImport = useAtomValue(
    threadEnvironment.importMachineHandoff.permissionAtom(
      targetId ?? request.threadRef.environmentId,
    ),
  );
  const [ids] = useState(() => ({
    threadId: newThreadId(),
    commandId: CommandId.make(randomUUID()),
  }));
  const executing = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const unavailable = machineHandoffBlocker({
    sourceAvailable: thread !== null && sourceProject !== null,
    sourceStatus: thread?.source.status,
    sourceConnected: source?.connection.phase === "connected",
    targetConnected: target?.connection.phase === "connected",
    sourceSupported: source?.serverConfig?.environment.capabilities.machineHandoff === true,
    targetSupported: target?.serverConfig?.environment.capabilities.machineHandoff === true,
    canExport,
    canImport,
    projectSelected: destinationProject !== null,
    modelReady: selectionReady === true,
  });
  const eligibility = () => {
    const currentThread = appAtomRegistry.get(
      environmentThreadShells.threadShellAtom(request.threadRef),
    );
    const presentations = appAtomRegistry.get(environmentPresentations.presentationsAtom);
    const currentSource = presentations.get(request.threadRef.environmentId);
    const currentTarget = targetId ? presentations.get(targetId) : null;
    const currentConfig = targetId
      ? appAtomRegistry.get(serverEnvironment.configValueAtom(targetId))
      : null;
    const currentProject =
      destinationProject && targetId
        ? appAtomRegistry.get(
            environmentProjects.projectAtom({
              environmentId: targetId,
              projectId: destinationProject.id,
            }),
          )
        : null;
    const currentEntries = currentConfig
      ? providerInstanceEntriesFor(
          currentConfig.providers,
          currentConfig.settings,
          currentProject?.id ?? null,
        ).filter(isProviderInstancePickerReady)
      : [];
    return machineHandoffBlocker({
      sourceAvailable:
        currentThread !== null &&
        sourceRef !== null &&
        appAtomRegistry.get(environmentProjects.projectAtom(sourceRef)) !== null &&
        currentThread.projectId === sourceRef.projectId,
      sourceStatus: currentThread?.source.status,
      sourceConnected: currentSource?.connection.phase === "connected",
      targetConnected: currentTarget?.connection.phase === "connected",
      sourceSupported:
        currentSource?.serverConfig?.environment.capabilities.machineHandoff === true,
      targetSupported:
        currentTarget?.serverConfig?.environment.capabilities.machineHandoff === true,
      canExport: appAtomRegistry.get(
        threadEnvironment.exportMachineHandoff.permissionAtom(request.threadRef.environmentId),
      ),
      canImport:
        targetId !== null &&
        appAtomRegistry.get(threadEnvironment.importMachineHandoff.permissionAtom(targetId)),
      projectSelected: currentProject !== null,
      modelReady:
        selection !== undefined &&
        currentEntries.some(
          (entry) =>
            entry.instanceId === selection.instanceId &&
            entry.models.some((model) => model.slug === selection.model),
        ),
    });
  };

  const submit = async () => {
    if (!target || !destinationProject || !selection || executing.current || unavailable) return;
    executing.current = true;
    setBusy(true);
    setError(null);
    try {
      const imported = await relayMachineHandoff({
        eligibility,
        exportSnapshot: async () => {
          const result = await runAtomCommand(
            appAtomRegistry,
            threadEnvironment.exportMachineHandoff,
            {
              environmentId: request.threadRef.environmentId,
              input: { threadId: request.threadRef.threadId },
            },
            { label: "Prepare machine handoff", reportFailure: false },
          );
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value;
        },
        importSnapshot: async (snapshot) => {
          const result = await runAtomCommand(
            appAtomRegistry,
            threadEnvironment.importMachineHandoff,
            {
              environmentId: target.environmentId,
              input: {
                ...ids,
                projectId: destinationProject.id,
                modelSelection: selection,
                snapshot,
              },
            },
            { label: "Hand off thread to machine", reportFailure: false },
          );
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value;
        },
      });
      close();
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({
          environmentId: target.environmentId,
          threadId: imported.threadId,
        }),
      });
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not hand off the thread. Your source is unchanged.",
      );
    } finally {
      executing.current = false;
      setBusy(false);
    }
  };

  const clone = () => {
    if (!sourceRef || !target || busy) return;
    close();
    openAddProjectToMachine({
      projectRef: sourceRef,
      targetEnvironmentId: target.environmentId,
      onReady: (destination) => openMachineHandoff({ threadRef: request.threadRef, destination }),
    });
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !busy) close();
      }}
    >
      <DialogPopup className="sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>Hand off to another machine</DialogTitle>
          <DialogDescription>
            Continue this conversation on another computer, with its current working files and no
            commits added to your branch.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label>Destination machine</Label>
              <Select
                value={targetId}
                onValueChange={(value) => {
                  setTargetId(value);
                  setProjectId(null);
                  setError(null);
                }}
                items={targets.map((environment) => ({
                  value: environment.environmentId,
                  label: environment.label,
                }))}
                disabled={busy}
              >
                <SelectTrigger aria-label="Destination machine">
                  <SelectValue placeholder="Connect another machine" />
                </SelectTrigger>
                <SelectPopup>
                  {targets.map((environment) => (
                    <SelectItem key={environment.environmentId} value={environment.environmentId}>
                      <EnvironmentMachineIcon
                        kind={resolveEnvironmentMachineKind(environment.serverConfig)}
                        className="size-3.5"
                      />
                      {environment.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </div>
            {target &&
            !destinationProject &&
            cloneTargets.some((candidate) => candidate.environmentId === target.environmentId) ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-sm text-muted-foreground">
                  Set up this project on {target.label} first. Handoff resumes after cloning and any
                  selected file copies finish. Ignored files still need to be set up in the
                  destination worktree.
                </p>
                <Button variant="outline" disabled={busy} onClick={clone}>
                  Clone project to {target.label}
                </Button>
              </div>
            ) : null}
            {targetProjects.length > 1 ||
            (targetProjects.length > 0 && matchedProjects.length === 0) ? (
              <div className="flex flex-col gap-2">
                <Label>Destination project folder</Label>
                <Select
                  value={destinationProject?.id ?? null}
                  onValueChange={setProjectId}
                  items={targetProjects.map((project) => ({
                    value: project.id,
                    label: project.workspaceRoot,
                  }))}
                  disabled={busy}
                >
                  <SelectTrigger aria-label="Destination project folder">
                    <SelectValue placeholder="Choose a destination repository" />
                  </SelectTrigger>
                  <SelectPopup>
                    {targetProjects.map((project) => (
                      <SelectItem key={project.id} value={project.id}>
                        {project.workspaceRoot}
                      </SelectItem>
                    ))}
                  </SelectPopup>
                </Select>
              </div>
            ) : null}
            {destinationProject && defaultEntry && selection ? (
              <div className="flex flex-col items-start gap-2">
                <Label>Continue with</Label>
                <ProviderModelPicker
                  environmentId={targetId}
                  activeInstanceId={selection.instanceId}
                  model={selection.model}
                  lockedProvider={null}
                  instanceEntries={entries}
                  modelOptionsByInstance={
                    new Map(entries.map((entry) => [entry.instanceId, entry.models]))
                  }
                  disabled={busy}
                  onInstanceModelChange={(instanceId, model) => {
                    if (targetId)
                      setChosen({ environmentId: targetId, selection: { instanceId, model } });
                  }}
                />
              </div>
            ) : null}
            {thread && target && selection ? (
              <HandoffRow
                environmentId={request.threadRef.environmentId}
                endpoints={{ from: [thread.modelSelection], to: selection }}
                providers={providersByEnvironment.get(request.threadRef.environmentId) ?? []}
                destinationProviders={destinationProviders}
                sourceMachine={{
                  label: source?.label ?? "Source",
                  kind: resolveEnvironmentMachineKind(source?.serverConfig ?? null),
                }}
                destinationMachine={{
                  label: target.label,
                  kind: resolveEnvironmentMachineKind(target.serverConfig),
                }}
                pending
              />
            ) : null}
            <p className="text-sm text-muted-foreground">
              The destination gets a new isolated worktree. Staged, unstaged, untracked and unpushed
              work travels with the handoff. Ignored files are not included. Your original thread
              and files stay on this machine; no agent starts until you send a message.
            </p>
            {destinationProject && ready.length === 0 ? (
              <p role="status" className="text-sm text-warning">
                Set up an available provider on the destination machine first.
              </p>
            ) : null}
            {unavailable || error ? (
              <p role="alert" className="text-sm text-destructive">
                {error ?? unavailable}
              </p>
            ) : null}
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" disabled={busy} onClick={close}>
            Cancel
          </Button>
          <Button
            disabled={busy || !destinationProject || !selectionReady || unavailable !== null}
            onClick={() => void submit()}
          >
            {busy ? "Transferring…" : "Hand off thread"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
