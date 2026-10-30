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
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type MachineHandoffImportInput,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as MachineHandoffService from "./MachineHandoffService.ts";
import { OrchestratorDispatchError } from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import { exportGitSnapshot } from "./machineHandoffGit.ts";

it.effect(
  "recovers the same isolated workspace after a failed thread commit, then replays the accepted receipt",
  () =>
    Effect.gen(function* () {
      const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-machine-retry-"));
      const source = NodePath.join(root, "source");
      const destination = NodePath.join(root, "destination");
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
      NodeFS.writeFileSync(NodePath.join(destination, ".env"), "destination root ignored data\n");
      NodeFS.writeFileSync(NodePath.join(source, "file"), "uncommitted\n");
      const snapshot = yield* Effect.promise(() => exportGitSnapshot(source));
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
          branch: "feature",
          workspaceKind: "checkout",
          context: [{ role: "user", text: "Continue" }],
          git: snapshot,
        },
      };
      let receipt: CommandReceiptStore.CommandReceiptV2 | null = null;
      let workspace = "";
      let attempts = 0;
      const dependencies = Layer.mergeAll(
        ServerConfig.layerTest(root, NodePath.join(root, "server-state")),
        ServerSettings.layerTest(),
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
      const imported = MachineHandoffService.layer.pipe(
        Layer.provide(dependencies),
        Layer.provide(NodeServices.layer),
      );
      const runImport = Effect.gen(function* () {
        const service = yield* MachineHandoffService.MachineHandoffService;
        return yield* service.importSnapshot(input);
      }).pipe(Effect.provide(imported));
      expect((yield* runImport.pipe(Effect.flip))._tag).toBe("MachineHandoffError");
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
      expect(git(source, "status", "--porcelain=v1")).toBe("M file");
      expect(git(destination, "status", "--porcelain=v1")).toBe("");
    }),
);
