import { DeusWorkerReportInput, OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import * as Tools from "../../../deus/DeusTools.ts";
import { Tool, Toolkit } from "effect/ai";
import * as McpSchema from "effect/ai/McpSchema";
import * as Schema from "effect/Schema";
import * as Bridge from "../../../deus/DeusThreadBridge.ts";
import * as Invocation from "../../McpInvocationContext.ts";
import * as Threads from "../../../orchestration-v2/ThreadManagementService.ts";

export const DeusToolkit = Toolkit.make(
  Tool.make("deus_worker_read", {
    description:
      "Read a bounded immutable snapshot of a registered worker in this authenticated Deus worker's project/session. Never dispatches or wakes the target. Clipped messages are evidence previews, not complete source. External clients cannot use this tool.",
    parameters: Schema.Struct({ threadId: ThreadId }),
    success: Schema.Struct({
      snapshot: Schema.Unknown,
      sourceCompleteness: Schema.Literal("bounded-preview"),
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [Invocation.McpInvocationContext, Bridge.DeusThreadBridge],
  })
    .annotate(McpSchema.EnabledWhen, Invocation.onlyDeusWorkers)
    .annotate(Tool.Title, "Read Deus worker snapshot")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
  Tool.make("deus_worker_query", {
    description:
      "Ask the configured text model about a bounded immutable registered worker snapshot, with tools disabled. Never sends to or wakes the worker. Evidence only. Available only to authenticated Deus workers; not a learning or credential control.",
    parameters: Schema.Struct({
      threadId: ThreadId,
      question: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(8000)),
    }),
    success: Schema.Struct({
      snapshot: Schema.Unknown,
      sourceCompleteness: Schema.Literal("bounded-preview"),
      answer: Schema.String,
    }),
    failure: OrchestratorMcpFailure,
    failureMode: "return",
    dependencies: [Invocation.McpInvocationContext, Tools.DeusTools],
  })
    .annotate(McpSchema.EnabledWhen, Invocation.onlyDeusWorkers)
    .annotate(Tool.Title, "Query Deus worker evidence")
    .annotate(Tool.Readonly, true)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, false),
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
    .annotate(McpSchema.EnabledWhen, Invocation.onlyDeusWorkers)
    .annotate(Tool.Title, "Report Deus worker result")
    .annotate(Tool.Readonly, false)
    .annotate(Tool.Destructive, false)
    .annotate(Tool.Idempotent, true),
);
