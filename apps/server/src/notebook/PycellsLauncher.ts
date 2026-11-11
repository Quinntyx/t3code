// @effect-diagnostics nodeBuiltinImport:off globalTimers:off -- Server-owned socket/process lifetimes must not inherit a provider AgentScope.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import {
  PycellsLauncher,
  PycellsLaunchError,
  pycellsLaunchEnvironment,
  pycellsSocketPath,
} from "@t3tools/shared/pycells";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { ServerConfig } from "../config.ts";

const Recipe = Schema.Struct({
  id: Schema.String,
  op: Schema.Literal("launch"),
  threadId: Schema.String,
  socketPath: Schema.String,
  rootDir: Schema.String,
  environment: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
});
const decodeRecipe = Schema.decodeUnknownSync(Recipe);
const MAX_REQUEST_BYTES = 1024 * 1024;

const make = Effect.gen(function* () {
  const { stateDir } = yield* ServerConfig;
  const hostEnvironment = yield* HostProcess.Environment;
  const executable = yield* HostProcess.ExecutablePath;
  const userId = yield* HostProcess.UserId;
  const ownerScope = yield* Effect.scope;
  const registrations = new Set<string>();
  const socketDirectory = NodePath.dirname(pycellsSocketPath(stateDir, ""));
  const identity = NodeCrypto.createHash("sha256").update(stateDir).digest("hex").slice(0, 16);
  const socketPath = NodePath.join(
    socketDirectory,
    `t3-launch-${identity}-${NodeCrypto.randomBytes(6).toString("hex")}.sock`,
  );
  const integrationEnvironment = (threadId: string) => ({
    ...pycellsLaunchEnvironment(stateDir, threadId),
    T3_PYCELLS_LAUNCH_SOCKET: socketPath,
  });
  const start = yield* Effect.cached(
    Effect.acquireRelease(
      Effect.tryPromise({
        try: async () => {
          await NodeFSP.mkdir(socketDirectory, { recursive: true, mode: 0o700 });
          const directory = await NodeFSP.lstat(socketDirectory);
          if (!directory.isDirectory() || directory.uid !== userId)
            throw new PycellsLaunchError({ message: "Invalid pycells socket directory." });
          await NodeFSP.chmod(socketDirectory, 0o700);
          const sockets = new Set<NodeNet.Socket>();
          const children = new Map<string, NodeChildProcess.ChildProcess>();
          const pending = new Map<string, Promise<number>>();
          let closing = false;
          const launch = async (recipe: typeof Recipe.Type): Promise<number> => {
            if (
              !registrations.has(recipe.threadId) ||
              recipe.socketPath !== pycellsSocketPath(stateDir, recipe.threadId)
            )
              throw new PycellsLaunchError({ message: "Unregistered pycells endpoint." });
            if (!NodePath.isAbsolute(recipe.rootDir))
              throw new PycellsLaunchError({ message: "Invalid pycells package root." });
            const root = await NodeFSP.realpath(recipe.rootDir);
            const metadata: unknown = JSON.parse(
              await NodeFSP.readFile(NodePath.join(root, "package.json"), "utf8"),
            );
            if (
              typeof metadata !== "object" ||
              metadata === null ||
              !("name" in metadata) ||
              metadata.name !== "pi-pycells"
            )
              throw new PycellsLaunchError({ message: "Invalid pycells package." });
            const entry = NodePath.join(root, "src/kernel-host/launch.cjs");
            if ((await NodeFSP.realpath(entry)) !== entry || !(await NodeFSP.stat(entry)).isFile())
              throw new PycellsLaunchError({ message: "Invalid pycells entrypoint." });
            if (closing)
              throw new PycellsLaunchError({ message: "Pycells launcher is shutting down." });
            const environment: NodeJS.ProcessEnv = { ...hostEnvironment, ...recipe.environment };
            for (const key of Object.keys(environment)) {
              if (key === "T3_THREAD_ID" || key.startsWith("T3_PYCELLS_")) delete environment[key];
            }
            Object.assign(environment, integrationEnvironment(recipe.threadId));
            if (process.versions.electron) environment.ELECTRON_RUN_AS_NODE = "1";
            // This spawn runs in the server, never through the provider's scoped spawner.
            const child = NodeChildProcess.spawn(
              executable,
              [entry, "--socket", recipe.socketPath, "--root", root],
              {
                cwd: root,
                env: environment,
                detached: true,
                stdio: "ignore",
              },
            );
            children.set(recipe.threadId, child);
            child.once("exit", () => {
              if (children.get(recipe.threadId) === child) children.delete(recipe.threadId);
            });
            child.unref();
            return await new Promise<number>((resolve, reject) => {
              child.once("error", (error) => {
                if (children.get(recipe.threadId) === child) children.delete(recipe.threadId);
                reject(error);
              });
              child.once("spawn", () => {
                if (child.pid === undefined)
                  reject(new PycellsLaunchError({ message: "Pycells host has no PID." }));
                else resolve(child.pid);
              });
            });
          };
          const ensure = (recipe: typeof Recipe.Type): Promise<number> => {
            if (
              !registrations.has(recipe.threadId) ||
              recipe.socketPath !== pycellsSocketPath(stateDir, recipe.threadId)
            )
              return Promise.reject(
                new PycellsLaunchError({ message: "Unregistered pycells endpoint." }),
              );
            const existing = children.get(recipe.threadId);
            if (
              existing?.pid !== undefined &&
              existing.exitCode === null &&
              existing.signalCode === null
            )
              return Promise.resolve(existing.pid);
            const current = pending.get(recipe.threadId);
            if (current !== undefined) return current;
            const work = launch(recipe).finally(() => pending.delete(recipe.threadId));
            pending.set(recipe.threadId, work);
            return work;
          };
          const server = NodeNet.createServer((socket) => {
            sockets.add(socket);
            const timer = setTimeout(() => socket.destroy(), 5_000);
            socket.once("close", () => {
              clearTimeout(timer);
              sockets.delete(socket);
            });
            socket.on("error", () => socket.destroy());
            let size = 0;
            let received = false;
            const chunks: Buffer[] = [];
            socket.on("data", (chunk: Buffer) => {
              if (received) return;
              size += chunk.length;
              if (size > MAX_REQUEST_BYTES) {
                socket.destroy();
                return;
              }
              const newline = chunk.indexOf(10);
              chunks.push(newline < 0 ? chunk : chunk.subarray(0, newline));
              if (newline < 0) return;
              received = true;
              let id = "";
              const reject = () =>
                socket.end(
                  JSON.stringify({
                    id,
                    error: { name: "PycellsLaunchError", message: "Pycells host launch rejected." },
                  }) + "\n",
                );
              try {
                const recipe = decodeRecipe(JSON.parse(Buffer.concat(chunks).toString("utf8")));
                id = recipe.id;
                void ensure(recipe).then(
                  (pid) => {
                    if (!socket.destroyed)
                      socket.end(JSON.stringify({ id, result: { pid } }) + "\n");
                  },
                  () => {
                    if (!socket.destroyed) reject();
                  },
                );
              } catch {
                reject();
              }
            });
          });
          try {
            await new Promise<void>((resolve, reject) => {
              server.once("error", reject);
              server.listen(socketPath, resolve);
            });
            await NodeFSP.chmod(socketPath, 0o600);
          } catch (error) {
            server.close();
            throw error;
          }
          return {
            server,
            sockets,
            children,
            close: () => {
              closing = true;
            },
          };
        },
        catch: () =>
          new PycellsLaunchError({ message: "Could not initialize the pycells launcher." }),
      }),
      (resource) =>
        Effect.promise(async () => {
          resource.close();
          for (const socket of resource.sockets) socket.destroy();
          for (const child of resource.children.values()) child.kill("SIGTERM");
          await new Promise<void>((resolve) => resource.server.close(() => resolve()));
        }),
    ).pipe(Effect.provideService(Scope.Scope, ownerScope)),
  );
  const prepare = Effect.fn("PycellsLauncher.prepare")(function* (
    identity: string,
    threadId: string,
  ) {
    if (identity !== stateDir)
      return yield* new PycellsLaunchError({ message: "Pycells environment identity mismatch." });
    yield* start;
    registrations.add(threadId);
    return integrationEnvironment(threadId);
  });
  return { prepare };
});

export const layer = Layer.effect(PycellsLauncher, make);
