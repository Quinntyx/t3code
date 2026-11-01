import { useNavigate } from "@tanstack/react-router";
import { machineHandoffBlocker, relayMachineHandoff } from "@t3tools/client-runtime/handoff";
import { runAtomCommand, squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  type MachineHandoffImportResult,
  type ModelSelection,
} from "@t3tools/contracts";
import { useEffect, useRef, useState } from "react";

import { useStableCallback } from "../hooks/useStableCallback";
import { newThreadId, randomUUID } from "../lib/utils";
import {
  getDefaultProviderInstanceModel,
  isProviderInstancePickerReady,
  providerInstanceEntriesFor,
  resolveProjectDefaultProviderModelSelection,
} from "../providerInstances";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { useProject, useServerConfigs, useThreadShell } from "../state/entities";
import { useEnvironments, useEnvironmentProviders } from "../state/environments";
import { environmentPresentations } from "../state/presentation";
import { environmentProjects } from "../state/projects";
import { serverEnvironment } from "../state/server";
import { environmentThreadShells, threadEnvironment } from "../state/threads";
import { buildThreadRouteParams } from "../threadRoutes";
import {
  finishMachineHandoff,
  openMachineHandoff,
  setMachineHandoffSelection,
  useMachineHandoffRequest,
  type MachineHandoffAttempt,
} from "./machineHandoffRequest";
import { toastManager } from "./ui/toast";

export function MachineHandoffController() {
  const requests = useMachineHandoffRequest((state) => state.requests);
  // Failed attempts stay mounted so retries retain the original import request.
  return requests.map((attempt) => <MachineHandoff key={attempt.session} attempt={attempt} />);
}

function MachineHandoff({ attempt: job }: { attempt: MachineHandoffAttempt }) {
  const { request } = job;
  const navigate = useNavigate();
  const thread = useThreadShell(request.threadRef);
  const sourceRef = thread
    ? { environmentId: request.threadRef.environmentId, projectId: thread.projectId }
    : null;
  const sourceProject = useProject(sourceRef);
  const destinationProject = useProject(request.destination);
  const { environments } = useEnvironments();
  const providers = useEnvironmentProviders();
  const configs = useServerConfigs();
  const targetId = request.destination.environmentId;
  const config = configs.get(targetId);
  const destinationProviders = providers.get(targetId) ?? [];
  const ready = config
    ? providerInstanceEntriesFor(
        destinationProviders,
        config.settings,
        request.destination.projectId,
      ).filter(isProviderInstancePickerReady)
    : [];
  const inherited = ready.find(
    (entry) =>
      entry.instanceId === thread?.modelSelection.instanceId &&
      entry.models.some((model) => model.slug === thread.modelSelection.model),
  );
  const projectDefault = config
    ? resolveProjectDefaultProviderModelSelection(
        destinationProviders,
        config.settings,
        request.destination.projectId,
      )
    : null;
  const defaultReady = ready.find(
    (entry) =>
      entry.instanceId === projectDefault?.instanceId &&
      entry.models.some((model) => model.slug === projectDefault.model),
  );
  const fallback = ready.find((entry) => entry.models.length > 0);
  const defaultFallbackModel = fallback
    ? getDefaultProviderInstanceModel(destinationProviders, fallback.instanceId)
    : undefined;
  const fallbackModel =
    fallback?.models.find((model) => model.slug === defaultFallbackModel)?.slug ??
    fallback?.models[0]?.slug;
  const selection = inherited
    ? thread?.modelSelection
    : defaultReady
      ? projectDefault
      : fallback && fallbackModel
        ? { instanceId: fallback.instanceId, model: fallbackModel }
        : null;
  const [ids] = useState(() => ({
    threadId: newThreadId(),
    commandId: CommandId.make(randomUUID()),
  }));
  const startedRetry = useRef(-1);
  const attempt = useRef<(() => Promise<MachineHandoffImportResult>) | null>(null);
  const preparedSelection = useRef<ModelSelection | null>(null);

  const eligibility = () => {
    const handoffSelection = preparedSelection.current ?? selection;
    const currentThread = appAtomRegistry.get(
      environmentThreadShells.threadShellAtom(request.threadRef),
    );
    const presentations = appAtomRegistry.get(environmentPresentations.presentationsAtom);
    const source = presentations.get(request.threadRef.environmentId);
    const target = presentations.get(targetId);
    const currentConfig = appAtomRegistry.get(serverEnvironment.configValueAtom(targetId));
    const currentProject = appAtomRegistry.get(
      environmentProjects.projectAtom(request.destination),
    );
    const entries = currentConfig
      ? providerInstanceEntriesFor(
          currentConfig.providers,
          currentConfig.settings,
          request.destination.projectId,
        ).filter(isProviderInstancePickerReady)
      : [];
    return machineHandoffBlocker({
      sourceAvailable:
        currentThread !== null &&
        sourceProject !== null &&
        sourceRef !== null &&
        appAtomRegistry.get(environmentProjects.projectAtom(sourceRef)) !== null &&
        currentThread.projectId === sourceRef.projectId,
      sourceStatus: currentThread?.source.status,
      sourceConnected: source?.connection.phase === "connected",
      targetConnected: target?.connection.phase === "connected",
      sourceSupported: source?.serverConfig?.environment.capabilities.machineHandoff === true,
      targetSupported: target?.serverConfig?.environment.capabilities.machineHandoff === true,
      canExport: appAtomRegistry.get(
        threadEnvironment.exportMachineHandoff.permissionAtom(request.threadRef.environmentId),
      ),
      canImport: appAtomRegistry.get(
        threadEnvironment.importMachineHandoff.permissionAtom(targetId),
      ),
      projectSelected: currentProject !== null,
      modelReady:
        handoffSelection != null &&
        entries.some(
          (entry) =>
            entry.instanceId === handoffSelection.instanceId &&
            entry.models.some((model) => model.slug === handoffSelection.model),
        ),
    });
  };

  const transfer = useStableCallback(async (retry: number) => {
    if (startedRetry.current >= retry) return;
    startedRetry.current = retry;
    const handoffSelection = preparedSelection.current ?? selection;
    let succeeded = false;
    try {
      const blocker = eligibility();
      if (blocker) throw new Error(blocker);
      if (!destinationProject || !handoffSelection) return;
      setMachineHandoffSelection(job.session, handoffSelection);
      const imported = await relayMachineHandoff({
        eligibility,
        attempt,
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
          preparedSelection.current = handoffSelection;
          return result.value;
        },
        importSnapshot: async (snapshot) => {
          const result = await runAtomCommand(
            appAtomRegistry,
            threadEnvironment.importMachineHandoff,
            {
              environmentId: targetId,
              input: {
                ...ids,
                projectId: request.destination.projectId,
                modelSelection: handoffSelection,
                snapshot,
              },
            },
            { label: "Move thread to machine", reportFailure: false },
          );
          if (result._tag === "Failure") throw squashAtomCommandFailure(result);
          return result.value;
        },
      });
      if (imported.warnings?.length) {
        toastManager.add({
          type: "warning",
          title: "Worktree setup may be needed",
          description: "The new worktree excludes ignored files and dependencies.",
          actionProps: {
            children: "Details",
            onClick: () => {
              toastManager.add({
                type: "warning",
                title: "Workspace setup details",
                description: imported.warnings?.join("\n"),
              });
            },
          },
        });
      }
      succeeded = true;
      void navigate({
        to: "/$environmentId/$threadId",
        params: buildThreadRouteParams({ environmentId: targetId, threadId: imported.threadId }),
      });
    } catch (cause) {
      const target = environments.find((environment) => environment.environmentId === targetId);
      toastManager.add({
        type: "error",
        title: `Could not move thread to ${target?.label ?? "another machine"}`,
        description: cause instanceof Error ? cause.message : "Your source thread is unchanged.",
        actionProps: { children: "Retry", onClick: () => openMachineHandoff(request) },
      });
    } finally {
      finishMachineHandoff(job.session, succeeded);
    }
  });

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- executes explicit machine selections independently of the mounted source composer
  useEffect(() => {
    if (job.status === "running") void transfer(job.retry);
  }, [transfer, job.status, job.retry]);
  return null;
}
