import {
  OrchestratorMcpComposeEmailInput,
  OrchestratorMcpComposeEmailResult,
  OrchestratorMcpExternalConnectorsResult,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as EmailRequests from "../../../email/EmailRequests.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

// Listed even while a connector is off, so an agent learns it exists and how the user turns it on.
const ExternalConnectorsTool = Tool.make("external_connectors", {
  description:
    "List T3 Code's external connectors, such as email, whether each is on here, and the tool that uses it. Asked to email, draft an email, or reach someone outside this chat: check here first.",
  success: OrchestratorMcpExternalConnectorsResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [McpInvocationContext.McpInvocationContext],
})
  .annotate(Tool.Title, "List external connectors")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true);

const ComposeEmailTool = Tool.make("compose_email", {
  description:
    "Draft an email in a card and wait. The user reviews, edits and sends it from their own mail account, or discards it. Returns what was sent. Asked to email someone or draft an email: call this now; do not paste a draft in chat.",
  parameters: OrchestratorMcpComposeEmailInput,
  success: OrchestratorMcpComposeEmailResult,
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    EmailRequests.EmailRequests,
  ],
})
  .annotate(Tool.Title, "Draft an email for the user to send")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, McpInvocationContext.hiddenWhileEmailOff);

export const ConnectorsToolkit = Toolkit.make(ExternalConnectorsTool, ComposeEmailTool);
