// @effect-diagnostics nodeBuiltinImport:off -- A real Git fixture proves retry recovery does not overwrite work.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2ThreadProjection,
  type MachineHandoffImportInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as GitManager from "../git/GitManager.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ProjectSetupScriptRunner from "../project/ProjectSetupScriptRunner.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as MachineHandoffService from "./MachineHandoffService.ts";
import { OrchestratorDispatchError } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import { emptyProjection } from "./ProjectionStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { exportGitSnapshot } from "./machineHandoffGit.ts";

it.effect("refuses waiting items and background work even when the provider is idle", () =>
  Effect.gen(function* () {
    const threadId = ThreadId.make("active-export");
    const providerInstanceId = ProviderInstanceId.make("source");
    const now = DateTime.makeUnsafe("2026-10-01T00:00:00Z");
    const base = emptyProjection({
      id: EventId.make("active-export-created"),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        id: threadId,
        createdBy: "user",
        creationSource: "web",
        projectId: ProjectId.make("source"),
        title: "Active source",
        providerInstanceId,
        modelSelection: { instanceId: providerInstanceId, model: "test" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      },
    });
    let projection: OrchestrationV2ThreadProjection = base;
    const dependencies = Layer.mergeAll(
      ServerConfig.layerTest("/tmp", "/tmp/t3-export-guard-test"),
      ServerSettings.layerTest(),
      ThreadCommandExecutor.layer,
      Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("source")),
      }),
      Layer.mock(GitManager.GitManager)({}),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({}),
      Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeedNone }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadSnapshot: () =>
          Effect.sync(() => ({ schemaVersion: 2, snapshotSequence: 0, projection })),
      }),
    );
    const service = yield* MachineHandoffService.MachineHandoffService.pipe(
      Effect.provide(
        MachineHandoffService.layer.pipe(
          Layer.provide(dependencies),
          Layer.provide(NodeServices.layer),
        ),
      ),
    );
    const cases: ReadonlyArray<OrchestrationV2ThreadProjection> = [
      {
        ...base,
        providerThreads: [
          {
            id: ProviderThreadId.make("idle-with-task"),
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId: null,
            nativeThreadRef: null,
            nativeConversationHeadRef: null,
            status: "idle",
            firstRunOrdinal: null,
            lastRunOrdinal: null,
            handoffIds: [],
            forkedFrom: null,
            pendingBackgroundTasks: [{ taskId: "review", kind: "subagent" }],
            createdAt: now,
            updatedAt: now,
          },
        ],
      },
      {
        ...base,
        turnItems: [
          {
            id: TurnItemId.make("waiting-tool"),
            threadId,
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "waiting",
            title: null,
            startedAt: now,
            completedAt: null,
            updatedAt: now,
            type: "assistant_message",
            messageId: MessageId.make("waiting-message"),
            text: "Waiting for a tool",
            streaming: false,
          },
        ],
      },
    ];
    for (const live of cases) {
      projection = live;
      const failure = yield* service.exportSnapshot({ threadId }).pipe(Effect.flip);
      expect(failure.message).toContain("Stop live, queued, approval, and background work");
    }
  }),
);

it.effect.each([
  { layout: "standard", containerLayout: true, configuredDirectory: false, linkedSource: true },
  {
    layout: "worktree-container",
    containerLayout: true,
    configuredDirectory: false,
    linkedSource: false,
  },
  {
    layout: "worktree-container",
    containerLayout: false,
    configuredDirectory: false,
    linkedSource: true,
  },
  {
    layout: "worktree-container",
    containerLayout: true,
    configuredDirectory: true,
    linkedSource: false,
  },
] as const)(
  "recovers destination placement and branch collisions after a failed thread commit: %j",
  ({ layout, containerLayout, configuredDirectory, linkedSource }) =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-machine-retry-"));
      const source = NodePath.join(root, "source", linkedSource ? "main" : "project");
      const destination = NodePath.join(
        root,
        "destination",
        layout === "worktree-container" ? "main" : "project",
      );
      const git = (cwd: string, ...args: string[]) =>
        NodeChildProcess.execFileSync("git", ["-C", cwd, ...args], { encoding: "utf8" }).trim();
      git(root, "init", source);
      git(source, "config", "user.name", "Test");
      git(source, "config", "user.email", "test@example.test");
      NodeFS.writeFileSync(NodePath.join(source, "file"), "base\n");
      NodeFS.writeFileSync(NodePath.join(source, ".gitignore"), ".env\n");
      git(source, "add", ".");
      git(source, "commit", "-m", "base");
      git(root, "clone", source, destination);
      if (configuredDirectory) git(destination, "branch", "feature");
      if (layout === "standard") {
        git(destination, "branch", "feature/transfer");
        git(destination, "tag", "feature/transfer");
      }
      NodeFS.writeFileSync(NodePath.join(destination, ".env"), "destination root ignored data\n");
      let sourceWorkspace = source;
      if (linkedSource) {
        sourceWorkspace = NodePath.join(NodePath.dirname(source), "source-linked");
        git(source, "worktree", "add", "-b", "feature/source", sourceWorkspace);
      }
      NodeFS.writeFileSync(NodePath.join(sourceWorkspace, "file"), "uncommitted\n");
      const snapshot = yield* Effect.promise(() => exportGitSnapshot(sourceWorkspace));
      const now = DateTime.makeUnsafe("2026-10-01T00:00:00Z");
      const projectId = ProjectId.make("destination-project");
      const threadId = ThreadId.make("destination-thread");
      const commandId = CommandId.make("destination-import");
      const selection = {
        instanceId: ProviderInstanceId.make("destination-provider"),
        model: "test",
      };
      const input: MachineHandoffImportInput = {
        commandId,
        threadId,
        projectId,
        modelSelection: selection,
        snapshot: {
          version: 1,
          sourceEnvironmentId: EnvironmentId.make("source"),
          sourceThreadId: ThreadId.make("source-thread"),
          title: "Transferred",
          modelSelection: {
            instanceId: ProviderInstanceId.make("source-provider"),
            model: "source",
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: "feature/transfer",
          workspaceKind: linkedSource ? "worktree" : "checkout",
          context: [{ role: "user", text: "Continue" }],
          git: snapshot,
        },
      };
      let receipt: CommandReceiptStore.CommandReceiptV2 | null = null;
      let workspace = "";
      let attempts = 0;
      const dependencies = Layer.mergeAll(
        ServerConfig.layerTest(root, NodePath.join(root, "server-state")),
        ServerSettings.layerTest({
          projectSettingsOverrides: { [projectId]: { newWorktreesBesideMain: containerLayout } },
          worktreesDirectory: configuredDirectory ? NodePath.join(root, "configured") : "",
        }),
        ThreadCommandExecutor.layer,
        Layer.succeed(ServerEnvironment.ServerEnvironmentIdentity, {
          getEnvironmentId: Effect.succeed(EnvironmentId.make("destination")),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: () =>
            Effect.succeedSome({
              projectId,
              title: "Project",
              workspaceRoot: destination,
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              autoPull: false,
              faviconPath: null,
              projectIcon: null,
              scripts: [],
              createdAt: "2026-10-01T00:00:00Z",
              updatedAt: "2026-10-01T00:00:00Z",
              deletedAt: null,
            }),
        }),
        Layer.mock(CommandReceiptStore.CommandReceiptStoreV2)({
          getByCommandId: () => Effect.sync(() => Option.fromNullishOr(receipt)),
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: (command) =>
            Effect.gen(function* () {
              if (command.type !== "thread.machine-import")
                return yield* Effect.die("Unexpected command");
              workspace = command.worktreePath!;
              attempts++;
              expect(command.modelSelection).toEqual(selection);
              const expectedBranch = configuredDirectory
                ? "feature-2/transfer"
                : layout === "standard"
                  ? "feature/transfer-2"
                  : "feature/transfer";
              expect(command.branch).toBe(expectedBranch);
              expect(git(workspace, "branch", "--show-current")).toBe(command.branch);
              const parent =
                layout === "worktree-container" && containerLayout && !configuredDirectory
                  ? NodePath.dirname(destination)
                  : NodePath.join(
                      root,
                      configuredDirectory ? "configured" : "server-state/worktrees",
                      NodePath.basename(destination),
                    );
              expect(workspace).toBe(NodePath.join(parent, expectedBranch.replaceAll("/", "-")));
              if (attempts === 1)
                return yield* new OrchestratorDispatchError({
                  commandId,
                  commandType: command.type,
                  cause: "database commit unavailable",
                });
              receipt = {
                commandId,
                threadId,
                commandType: command.type,
                acceptedAt: now,
                resultSequence: 7,
                status: "accepted",
                error: null,
              };
              return { sequence: 7, storedEvents: [] };
            }),
        }),
      );
      const manager = GitManager.layer.pipe(
        Layer.provideMerge(GitVcsDriver.layer.pipe(Layer.provide(VcsProcess.layer))),
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
              resolveLink: () => undefined,
            }),
            Layer.mock(TextGeneration.TextGeneration)({}),
            Layer.mock(ProviderRegistry.ProviderRegistry)({}),
            Layer.mock(ProjectSetupScriptRunner.ProjectSetupScriptRunner)({}),
            Layer.mock(ProjectionStore.ProjectionStoreV2)({}),
          ),
        ),
        Layer.provide(dependencies),
        Layer.provide(NodeServices.layer),
      );
      const imported = MachineHandoffService.layer.pipe(
        Layer.provide(Layer.merge(dependencies, manager)),
        Layer.provide(NodeServices.layer),
      );
      const runImport = Effect.gen(function* () {
        const service = yield* MachineHandoffService.MachineHandoffService;
        return yield* service.importSnapshot(input);
      }).pipe(Effect.provide(imported));
      expect((yield* runImport.pipe(Effect.flip))._tag).toBe("MachineHandoffError");
      expect(attempts).toBe(1);
      NodeFS.writeFileSync(NodePath.join(workspace, "file"), "kept after failure\n");
      const result = yield* runImport;
      expect(result).toMatchObject({ threadId, sequence: 7 });
      expect(result.warnings).toEqual([expect.stringContaining("ignored files")]);
      expect(NodeFS.existsSync(NodePath.join(workspace, ".env"))).toBe(false);
      expect(yield* runImport).toEqual(result);
      expect(attempts).toBe(2);
      expect(NodeFS.readFileSync(NodePath.join(workspace, "file"), "utf8")).toBe(
        "kept after failure\n",
      );
      expect(git(sourceWorkspace, "status", "--porcelain=v1")).toBe("M file");
      if (linkedSource) expect(git(source, "status", "--porcelain=v1")).toBe("");
      expect(git(destination, "status", "--porcelain=v1")).toBe("");
    }),
);
