import {
  OrchestratorMcpFailure,
  OrchestratorMcpSendEmailInput,
  OrchestratorMcpSendEmailResult,
} from "@t3tools/contracts";
import { McpSchema, Tool, Toolkit } from "effect/ai";

import * as EmailRequests from "../../../email/EmailRequests.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const SendEmailTool = Tool.make("send_email", {
  description:
    "Draft an email in a card and wait. The user reviews, edits and sends it from their own mail account, or discards it. Returns what was sent. Asked to email someone: call this now; do not paste a draft in chat.",
  parameters: OrchestratorMcpSendEmailInput,
  success: OrchestratorMcpSendEmailResult,
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

export const EmailToolkit = Toolkit.make(SendEmailTool);
