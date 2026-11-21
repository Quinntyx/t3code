import { AuthOrchestrationReadScope, ThreadId, WS_METHODS, WsRpcGroup } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as RpcTest from "effect/rpc/RpcTest";
import * as RpcAuthorization from "../auth/RpcAuthorization.ts";

const method = WS_METHODS.threadsGetNotebook;
const group = WsRpcGroup.omit(
  ...[...WsRpcGroup.requests.keys()].filter(
    (tag): tag is Exclude<keyof typeof RpcAuthorization.RPC_REQUIRED_SCOPES, typeof method> =>
      tag !== method,
  ),
);
it.effect.each([{ allowed: false }, { allowed: true }])(
  "notebook read authorization: $allowed",
  ({ allowed }) =>
    Effect.gen(function* () {
      let reads = 0;
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(method, () =>
              Effect.sync(() => {
                reads++;
                return { version: 1 as const, kernels: [] };
              }),
            ),
            RpcAuthorization.layer(allowed ? [AuthOrchestrationReadScope] : []),
          ),
        ),
      );
      const result = yield* client[method]({ threadId: ThreadId.make("thread") }).pipe(
        Effect.result,
      );
      expect(reads).toBe(allowed ? 1 : 0);
      if (!allowed)
        expect(result).toMatchObject({
          failure: {
            _tag: "EnvironmentAuthorizationError",
            requiredPermission: AuthOrchestrationReadScope,
          },
        });
    }).pipe(Effect.scoped),
);
