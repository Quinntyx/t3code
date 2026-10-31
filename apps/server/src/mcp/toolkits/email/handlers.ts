import * as Effect from "effect/Effect";

import * as EmailRequests from "../../../email/EmailRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { EmailToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(EmailToolkit, {
  send_email: McpToolAccess.actsAsCaller((request) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const thread = yield* McpInvocationContext.requireThreadScope(scope, "send_email");
      const emailRequests = yield* EmailRequests.EmailRequests;
      return yield* emailRequests.draft({
        threadId: thread.thread.threadId,
        providerInstanceId: thread.thread.providerInstanceId,
        requestNamespace: scope.requestNamespace,
        request,
      });
    }),
  ),
});
