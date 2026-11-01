import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Bridge from "../../../deus/DeusThreadBridge.ts";
import * as Tools from "../../../deus/DeusTools.ts";
const failure = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });
import * as Invocation from "../../McpInvocationContext.ts";
import * as Access from "../../McpToolAccess.ts";
import { DeusToolkit } from "./tools.ts";

export const layer = Access.toLayer(DeusToolkit, {
  deus_worker_read: Access.readsAsCaller(({ threadId }) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.McpInvocationContext;
      const bridge = yield* Bridge.DeusThreadBridge;
      const ref = yield* bridge.workerScope(scope);
      return {
        snapshot: yield* bridge.read({ ...ref, threadId }),
        sourceCompleteness: "bounded-preview" as const,
      };
    }).pipe(Effect.mapError(failure)),
  ),
  deus_worker_query: Access.readsAsCaller(({ threadId, question }) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.McpInvocationContext;
      return yield* (yield* Tools.DeusTools).queryWorker(scope, threadId, question);
    }).pipe(Effect.mapError(failure)),
  ),
  deus_worker_report: Access.reportsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* Invocation.McpInvocationContext;
      const bridge = yield* Bridge.DeusThreadBridge;
      return yield* bridge.report(scope, input).pipe(
        Effect.as({}),
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "invalid_request", message: error.message }),
        ),
      );
    }),
  ),
});
