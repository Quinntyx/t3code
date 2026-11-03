// @effect-diagnostics nodeBuiltinImport:off -- These fixtures exercise real Unix sockets and their teardown.
import * as NodeNet from "node:net";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import { pycellsSocketPath } from "@t3tools/shared/pycells";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import { ServerConfig } from "../config.ts";
import * as ServerConfigModule from "../config.ts";
import { liveThreadShell } from "../mcp/McpToolAccess.testkit.ts";
import * as ThreadNotebookService from "./ThreadNotebookService.ts";

const threadId = ThreadId.make("notebook-thread");
const snapshot = {
  version: 1,
  kernels: [
    {
      id: "k1",
      name: "analysis",
      notebookPath: "/private/analysis.ipynb",
      running: true,
      cells: [
        {
          id: "stable-cell",
          index: 1,
          cellType: "code",
          source: "print(42)",
          executionCount: 1,
          outputs: [
            { kind: "text", text: "42\n" },
            { kind: "image", mimeType: "image/png", data: "aGVsbG8=" },
          ],
        },
      ],
    },
  ],
};

const sandbox = Effect.acquireRelease(
  Effect.promise(() => NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-notebook-test-"))),
  (directory) => Effect.promise(() => NodeFSP.rmdir(directory)),
);
const serviceLayer = (stateDir: string, known = true) =>
  ThreadNotebookService.layer.pipe(
    Layer.provide(
      Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(known ? liveThreadShell(threadId) : null),
      }),
    ),
    Layer.provide(
      Layer.effect(
        ServerConfig,
        ServerConfig.pipe(Effect.map((config) => ({ ...config, stateDir }))),
      ).pipe(
        Layer.provide(
          ServerConfigModule.layerTest(process.cwd(), { prefix: "t3-notebook-config-" }),
        ),
        Layer.provide(NodeServices.layer),
      ),
    ),
  );
const host = (
  stateDir: string,
  respond: (socket: NodeNet.Socket, request: { id: string; op: string }) => void,
) =>
  Effect.acquireRelease(
    Effect.promise(async () => {
      const socketPath = pycellsSocketPath(stateDir, threadId);
      await NodeFSP.mkdir(NodePath.dirname(socketPath), { recursive: true, mode: 0o700 });
      const server = NodeNet.createServer((socket) => {
        let input = "";
        socket.on("data", (data) => {
          input += data.toString();
          if (input.includes("\n")) respond(socket, JSON.parse(input.trim()));
        });
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socketPath, resolve);
      });
      return server;
    }),
    (server) =>
      Effect.promise(
        () =>
          new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve())),
          ),
      ),
  );

const read = ThreadNotebookService.ThreadNotebookService.pipe(
  Effect.flatMap((service) => service.read(threadId)),
);

describe("thread notebooks", () => {
  it.live("reads only the requested thread and environment over one-shot JSON", () =>
    Effect.gen(function* () {
      const directory = yield* sandbox;
      let requests = 0;
      yield* host(directory, (socket, request) => {
        requests++;
        expect(request.op).toBe("notebookSnapshot");
        socket.end(JSON.stringify({ id: request.id, result: snapshot }) + "\n");
      });
      expect(yield* read.pipe(Effect.provide(serviceLayer(directory)))).toEqual(snapshot);
      expect(yield* read.pipe(Effect.provide(serviceLayer(directory + "-other")))).toEqual({
        version: 1,
        kernels: [],
      });
      expect(pycellsSocketPath(directory, threadId)).not.toBe(
        pycellsSocketPath(directory, "other-thread"),
      );
      expect(
        yield* read.pipe(Effect.provide(serviceLayer(directory, false)), Effect.flip),
      ).toMatchObject({ reason: "unknownThread" });
      expect(requests).toBe(1);
    }).pipe(Effect.scoped),
  );

  it.live("accepts bounded multi-megabyte image output", () =>
    Effect.gen(function* () {
      const directory = yield* sandbox;
      const image = {
        kind: "image",
        mimeType: "image/png",
        data: Buffer.alloc(3 * 1024 * 1024).toString("base64"),
      };
      const large = {
        ...snapshot,
        kernels: [
          {
            ...snapshot.kernels[0],
            cells: [{ ...snapshot.kernels[0]!.cells[0], outputs: [image] }],
          },
        ],
      };
      yield* host(directory, (socket, request) =>
        socket.end(JSON.stringify({ id: request.id, result: large }) + "\n"),
      );
      expect(yield* read.pipe(Effect.provide(serviceLayer(directory)))).toEqual(large);
    }).pipe(Effect.scoped),
  );

  it.live("returns empty when no host exists", () =>
    Effect.gen(function* () {
      const directory = yield* sandbox;
      expect(yield* read.pipe(Effect.provide(serviceLayer(directory)))).toEqual({
        version: 1,
        kernels: [],
      });
    }).pipe(Effect.scoped),
  );

  it.live.each([
    { label: "malformed JSON", reply: () => "not-json\n", reason: "invalidResponse" },
    {
      label: "wrong id",
      reply: () => JSON.stringify({ id: "wrong", result: snapshot }) + "\n",
      reason: "invalidResponse",
    },
    {
      label: "bad version",
      reply: (id: string) => JSON.stringify({ id, result: { ...snapshot, version: 2 } }) + "\n",
      reason: "invalidResponse",
    },
    {
      label: "bad cell index",
      reply: (id: string) =>
        JSON.stringify({
          id,
          result: {
            version: 1,
            kernels: [
              { ...snapshot.kernels[0], cells: [{ ...snapshot.kernels[0]!.cells[0], index: 0 }] },
            ],
          },
        }) + "\n",
      reason: "invalidResponse",
    },
    {
      label: "host error",
      reply: (id: string) =>
        JSON.stringify({ id, error: { name: "CorruptNotebook", message: "private content" } }) +
        "\n",
      reason: "hostError",
    },
    { label: "truncated response", reply: () => "{", reason: "invalidResponse" },
    {
      label: "oversized response",
      reply: () => "x".repeat(16 * 1024 * 1024 + 1),
      reason: "tooLarge",
    },
  ])("rejects $label visibly", ({ reply, reason }) =>
    Effect.gen(function* () {
      const directory = yield* sandbox;
      yield* host(directory, (socket, request) => socket.end(reply(request.id)));
      const error = yield* read.pipe(Effect.provide(serviceLayer(directory)), Effect.flip);
      expect(error).toMatchObject({ _tag: "PycellsNotebookError", reason });
      expect(error.message).not.toContain("private content");
    }).pipe(Effect.scoped),
  );

  it.live("bounds a host that never replies and closes its socket", () =>
    Effect.gen(function* () {
      const directory = yield* sandbox;
      yield* host(directory, () => {});
      expect(yield* read.pipe(Effect.provide(serviceLayer(directory)), Effect.flip)).toMatchObject({
        reason: "timeout",
      });
    }).pipe(Effect.scoped),
  );

  it.live("closes the socket on interruption", () =>
    Effect.gen(function* () {
      const directory = yield* sandbox;
      let connected!: () => void;
      let closed!: () => void;
      const connection = new Promise<void>((resolve) => {
        connected = resolve;
      });
      const closure = new Promise<void>((resolve) => {
        closed = resolve;
      });
      yield* host(directory, (socket) => {
        socket.once("close", closed);
        connected();
      });
      const fiber = yield* read.pipe(Effect.provide(serviceLayer(directory)), Effect.forkScoped);
      yield* Effect.promise(() => connection);
      yield* Fiber.interrupt(fiber);
      yield* Effect.promise(() => closure);
    }).pipe(Effect.scoped),
  );
});
