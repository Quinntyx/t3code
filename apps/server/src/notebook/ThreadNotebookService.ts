// @effect-diagnostics nodeBuiltinImport:off globalTimersInEffect:off -- One-shot Unix socket I/O has an absolute deadline and interruption cleanup.
import * as NodeCrypto from "node:crypto";
import * as NodeNet from "node:net";
import { PycellsNotebookError, PycellsNotebookSnapshot, type ThreadId } from "@t3tools/contracts";
import { pycellsSocketPath } from "@t3tools/shared/pycells";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { ServerConfig } from "../config.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const RESPONSE_TIMEOUT_MS = 3_000;
const Response = Schema.Struct({
  id: Schema.String,
  result: Schema.optionalKey(PycellsNotebookSnapshot),
  error: Schema.optionalKey(Schema.Struct({ name: Schema.String, message: Schema.String })),
});
const decodeResponse = Schema.decodeUnknownSync(Response);
const empty: PycellsNotebookSnapshot = { version: 1, kernels: [] };

export class ThreadNotebookService extends Context.Service<
  ThreadNotebookService,
  {
    readonly read: (
      threadId: ThreadId,
    ) => Effect.Effect<PycellsNotebookSnapshot, PycellsNotebookError>;
  }
>()("t3/notebook/ThreadNotebookService") {}

const requestSnapshot = Effect.fn("ThreadNotebookService.requestSnapshot")(
  (stateDir: string, threadId: ThreadId) =>
    Effect.callback<PycellsNotebookSnapshot, PycellsNotebookError>((resume) => {
      const id = NodeCrypto.randomUUID();
      const socket = NodeNet.createConnection(pycellsSocketPath(stateDir, threadId));
      let settled = false;
      let size = 0;
      const chunks: Buffer[] = [];
      const finish = (result: Effect.Effect<PycellsNotebookSnapshot, PycellsNotebookError>) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resume(result);
      };
      const fail = (reason: PycellsNotebookError["reason"]) =>
        finish(Effect.fail(new PycellsNotebookError({ threadId, reason })));
      // Absolute deadline, not an inactivity timer: a trickling host must not hold the RPC open.
      const timer = setTimeout(() => fail("timeout"), RESPONSE_TIMEOUT_MS);
      socket.once("connect", () =>
        socket.write(JSON.stringify({ id, op: "notebookSnapshot" }) + "\n"),
      );
      socket.on("data", (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          fail("tooLarge");
          return;
        }
        const newline = chunk.indexOf(10);
        chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline));
        if (newline === -1) return;
        try {
          const response = decodeResponse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
          if (
            response.id !== id ||
            (response.result === undefined) === (response.error === undefined)
          ) {
            fail("invalidResponse");
          } else if (response.error !== undefined) {
            fail("hostError");
          } else if (response.result !== undefined) {
            finish(Effect.succeed(response.result));
          }
        } catch {
          fail("invalidResponse");
        }
      });
      socket.once("error", (error: NodeJS.ErrnoException) => {
        if (size === 0 && (error.code === "ENOENT" || error.code === "ECONNREFUSED"))
          finish(Effect.succeed(empty));
        else fail("unavailable");
      });
      socket.once("end", () => fail("invalidResponse"));
      socket.once("close", () => {
        if (!settled) fail("invalidResponse");
      });
      return Effect.sync(() => {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
      });
    }),
);

const make = Effect.gen(function* () {
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const config = yield* ServerConfig;
  const read = Effect.fn("ThreadNotebookService.read")(function* (threadId: ThreadId) {
    const thread = yield* threads
      .getThreadShell(threadId)
      .pipe(Effect.mapError(() => new PycellsNotebookError({ threadId, reason: "unknownThread" })));
    if (thread === null)
      return yield* new PycellsNotebookError({ threadId, reason: "unknownThread" });
    return yield* requestSnapshot(config.stateDir, threadId);
  });
  return { read };
});

export const layer = Layer.effect(ThreadNotebookService, make);
