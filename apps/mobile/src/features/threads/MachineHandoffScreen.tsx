import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  matchingMachineHandoffProjects,
  machineHandoffBlocker,
  machineHandoffCloneReady,
  relayMachineHandoff,
  sourceProjectSubdirectory,
} from "@t3tools/client-runtime/handoff";
import { buildProjectCreateCommand } from "@t3tools/client-runtime/operations/projects";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import {
  CommandId,
  ProjectId,
  ThreadId,
  type MachineHandoffImportResult,
  type ModelSelection,
  type ScopedProjectRef,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { getProviderOptionCurrentValue } from "@t3tools/shared/model";
import { AsyncResult } from "effect/reactivity";
import { use, useRef, useState, type ReactNode } from "react";
import { Alert, View, type ColorValue } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { ErrorBanner } from "../../components/ui/ErrorBanner";
import { ScreenScrollView } from "../../components/ui/ScreenScrollView";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { buildMachineHandoffModelOptions as destinationModels } from "../../lib/modelOptions";
import {
  applyProviderOptionSelection,
  resolveProviderOptionDescriptors,
} from "../../lib/providerOptions";
import { uuidv4 } from "../../lib/uuid";
import { useEnvironments } from "../../state/environments";
import {
  useProject,
  useProjects,
  useServerConfigs,
  useThreadShell,
  waitForProject,
} from "../../state/entities";
import { environmentPresentations } from "../../state/presentation";
import { useProjectClone } from "../../state/projectClones";
import { environmentProjects, projectEnvironment } from "../../state/projects";
import { serverEnvironment } from "../../state/server";
import { sourceControlEnvironment } from "../../state/sourceControl";
import { environmentThreadShells, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { AddProjectDestinationScreen } from "../projects/AddProjectScreen";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import { ChoiceRow } from "./ThreadSettingsRows";
import { ThreadHandoffDivider } from "./thread-handoff-row";
import { selectableChoices } from "./thread-settings-options";

function Section(props: { readonly title: string; readonly children: ReactNode }) {
  return (
    <View className="gap-2">
      <Text accessibilityRole="header" className="text-sm font-t3-medium text-foreground-muted">
        {props.title}
      </Text>
      <View className="overflow-hidden rounded-2xl bg-grouped-card">{props.children}</View>
    </View>
  );
}

export function MachineHandoffScreen(props: {
  readonly sourceRef: ScopedThreadRef;
  readonly modelSelection: ModelSelection;
  readonly iconColor: ColorValue;
  readonly surfaceColor: string;
}) {
  const registry = use(RegistryContext);
  const selectDetail = useSelectWorkspaceDetail();
  const thread = useThreadShell(props.sourceRef);
  const sourceProject = useProject(
    thread ? { environmentId: props.sourceRef.environmentId, projectId: thread.projectId } : null,
  );
  const projects = useProjects();
  const configs = useServerConfigs();
  const { environments } = useEnvironments();
  const source = environments.find(
    (environment) => environment.environmentId === props.sourceRef.environmentId,
  );
  const targets = environments.filter(
    (environment) =>
      environment.environmentId !== props.sourceRef.environmentId &&
      environment.connection.phase === "connected" &&
      environment.serverConfig?.environment.capabilities.machineHandoff === true,
  );
  const [targetId, setTargetId] = useState(targets[0]?.environmentId ?? null);
  const target = targets.find((environment) => environment.environmentId === targetId) ?? null;
  const matching = sourceProject
    ? matchingMachineHandoffProjects(sourceProject, projects).filter(
        (project) => project.environmentId === targetId,
      )
    : [];
  const [chosenProject, setChosenProject] = useState<ScopedProjectRef | null>(null);
  const targetProjects = projects.filter((project) => project.environmentId === targetId);
  const destinationProject =
    targetProjects.find(
      (project) =>
        chosenProject?.environmentId === targetId && project.id === chosenProject.projectId,
    ) ??
    (chosenProject === null && matching.length === 1 ? matching[0] : null) ??
    null;
  const config = targetId ? configs.get(targetId) : null;
  const [chosenModel, setChosenModel] = useState<ModelSelection | null>(null);
  const models = destinationModels(
    config,
    chosenModel ?? props.modelSelection,
    destinationProject?.id ?? null,
  );
  const inherited = models.find(
    (option) =>
      option.selection.instanceId === props.modelSelection.instanceId &&
      option.selection.model === props.modelSelection.model,
  );
  const model = chosenModel
    ? models.find(
        (option) =>
          option.selection.instanceId === chosenModel.instanceId &&
          option.selection.model === chosenModel.model,
      )
    : (inherited ?? models.find((option) => option.isDefault) ?? models[0]);
  const selection = model?.selection ?? null;
  const descriptors = resolveProviderOptionDescriptors({
    capabilities: model?.capabilities,
    selections: selection?.options,
  });
  const canExport = useAtomValue(
    threadEnvironment.exportMachineHandoff.permissionAtom(props.sourceRef.environmentId),
  );
  const canImport = useAtomValue(
    threadEnvironment.importMachineHandoff.permissionAtom(
      targetId ?? props.sourceRef.environmentId,
    ),
  );
  const exportHandoff = useAtomCommand(threadEnvironment.exportMachineHandoff, {
    reportFailure: false,
  });
  const importHandoff = useAtomCommand(threadEnvironment.importMachineHandoff, {
    reportFailure: false,
  });
  const [ids] = useState(() => ({
    commandId: CommandId.make(uuidv4()),
    threadId: ThreadId.make(uuidv4()),
  }));
  const executing = useRef(false);
  const attempt = useRef<(() => Promise<MachineHandoffImportResult>) | null>(null);
  const [prepared, setPrepared] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cloning, setCloning] = useState(false);
  const [clonedProject, setClonedProject] = useState<ScopedProjectRef | null>(null);
  const clone = useProjectClone(clonedProject);
  const cloneProject = useProject(clonedProject);
  const cloneReady = machineHandoffCloneReady(clone, cloneProject?.repositoryIdentity != null);
  const createProject = useAtomCommand(projectEnvironment.create, { reportFailure: false });
  const cancelClone = useAtomCommand(sourceControlEnvironment.cancelProjectClone, {
    reportFailure: false,
  });
  const retryClone = useAtomCommand(sourceControlEnvironment.retryProjectClone, {
    reportFailure: false,
  });
  const subdirectory = sourceProject
    ? sourceProjectSubdirectory(
        sourceProject.repositoryIdentity?.rootPath,
        sourceProject.workspaceRoot,
      )
    : null;
  const remoteUrl =
    sourceProject?.repositoryIdentity?.origin?.remoteUrl ??
    sourceProject?.repositoryIdentity?.locator.remoteUrl;
  const availability = {
    sourceAvailable: thread !== null && sourceProject !== null,
    sourceStatus: thread?.source.status,
    sourceConnected: source?.connection.phase === "connected",
    targetConnected: target !== null,
    sourceSupported: source?.serverConfig?.environment.capabilities.machineHandoff === true,
    targetSupported: target?.serverConfig?.environment.capabilities.machineHandoff === true,
    canExport,
    canImport,
    projectSelected: destinationProject !== null,
    modelReady: selection !== null,
  };
  const blocker = machineHandoffBlocker(availability);
  const preparationBlocker = machineHandoffBlocker({
    ...availability,
    projectSelected: true,
    modelReady: true,
  });
  const eligibility = () => {
    const currentThread = registry.get(environmentThreadShells.threadShellAtom(props.sourceRef));
    const presentations = registry.get(environmentPresentations.presentationsAtom);
    const currentSource = presentations.get(props.sourceRef.environmentId);
    const currentTarget = targetId ? presentations.get(targetId) : null;
    const currentConfig = targetId
      ? registry.get(serverEnvironment.configValueAtom(targetId))
      : null;
    const currentProject =
      destinationProject && targetId
        ? registry.get(
            environmentProjects.projectAtom({
              environmentId: targetId,
              projectId: destinationProject.id,
            }),
          )
        : null;
    return machineHandoffBlocker({
      sourceAvailable:
        currentThread !== null &&
        sourceProject !== null &&
        currentThread.projectId === sourceProject.id &&
        registry.get(
          environmentProjects.projectAtom({
            environmentId: props.sourceRef.environmentId,
            projectId: sourceProject.id,
          }),
        ) !== null,
      sourceStatus: currentThread?.source.status,
      sourceConnected: currentSource?.connection.phase === "connected",
      targetConnected: currentTarget?.connection.phase === "connected",
      sourceSupported:
        currentSource?.serverConfig?.environment.capabilities.machineHandoff === true,
      targetSupported:
        currentTarget?.serverConfig?.environment.capabilities.machineHandoff === true,
      canExport: registry.get(
        threadEnvironment.exportMachineHandoff.permissionAtom(props.sourceRef.environmentId),
      ),
      canImport:
        targetId !== null &&
        registry.get(threadEnvironment.importMachineHandoff.permissionAtom(targetId)),
      projectSelected: currentProject !== null,
      modelReady:
        selection !== null &&
        destinationModels(currentConfig, selection, currentProject?.id ?? null).some(
          (option) =>
            option.selection.instanceId === selection.instanceId &&
            option.selection.model === selection.model,
        ),
    });
  };

  const submit = async () => {
    if (executing.current || !targetId || !destinationProject || !selection) return;
    executing.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await relayMachineHandoff({
        eligibility,
        attempt,
        exportSnapshot: async () => {
          const result = await exportHandoff({
            environmentId: props.sourceRef.environmentId,
            input: { threadId: props.sourceRef.threadId },
          });
          if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
          setChosenProject({ environmentId: targetId, projectId: destinationProject.id });
          setChosenModel(selection);
          setPrepared(true);
          return result.value;
        },
        importSnapshot: async (snapshot) => {
          const result = await importHandoff({
            environmentId: targetId,
            input: {
              ...ids,
              projectId: destinationProject.id,
              modelSelection: selection,
              snapshot,
            },
          });
          if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
          return result.value;
        },
      });
      const openThread = () =>
        selectDetail({
          name: "Thread",
          params: { environmentId: targetId, threadId: result.threadId },
        });
      if (result.warnings?.length) {
        Alert.alert("Thread transferred; workspace setup needed", result.warnings.join("\n"), [
          { text: "Open thread", onPress: openThread },
        ]);
      } else {
        openThread();
      }
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

  const finishClone = async () => {
    if (busy || !clonedProject || !cloneProject || !cloneReady || subdirectory === null) return;
    setBusy(true);
    setError(null);
    try {
      let destination = clonedProject;
      if (subdirectory) {
        const projectId = ProjectId.make(uuidv4());
        const input = buildProjectCreateCommand({
          commandId: CommandId.make(uuidv4()),
          projectId,
          workspaceRoot: `${cloneProject.workspaceRoot.replace(/[/\\]+$/, "")}/${subdirectory}`,
        });
        const result = await createProject({ environmentId: clonedProject.environmentId, input });
        if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
        destination = { environmentId: clonedProject.environmentId, projectId };
        if (!(await waitForProject(destination)))
          throw new Error(
            "The cloned project has not reached this device yet. Reopen handoff when it appears.",
          );
      }
      setChosenProject(destination);
      setCloning(false);
      setChosenModel(null);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not prepare the destination project.",
      );
    } finally {
      setBusy(false);
    }
  };

  if (cloning && target && sourceProject && remoteUrl) {
    return (
      <View className="flex-1 bg-sheet">
        <View className="px-4 py-3 gap-2">
          <Button label="Back to handoff" disabled={busy} onPress={() => setCloning(false)} />
          {error ? <ErrorBanner message={error} /> : null}
        </View>
        {clonedProject ? (
          <View className="px-4 gap-4">
            <Text>
              {cloneReady
                ? "Clone complete. Continue to review the handoff; no agent will start."
                : clone === null || clone === "pending"
                  ? "Waiting for clone status…"
                  : clone.phase === "running"
                    ? "Cloning repository…"
                    : (clone.error ?? "Clone did not complete.")}
            </Text>
            <Button
              label="Continue handoff"
              disabled={!cloneProject || !cloneReady}
              loading={busy}
              onPress={() => void finishClone()}
            />
            {clone !== null && clone !== "pending" && clone.phase !== "done" ? (
              <Button
                label={clone.phase === "running" ? "Cancel clone" : "Retry clone"}
                onPress={() => {
                  const command = clone.phase === "running" ? cancelClone : retryClone;
                  void command({
                    environmentId: clonedProject.environmentId,
                    input: { projectId: clonedProject.projectId },
                  }).then((result) => {
                    if (AsyncResult.isFailure(result))
                      setError(String(squashAtomCommandFailure(result)));
                  });
                }}
              />
            ) : null}
          </View>
        ) : (
          <AddProjectDestinationScreen
            environmentId={target.environmentId}
            remoteUrl={remoteUrl}
            repositoryTitle={sourceProject.title}
            repositoryName={sourceProject.repositoryIdentity?.rootPath
              ?.replaceAll("\\", "/")
              .split("/")
              .filter(Boolean)
              .at(-1)}
            onCloneStarted={setClonedProject}
          />
        )}
      </View>
    );
  }

  return (
    <ScreenScrollView
      className="flex-1 bg-sheet"
      contentContainerStyle={{ padding: 16, gap: 20, paddingBottom: 40 }}
      contentInsetAdjustmentBehavior="automatic"
    >
      <Text className="text-sm text-foreground-muted">
        Continue this conversation and its working files in a fresh isolated worktree on another
        machine. The original thread and files stay intact, with no commits added to your branch and
        no agent turn started.
      </Text>
      {error ? <ErrorBanner message={error} /> : null}
      <View pointerEvents={busy || prepared ? "none" : "auto"} className="gap-5">
        <Section title="Destination machine">
          {targets.map((environment, index) => (
            <ChoiceRow
              key={environment.environmentId}
              label={environment.label}
              selected={environment.environmentId === targetId}
              isLast={index === targets.length - 1}
              onPress={() => {
                setTargetId(environment.environmentId);
                setChosenProject(null);
                setChosenModel(null);
                setClonedProject(null);
                setError(null);
              }}
            />
          ))}
          {targets.length === 0 ? (
            <Text className="p-4 text-sm text-foreground-muted">
              No other connected machine supports handoff. Connect or update the destination server
              first.
            </Text>
          ) : null}
        </Section>
        {target ? (
          <>
            <Section title="Destination project">
              {targetProjects.map((project, index) => (
                <ChoiceRow
                  key={project.id}
                  label={project.title}
                  description={`${matching.some((candidate) => candidate.id === project.id) ? "Matching repository · " : ""}${project.workspaceRoot}`}
                  selected={project.id === destinationProject?.id}
                  isLast={index === targetProjects.length - 1}
                  onPress={() => {
                    setChosenProject({
                      environmentId: target.environmentId,
                      projectId: project.id,
                    });
                    setChosenModel(null);
                  }}
                />
              ))}
              {targetProjects.length === 0 ? (
                <Text className="p-4 text-sm text-foreground-muted">
                  This machine has no project yet.
                </Text>
              ) : null}
            </Section>
            {matching.length === 0 ? (
              <Text className="text-sm text-foreground-muted">
                No repository and project-path match was found. Explicitly choose the same
                repository and relative project folder, or clone it first. The server checks
                compatibility before importing.
              </Text>
            ) : null}
            <Button
              label="Clone repository on this machine"
              disabled={!remoteUrl || subdirectory === null || preparationBlocker !== null}
              onPress={() => {
                setCloning(true);
                setError(null);
              }}
            />
            {subdirectory === null ? (
              <Text className="text-xs text-foreground-muted">
                Repository identity is unavailable, so automatic cloning cannot preserve the project
                folder. Add the matching project on this machine first, then select it here.
              </Text>
            ) : null}
            {destinationProject ? (
              <Section title="Destination provider and model">
                {models.map((option, index) => (
                  <ChoiceRow
                    key={option.key}
                    label={option.label}
                    description={option.providerLabel}
                    selected={option.key === model?.key}
                    isLast={index === models.length - 1}
                    onPress={() => setChosenModel(option.selection)}
                  />
                ))}
                {models.length === 0 ? (
                  <Text className="p-4 text-sm text-foreground-muted">
                    No ready provider/model for this project. Set one up on the destination first.
                  </Text>
                ) : null}
              </Section>
            ) : null}
            {selection
              ? descriptors.map((descriptor) =>
                  descriptor.type === "select" ? (
                    <Section key={descriptor.id} title={descriptor.label}>
                      {selectableChoices(descriptor)
                        .filter((choice) => !descriptor.promptInjectedValues?.includes(choice.id))
                        .map((choice, index, choices) => (
                          <ChoiceRow
                            key={choice.id}
                            label={choice.label}
                            description={choice.description}
                            selected={
                              choice.id ===
                              getProviderOptionCurrentValue(descriptor, selection, null)
                            }
                            isLast={index === choices.length - 1}
                            onPress={() =>
                              setChosenModel({
                                ...selection,
                                options:
                                  applyProviderOptionSelection(descriptors, {
                                    id: descriptor.id,
                                    value: choice.id,
                                  }) ?? [],
                              })
                            }
                          />
                        ))}
                    </Section>
                  ) : (
                    <View
                      key={descriptor.id}
                      className="flex-row items-center justify-between gap-3 rounded-2xl bg-grouped-card px-4 py-3"
                    >
                      <Text className="text-base">{descriptor.label}</Text>
                      <ThemedSwitch
                        accessibilityLabel={descriptor.label}
                        value={getProviderOptionCurrentValue(descriptor, selection, null) === true}
                        onValueChange={(value) =>
                          setChosenModel({
                            ...selection,
                            options:
                              applyProviderOptionSelection(descriptors, {
                                id: descriptor.id,
                                value,
                              }) ?? [],
                          })
                        }
                      />
                    </View>
                  ),
                )
              : null}
          </>
        ) : null}
      </View>
      {thread && target && selection ? (
        <View className="gap-4">
          <ThreadHandoffDivider
            environmentId={props.sourceRef.environmentId}
            endpoints={{ from: [], to: props.modelSelection }}
            iconColor={props.iconColor}
            surfaceColor={props.surfaceColor}
            label={`From ${source?.label ?? "source machine"}`}
          />
          <ThreadHandoffDivider
            environmentId={target.environmentId}
            endpoints={{ from: [], to: selection }}
            iconColor={props.iconColor}
            surfaceColor={props.surfaceColor}
            label={`To ${target.label}`}
          />
        </View>
      ) : null}
      <Text className="text-xs text-foreground-muted">
        Ignored files (including ignored .env files), provider sessions, approvals and
        authentication are not transferred. Tracked changes, untracked non-ignored files and
        unpushed git history travel with the handoff.
      </Text>
      {blocker ? <Text className="text-sm text-foreground-muted">{blocker}</Text> : null}
      <Button
        label="Hand off thread"
        tone="primary"
        fullWidth
        disabled={blocker !== null}
        loading={busy}
        onPress={() => void submit()}
      />
    </ScreenScrollView>
  );
}
