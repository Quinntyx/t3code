// @effect-diagnostics nodeBuiltinImport:off -- Real local sockets and a captured child prove the server ownership boundary.
import * as NodeNet from "node:net";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { PycellsLauncher, pycellsSocketPath } from "@t3tools/shared/pycells";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ServerConfig from "../config.ts";
import * as Launcher from "./PycellsLauncher.ts";

const request = (path: string, data: unknown) =>
  new Promise<{
    result?: { pid: number };
    error?: { message: string };
  }>((resolve, reject) => {
    const socket = NodeNet.createConnection(path);
    let input = "";
    socket.once("error", reject);
    socket.once("connect", () => socket.write(JSON.stringify(data) + "\n"));
    socket.on("data", (chunk) => {
      input += chunk.toString();
      if (input.includes("\n")) {
        socket.destroy();
        resolve(JSON.parse(input));
      }
    });
  });

it.live(
  "launches only registered endpoints as server children and overrides reserved ambient env",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-launcher-test-" });
      const readyPath = NodePath.join(root, "ready.sock");
      let report!: (data: {
        pid: number;
        ppid: number;
        thread: string;
        owner: string;
        extra: string;
        injected: string;
      }) => void;
      const ready = new Promise<Parameters<typeof report>[0]>((resolve) => {
        report = resolve;
      });
      yield* Effect.acquireRelease(
        Effect.promise(async () => {
          const server = NodeNet.createServer((socket) => {
            socket.once("data", (chunk) => {
              report(JSON.parse(chunk.toString()));
              socket.end();
            });
          });
          await new Promise<void>((resolve, reject) => {
            server.once("error", reject);
            server.listen(readyPath, resolve);
          });
          return server;
        }),
        (server) =>
          Effect.promise(() => new Promise<void>((resolve) => server.close(() => resolve()))),
      );
      yield* Effect.promise(async () => {
        await NodeFSP.mkdir(NodePath.join(root, "src/kernel-host"), { recursive: true });
        await NodeFSP.writeFile(
          NodePath.join(root, "package.json"),
          JSON.stringify({ name: "pi-pycells" }),
        );
        await NodeFSP.writeFile(
          NodePath.join(root, "src/kernel-host/launch.cjs"),
          `
      const net = require('node:net');
      const socket = net.connect(process.env.READY_SOCKET, () => socket.end(JSON.stringify({
        pid:process.pid, ppid:process.ppid, thread:process.env.T3_THREAD_ID,
        owner:process.env.T3_PYCELLS_OWNER_PID, extra:process.env.PYCELLS_TEST_EXTRA,
        injected:process.env.PYCELLS_HOST_ENV
      })));
      net.createServer(s => s.end()).listen(process.env.T3_PYCELLS_SOCKET);
    `,
        );
      });
      const config = Layer.effect(
        ServerConfig.ServerConfig,
        ServerConfig.ServerConfig.pipe(Effect.map((value) => ({ ...value, stateDir: root }))),
      ).pipe(
        Layer.provide(ServerConfig.layerTest(process.cwd(), { prefix: "t3-launch-config-" })),
        Layer.provide(NodeServices.layer),
      );
      yield* Effect.gen(function* () {
        const launcher = yield* PycellsLauncher;
        const env = yield* launcher.prepare(root, "thread-1").pipe(Effect.scoped);
        expect(NodePath.isAbsolute(env.T3_PYCELLS_LAUNCH_SOCKET!)).toBe(true);
        const recipe = {
          id: "launch-1",
          op: "launch",
          threadId: "thread-1",
          socketPath: pycellsSocketPath(root, "thread-1"),
          rootDir: root,
          environment: {
            ...process.env,
            READY_SOCKET: readyPath,
            PATH: root,
            PYCELLS_TEST_EXTRA: "preserved",
            T3_THREAD_ID: "wrong",
            T3_PYCELLS_SOCKET: "/tmp/wrong.sock",
            T3_PYCELLS_OWNER_PID: "1",
          },
        };
        for (const override of [
          { threadId: "unregistered" },
          { socketPath: "/tmp/arbitrary.sock" },
          { rootDir: "/tmp" },
        ]) {
          const response = yield* Effect.promise(() =>
            request(env.T3_PYCELLS_LAUNCH_SOCKET!, { ...recipe, ...override }),
          );
          expect(response.error).toBeDefined();
        }
        const responses = yield* Effect.promise(() =>
          Promise.all([
            request(env.T3_PYCELLS_LAUNCH_SOCKET!, recipe),
            request(env.T3_PYCELLS_LAUNCH_SOCKET!, recipe),
          ]),
        );
        expect(responses.every((response) => response.result?.pid !== undefined)).toBe(true);
        const child = yield* Effect.promise(() => ready);
        expect(responses.map((response) => response.result?.pid)).toEqual([child.pid, child.pid]);
        expect(child).toMatchObject({
          ppid: process.pid,
          thread: "thread-1",
          owner: String(process.pid),
          extra: "preserved",
          injected: "host-injected",
        });
      }).pipe(
        Effect.provide(Launcher.layer.pipe(Layer.provide(config))),
        Effect.provideService(HostProcess.Environment, { PYCELLS_HOST_ENV: "host-injected" }),
        Effect.scoped,
      );
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
