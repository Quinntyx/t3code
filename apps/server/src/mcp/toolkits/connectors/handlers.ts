import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as EmailRequests from "../../../email/EmailRequests.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { ConnectorsToolkit } from "./tools.ts";

const EMAIL_OFF = "Email is off on this machine. The user can turn it on in Settings → Email.";

export const layer = McpToolAccess.toLayer(ConnectorsToolkit, {
  external_connectors: McpToolAccess.reads(() =>
    McpInvocationContext.McpInvocationContext.pipe(
      Effect.map((scope) => {
        const enabled = scope.email !== false;
        return {
          connectors: [
            {
              name: "email",
              enabled,
              tool: "compose_email",
              note: enabled
                ? "Drafts an email in a card; the user reviews and sends it from their own account."
                : EMAIL_OFF,
            },
          ],
        };
      }),
    ),
  ),
  compose_email: McpToolAccess.actsAsCaller((request) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      if (scope.email === false) {
        return yield* new OrchestratorMcpFailure({ code: "capability_denied", message: EMAIL_OFF });
      }
      const thread = yield* McpInvocationContext.requireThreadScope(scope, "compose_email");
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
