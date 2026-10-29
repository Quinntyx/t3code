import { DeusWorkerReportInput, OrchestratorMcpFailure } from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";
import * as Schema from "effect/Schema";
import * as Bridge from "../../../deus/DeusThreadBridge.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";

export const DeusToolkit = Toolkit.make(
  Tool.make("deus_worker_report", {
    description:
      "Report a result from this authenticated Deus worker's own run. Keep inputId stable when retrying. SILENT records only; WHEN_IDLE and INTERRUPT retain delivery intent until a coordinator is available. External MCP clients cannot report for workers.",
    parameters: DeusWorkerReportInput,
    success: Schema.Struct({}),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [
      Invocation.McpInvocationContext,
      Bridge.DeusThreadBridge,
      Threads.ThreadManagementService,
    ],
  })
    .annotate(Tool.Title, "Report Deus worker result")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);
