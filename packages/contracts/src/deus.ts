import * as Schema from "effect/Schema";
import { OrchestrationV2Subagent } from "./orchestrationV2.ts";
import {
  DeusAttachmentId,
  DeusInputId,
  DeusMemoryId,
  DeusObservationId,
  DeusPonderId,
  DeusSessionId,
  DeusTaskId,
  DeusTranscriptId,
  EnvironmentId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  RunId,
  SecretRef,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { AuthEnvironmentScope } from "./auth.ts";
import { ModelSelection } from "./modelSelection.ts";
import { RuntimeMode, ProviderInteractionMode } from "./providerPolicy.ts";
import { DeusSettings, DeusSettingsPatch } from "./settings.ts";

export const DEUS_PROTOCOL_VERSION = 1;

export const DeusScope = Schema.Struct({ environmentId: EnvironmentId, projectId: ProjectId });
export type DeusScope = typeof DeusScope.Type;

export const DeusSessionRef = Schema.Struct({ ...DeusScope.fields, sessionId: DeusSessionId });
export type DeusSessionRef = typeof DeusSessionRef.Type;

export const DeusCursor = NonNegativeInt.pipe(Schema.brand("DeusCursor"));
export type DeusCursor = typeof DeusCursor.Type;

export const DeusConversation = PositiveInt.pipe(Schema.brand("DeusConversation"));
export type DeusConversation = typeof DeusConversation.Type;

export const DeusCapabilities = Schema.Union([
  Schema.Struct({
    available: Schema.Literal(false),
    protocolVersion: Schema.Literal(DEUS_PROTOCOL_VERSION),
    reason: Schema.Literals(["unsupported", "disabled", "not-configured"]),
  }),
  Schema.Struct({
    available: Schema.Literal(true),
    protocolVersion: Schema.Literal(DEUS_PROTOCOL_VERSION),
    text: Schema.Literal(true),
    liveAudio: Schema.Boolean,
    learning: Schema.Boolean,
    reportModes: Schema.Array(Schema.Literals(["SILENT", "WHEN_IDLE", "INTERRUPT"])),
  }),
]);
export type DeusCapabilities = typeof DeusCapabilities.Type;

export const DEUS_UNAVAILABLE: DeusCapabilities = {
  available: false,
  protocolVersion: DEUS_PROTOCOL_VERSION,
  reason: "unsupported",
};

// Legacy servers omit this field; never probe an unadvertised Deus RPC.
export function resolveDeusCapabilities(config: { readonly deus?: DeusCapabilities }) {
  return config.deus ?? DEUS_UNAVAILABLE;
}

export class DeusUnavailableError extends Schema.TaggedError<DeusUnavailableError>()(
  "DeusUnavailableError",
  {
    message: TrimmedNonEmptyString,
    reason: Schema.Literals(["unsupported", "disabled", "not-configured"]),
  },
) {}
export class DeusPermissionError extends Schema.TaggedError<DeusPermissionError>()(
  "DeusPermissionError",
  { message: TrimmedNonEmptyString, requiredScope: AuthEnvironmentScope },
) {}
export class DeusLeaseError extends Schema.TaggedError<DeusLeaseError>()("DeusLeaseError", {
  message: TrimmedNonEmptyString,
  reason: Schema.Literals(["occupied", "expired", "stale-generation", "not-owner"]),
}) {}
export class DeusToolError extends Schema.TaggedError<DeusToolError>()("DeusToolError", {
  message: TrimmedNonEmptyString,
  tool: TrimmedNonEmptyString,
  retryable: Schema.Boolean,
}) {}
export class DeusModelError extends Schema.TaggedError<DeusModelError>()("DeusModelError", {
  message: TrimmedNonEmptyString,
  reason: Schema.Literals(["unavailable", "authentication", "rate-limit", "provider-failure"]),
}) {}
export class DeusTransportError extends Schema.TaggedError<DeusTransportError>()(
  "DeusTransportError",
  {
    message: TrimmedNonEmptyString,
    reason: Schema.Literals([
      "disconnected",
      "backpressure",
      "invalid-sequence",
      "stale-response",
      "invalid-pcm",
    ]),
  },
) {}
export class DeusStateError extends Schema.TaggedError<DeusStateError>()("DeusStateError", {
  message: TrimmedNonEmptyString,
  reason: Schema.Literals(["not-found", "scope-mismatch", "cursor-expired", "conflict"]),
}) {}
export const DeusError = Schema.Union([
  DeusUnavailableError,
  DeusPermissionError,
  DeusLeaseError,
  DeusToolError,
  DeusModelError,
  DeusTransportError,
  DeusStateError,
]);
export type DeusError = typeof DeusError.Type;

export const DeusLiveOrigin = Schema.Struct({
  type: Schema.Literal("live"),
  attachmentId: DeusAttachmentId,
  generation: PositiveInt,
  turnId: TrimmedNonEmptyString,
});
export const DeusTranscriptOrigin = Schema.Union([
  DeusLiveOrigin,
  Schema.Struct({
    ...DeusLiveOrigin.fields,
    type: Schema.Literal("report"),
    sourceCursor: DeusCursor,
    taskId: DeusTaskId,
    threadId: ThreadId,
    runId: RunId,
  }),
]);

export const DeusTranscript = Schema.Struct({
  id: DeusTranscriptId,
  conversation: DeusConversation,
  inputId: DeusInputId,
  role: Schema.Literals(["human", "assistant"]),
  origin: Schema.optional(DeusTranscriptOrigin),
  error: Schema.optional(
    Schema.Struct({
      code: Schema.Literals([
        "authority",
        "configuration",
        "provider",
        "bounds",
        "continuation",
        "reply-debt",
      ]),
      recoverable: Schema.Literal(true),
    }),
  ),
  text: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type DeusTranscript = typeof DeusTranscript.Type;

export const DeusReportMode = Schema.Literals(["SILENT", "WHEN_IDLE", "INTERRUPT"]);
export type DeusReportMode = typeof DeusReportMode.Type;

export const DeusWorkerReportInput = Schema.Struct({
  inputId: DeusInputId,
  runId: RunId,
  subagentId: Schema.optional(OrchestrationV2Subagent.fields.id),
  mode: DeusReportMode,
  text: Schema.Trimmed.check(Schema.isMinLength(1), Schema.isMaxLength(16000)),
});
export type DeusWorkerReportInput = typeof DeusWorkerReportInput.Type;

export const DeusWorkerLink = Schema.Struct({
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  parentTaskId: Schema.NullOr(DeusTaskId),
  parentThreadId: Schema.NullOr(ThreadId),
  model: ModelSelection,
  runtimeMode: RuntimeMode,
});
export type DeusWorkerLink = typeof DeusWorkerLink.Type;

export const DeusDescendant = Schema.Struct({
  id: OrchestrationV2Subagent.fields.id,
  threadId: ThreadId,
  runId: Schema.NullOr(RunId),
  origin: OrchestrationV2Subagent.fields.origin,
  childThreadId: Schema.NullOr(ThreadId),
  nativeTaskRef: OrchestrationV2Subagent.fields.nativeTaskRef,
  status: OrchestrationV2Subagent.fields.status,
});
export type DeusDescendant = typeof DeusDescendant.Type;

export const DeusTask = Schema.Struct({
  id: DeusTaskId,
  inputId: DeusInputId,
  conversation: DeusConversation,
  title: TrimmedNonEmptyString,
  status: Schema.Literals(["pending", "running", "waiting", "completed", "failed", "cancelled"]),
  workers: Schema.Array(DeusWorkerLink),
  descendants: Schema.optional(Schema.Array(DeusDescendant)),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DeusTask = typeof DeusTask.Type;

export const DeusReport = Schema.Struct({
  cursor: DeusCursor,
  taskId: DeusTaskId,
  threadId: ThreadId,
  runId: RunId,
  conversation: Schema.optional(DeusConversation),
  subagentId: Schema.optional(OrchestrationV2Subagent.fields.id),
  mode: DeusReportMode,
  text: TrimmedNonEmptyString,
  createdAt: IsoDateTime,
});
export type DeusReport = typeof DeusReport.Type;

export const DeusSourceRef = Schema.Struct({ ...DeusSessionRef.fields, cursor: DeusCursor });
export type DeusSourceRef = typeof DeusSourceRef.Type;

export const DeusObservationKind = Schema.Literals([
  "context",
  "report",
  "correction",
  "proposed-preference",
  "speculation",
]);
export type DeusObservationKind = typeof DeusObservationKind.Type;

export const DeusObservation = Schema.Struct({
  id: DeusObservationId,
  kind: Schema.optional(DeusObservationKind),
  source: Schema.optional(DeusSourceRef),
  conversation: DeusConversation,
  text: TrimmedNonEmptyString,
  inputId: Schema.NullOr(DeusInputId),
  taskId: Schema.NullOr(DeusTaskId),
  supersedes: Schema.NullOr(DeusObservationId),
  createdAt: IsoDateTime,
});
export type DeusObservation = typeof DeusObservation.Type;

export const DeusMemory = Schema.Struct({
  id: DeusMemoryId,
  revision: PositiveInt,
  text: TrimmedNonEmptyString,
  observationIds: Schema.Array(DeusObservationId),
  ponderId: Schema.NullOr(DeusPonderId),
  supersedes: Schema.NullOr(DeusMemoryId),
  removedAt: Schema.NullOr(IsoDateTime),
  updatedAt: IsoDateTime,
  provenance: Schema.optional(
    Schema.Struct({
      scope: Schema.Literals(["project", "environment", "global"]),
      sources: Schema.Array(DeusSourceRef),
      commit: TrimmedNonEmptyString,
    }),
  ),
});
export type DeusMemory = typeof DeusMemory.Type;

export const DeusPonderReceipt = Schema.Struct({
  id: DeusPonderId,
  snapshotCursor: DeusCursor,
  observationIds: Schema.Array(DeusObservationId),
  status: Schema.Literals(["pending", "running", "succeeded", "failed", "blocked"]),
  writtenMemoryIds: Schema.Array(DeusMemoryId),
  acknowledgedObservationIds: Schema.Array(DeusObservationId),
  error: Schema.NullOr(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  completedAt: Schema.NullOr(IsoDateTime),
});
export type DeusPonderReceipt = typeof DeusPonderReceipt.Type;

export const DeusSession = Schema.Struct({
  ...DeusSessionRef.fields,
  conversation: DeusConversation,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
});
export type DeusSession = typeof DeusSession.Type;

// Only final text and domain changes are durable; media and partial transcripts use the attachment stream.
export const DeusDurableChange = Schema.Union([
  Schema.Struct({ type: Schema.Literal("conversation-reset"), conversation: DeusConversation }),
  Schema.Struct({ type: Schema.Literal("transcript"), transcript: DeusTranscript }),
  Schema.Struct({ type: Schema.Literal("task"), task: DeusTask }),
  Schema.Struct({ type: Schema.Literal("report"), report: DeusReport }),
  Schema.Struct({ type: Schema.Literal("observation"), observation: DeusObservation }),
  Schema.Struct({ type: Schema.Literal("memory"), memory: DeusMemory }),
  Schema.Struct({ type: Schema.Literal("ponder"), receipt: DeusPonderReceipt }),
]);
export type DeusDurableChange = typeof DeusDurableChange.Type;

export const DeusSnapshot = Schema.Struct({
  session: DeusSession,
  cursor: DeusCursor,
  transcripts: Schema.Array(DeusTranscript),
  tasks: Schema.Array(DeusTask),
  reports: Schema.Array(DeusReport),
  observations: Schema.Array(DeusObservation),
  memories: Schema.Array(DeusMemory),
  ponderReceipts: Schema.Array(DeusPonderReceipt),
});
export type DeusSnapshot = typeof DeusSnapshot.Type;

export const DeusDelta = Schema.Struct({
  ...DeusSessionRef.fields,
  previousCursor: DeusCursor,
  cursor: DeusCursor,
  change: DeusDurableChange,
});
export type DeusDelta = typeof DeusDelta.Type;

export const DeusOpenInput = Schema.Struct({ ...DeusScope.fields, inputId: DeusInputId });
export type DeusOpenInput = typeof DeusOpenInput.Type;

export const DeusResetConversationInput = Schema.Struct({
  ...DeusSessionRef.fields,
  inputId: DeusInputId,
  conversation: DeusConversation,
});
export type DeusResetConversationInput = typeof DeusResetConversationInput.Type;

export const DeusSubscriptionInput = Schema.Struct({ ...DeusSessionRef.fields, after: DeusCursor });
export type DeusSubscriptionInput = typeof DeusSubscriptionInput.Type;
export const DeusSubscriptionEvent = Schema.Union([
  Schema.Struct({ type: Schema.Literal("snapshot"), snapshot: DeusSnapshot }),
  Schema.Struct({ type: Schema.Literal("delta"), delta: DeusDelta }),
]);

export type DeusSubscriptionEvent = typeof DeusSubscriptionEvent.Type;

export const DeusInput = Schema.Struct({
  ...DeusSessionRef.fields,
  inputId: DeusInputId,
  conversation: DeusConversation,
  text: TrimmedNonEmptyString,
});
export type DeusInput = typeof DeusInput.Type;
export const DeusHumanCeiling = Schema.Struct({
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
  allowWorktree: Schema.Boolean,
});
export type DeusHumanCeiling = typeof DeusHumanCeiling.Type;
export const DeusHumanInput = Schema.Struct({ ...DeusInput.fields, authority: DeusHumanCeiling });
export type DeusHumanInput = typeof DeusHumanInput.Type;

export const DeusInputReceipt = Schema.Struct({
  inputId: DeusInputId,
  cursor: DeusCursor,
  status: Schema.Literals(["accepted", "replayed"]),
});

export type DeusInputReceipt = typeof DeusInputReceipt.Type;

export const DeusTaskLaunchInput = Schema.Struct({
  ...DeusSessionRef.fields,
  inputId: DeusInputId,
  conversation: DeusConversation,
  prompt: TrimmedNonEmptyString,
  kind: Schema.Literals(["work", "research"]),
  model: ModelSelection,
  runtimeMode: RuntimeMode,
  workspace: Schema.Literals(["project", "worktree"]),
});
export type DeusTaskLaunchInput = typeof DeusTaskLaunchInput.Type;
export const DeusTaskActionInput = Schema.Struct({
  ...DeusSessionRef.fields,
  inputId: DeusInputId,
  taskId: DeusTaskId,
  action: Schema.Union([
    Schema.Struct({
      type: Schema.Literals(["send", "queue", "steer", "query"]),
      text: TrimmedNonEmptyString,
    }),
    Schema.Struct({ type: Schema.Literals(["interrupt", "retry", "continue"]) }),
  ]),
});
export type DeusTaskActionInput = typeof DeusTaskActionInput.Type;
export const DeusTaskActionResult = Schema.Struct({
  receipt: DeusInputReceipt,
  task: DeusTask,
  answer: Schema.NullOr(TrimmedNonEmptyString),
});

export type DeusTaskActionResult = typeof DeusTaskActionResult.Type;
export const DeusHumanTaskLaunchInput = Schema.Struct({
  ...DeusTaskLaunchInput.fields,
  authority: DeusHumanCeiling,
});
export const DeusHumanTaskActionInput = Schema.Struct({
  ...DeusTaskActionInput.fields,
  authority: DeusHumanCeiling,
});

export const DeusMemorySearchInput = Schema.Struct({
  ...DeusSessionRef.fields,
  query: TrimmedNonEmptyString,
  limit: PositiveInt.check(Schema.isLessThanOrEqualTo(20)),
  scopes: Schema.optional(
    Schema.Array(Schema.Literals(["project", "environment", "global"])).check(
      Schema.isMaxLength(3),
    ),
  ),
});
export type DeusMemorySearchInput = typeof DeusMemorySearchInput.Type;
export const DeusMemoryReadInput = Schema.Struct({
  ...DeusSessionRef.fields,
  memoryId: DeusMemoryId,
  scope: Schema.optional(Schema.Literals(["project", "environment", "global"])),
});
export type DeusMemoryReadInput = typeof DeusMemoryReadInput.Type;
export const DeusMemoryCorrectionInput = Schema.Struct({
  ...DeusSessionRef.fields,
  inputId: DeusInputId,
  memoryId: DeusMemoryId,
  expectedRevision: PositiveInt,
  correction: Schema.NullOr(TrimmedNonEmptyString),
});
export type DeusMemoryCorrectionInput = typeof DeusMemoryCorrectionInput.Type;

// Human-facing RPC only; exclude this from coordinator and worker model tool allowlists.
export const DeusPonderInput = Schema.Struct({
  ...DeusSessionRef.fields,
  inputId: DeusInputId,
  snapshotCursor: DeusCursor,
});

export type DeusPonderInput = typeof DeusPonderInput.Type;

export const DeusAttachment = Schema.Struct({
  ...DeusSessionRef.fields,
  attachmentId: DeusAttachmentId,
  generation: PositiveInt,
  responseEpoch: NonNegativeInt,
  expiresAt: IsoDateTime,
});
export type DeusAttachment = typeof DeusAttachment.Type;

const AttachmentEnvelope = {
  ...DeusSessionRef.fields,
  attachmentId: DeusAttachmentId,
  generation: PositiveInt,
  responseEpoch: NonNegativeInt,
  sequence: NonNegativeInt,
};

export const DEUS_MAX_TRANSIENT_TEXT_LENGTH = 16_384;
export const DEUS_MAX_PCM_BYTES = 32_000;
const PcmBase64 = TrimmedNonEmptyString.check(
  Schema.isMaxLength(Math.ceil(DEUS_MAX_PCM_BYTES / 3) * 4),
  Schema.isPattern(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
  Schema.makeFilter((value: string) => {
    const bytes = (value.length / 4) * 3 - (value.endsWith("==") ? 2 : value.endsWith("=") ? 1 : 0);
    return bytes > 0 && bytes <= DEUS_MAX_PCM_BYTES && bytes % 2 === 0;
  }),
);

export const DeusPcmInput = Schema.Struct({
  ...AttachmentEnvelope,
  type: Schema.Literal("pcm"),
  encoding: Schema.Literal("pcm16le"),
  channels: Schema.Literal(1),
  sampleRate: Schema.Literal(16_000),
  data: PcmBase64,
});
export type DeusPcmInput = typeof DeusPcmInput.Type;

export const DeusMediaOutput = Schema.Union([
  Schema.Struct({
    ...AttachmentEnvelope,
    type: Schema.Literal("pcm"),
    encoding: Schema.Literal("pcm16le"),
    channels: Schema.Literal(1),
    sampleRate: Schema.Literal(24_000),
    data: PcmBase64,
  }),
  Schema.Struct({
    ...AttachmentEnvelope,
    type: Schema.Literal("control"),
    state: Schema.Literals(["listening", "speaking", "interrupted", "disconnected"]),
  }),
  Schema.Struct({
    ...AttachmentEnvelope,
    type: Schema.Literal("partial-transcript"),
    role: Schema.Literals(["human", "assistant"]),
    text: Schema.String.check(Schema.isMaxLength(DEUS_MAX_TRANSIENT_TEXT_LENGTH)),
  }),
  Schema.Struct({ ...AttachmentEnvelope, type: Schema.Literal("turn-end") }),
  Schema.Struct({ ...AttachmentEnvelope, type: Schema.Literal("error"), error: DeusError }),
]);
export type DeusMediaOutput = typeof DeusMediaOutput.Type;

export const DeusAttachInput = Schema.Struct({
  ...DeusSessionRef.fields,
  inputId: DeusInputId,
  takeover: Schema.Boolean,
});
export type DeusAttachInput = typeof DeusAttachInput.Type;
export const DeusHumanAttachInput = Schema.Struct({
  ...DeusAttachInput.fields,
  authority: DeusHumanCeiling,
});
export const DeusAttachmentInput = Schema.Struct({
  ...DeusSessionRef.fields,
  attachmentId: DeusAttachmentId,
  generation: PositiveInt,
});
export type DeusAttachmentInput = typeof DeusAttachmentInput.Type;
export const DeusMediaControlInput = Schema.Struct({
  ...AttachmentEnvelope,
  action: Schema.Literals(["mute", "resume", "interrupt-response"]),
});
export type DeusMediaControlInput = typeof DeusMediaControlInput.Type;

export const DeusConfiguration = Schema.Struct({
  ...DeusScope.fields,
  settings: DeusSettings,
  credentialConfigured: Schema.Boolean,
});
export type DeusConfiguration = typeof DeusConfiguration.Type;

export const DeusUpdateSettingsInput = Schema.Struct({
  ...DeusScope.fields,
  patch: DeusSettingsPatch,
});
export type DeusUpdateSettingsInput = typeof DeusUpdateSettingsInput.Type;

// Consume a one-use secret reference, or clear the stored credential with null.
export const DeusCredentialInput = Schema.Struct({
  ...DeusScope.fields,
  secretRef: Schema.NullOr(SecretRef),
});
export type DeusCredentialInput = typeof DeusCredentialInput.Type;
