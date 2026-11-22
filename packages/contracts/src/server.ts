import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { AcpRegistryUrlAuthAction } from "./acpRegistry.ts";
import {
  type EnvironmentMachineKind,
  ExecutionEnvironmentDescriptor,
  ServerSelfUpdateMethod,
} from "./environment.ts";
import { AuthClientPresentationMetadata, ServerAuthDescriptor } from "./auth.ts";
import {
  ForwardCompatibleArray,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  KeybindingCommand,
  KeybindingValue,
  KeybindingWhen,
  ResolvedKeybindingsConfig,
} from "./keybindings.ts";
import { EditorId, FileManagerRevealKind, RemoteOpenTarget } from "./editor.ts";
import { ManagedPolicySummary } from "./managedPolicy.ts";
import { ModelCapabilities, ProviderOptionDescriptor } from "./model.ts";
import { RuntimeMode } from "./providerPolicy.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import {
  ServerProviderUsageLimits,
  ServerProviderUsageRoute,
  ServerProviderUsageSource,
  UsageLimitSourceSnapshots,
} from "./providerUsageLimits.ts";
import { ServerSettings } from "./settings.ts";
import { DesktopUpdateChannelSchema } from "./ipc.ts";

const KeybindingsMalformedConfigIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.malformed-config"),
  message: TrimmedNonEmptyString,
});

const KeybindingsInvalidEntryIssue = Schema.Struct({
  kind: Schema.Literal("keybindings.invalid-entry"),
  message: TrimmedNonEmptyString,
  index: Schema.Number,
});

export const ServerConfigIssue = Schema.Union([
  KeybindingsMalformedConfigIssue,
  KeybindingsInvalidEntryIssue,
]);
export type ServerConfigIssue = typeof ServerConfigIssue.Type;

const ServerConfigIssues = ForwardCompatibleArray(ServerConfigIssue);

export const ServerProviderState = Schema.Literals(["ready", "warning", "error", "disabled"]);
export type ServerProviderState = typeof ServerProviderState.Type;

export const ServerProviderAuthStatus = Schema.Literals([
  "authenticated",
  "unauthenticated",
  "unknown",
]);
export type ServerProviderAuthStatus = typeof ServerProviderAuthStatus.Type;

export const ServerProviderAuth = Schema.Struct({
  status: ServerProviderAuthStatus,
  type: Schema.optional(TrimmedNonEmptyString),
  label: Schema.optional(TrimmedNonEmptyString),
  email: Schema.optional(TrimmedNonEmptyString),
  action: Schema.optional(AcpRegistryUrlAuthAction),
  canLogout: Schema.optional(Schema.Boolean),
  subscriptionSharing: Schema.optional(Schema.Boolean),
  profileId: Schema.optional(TrimmedNonEmptyString),
  workspaceId: Schema.optional(TrimmedNonEmptyString),
  /** Origin of the custom endpoint the instance sends its requests to. */
  endpoint: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderAuth = typeof ServerProviderAuth.Type;

export const ServerProviderModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  shortName: Schema.optional(TrimmedNonEmptyString),
  subProvider: Schema.optional(TrimmedNonEmptyString),
  aliases: Schema.optional(Schema.Array(TrimmedNonEmptyString)),
  badge: Schema.optional(Schema.Literal("new")),
  isCustom: Schema.Boolean,
  isDefault: Schema.optional(Schema.Boolean),
  isLegacy: Schema.optional(Schema.Boolean),
  // False when the provider can run this model in sessions but not for
  // application text generation. Absent means supported.
  supportsTextGeneration: Schema.optional(Schema.Boolean),
  capabilities: Schema.NullOr(ModelCapabilities),
});
export type ServerProviderModel = typeof ServerProviderModel.Type;

/** A backend a provider's models run on, such as one of fx's. */
export const ServerProviderSubProvider = Schema.Struct({
  name: TrimmedNonEmptyString,
  /** Why none of its models can run now, such as a signed-out backend. */
  unavailableReason: Schema.optional(TrimmedNonEmptyString),
});
export type ServerProviderSubProvider = typeof ServerProviderSubProvider.Type;

export const ServerProviderUpdateRequiredModel = Schema.Struct({
  slug: TrimmedNonEmptyString,
  name: TrimmedNonEmptyString,
  badge: Schema.optional(Schema.Literal("new")),
  minVersion: TrimmedNonEmptyString,
});
export type ServerProviderUpdateRequiredModel = typeof ServerProviderUpdateRequiredModel.Type;

export const ServerProviderSlashCommandInput = Schema.Struct({
  hint: TrimmedNonEmptyString,
});
export type ServerProviderSlashCommandInput = typeof ServerProviderSlashCommandInput.Type;

export const ServerProviderSlashCommand = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  input: Schema.optional(ServerProviderSlashCommandInput),
});
export type ServerProviderSlashCommand = typeof ServerProviderSlashCommand.Type;

export const ServerProviderSkill = Schema.Struct({
  name: TrimmedNonEmptyString,
  description: Schema.optional(TrimmedNonEmptyString),
  path: TrimmedNonEmptyString,
  scope: Schema.optional(TrimmedNonEmptyString),
  enabled: Schema.Boolean,
  displayName: Schema.optional(TrimmedNonEmptyString),
  shortDescription: Schema.optional(TrimmedNonEmptyString),
  /** Claude disable-model-invocation: only users can invoke; composers must offer a slash command. */
  userInvocationOnly: Schema.optional(Schema.Boolean),
  /** Claude user-invocable:false: only agents can invoke; composers must hide the slash command. */
  userInvocable: Schema.optional(Schema.Boolean),
});
export type ServerProviderSkill = typeof ServerProviderSkill.Type;

export const ServerProviderWorkspaceSnapshot = Schema.Struct({
  cwd: TrimmedNonEmptyString,
  checkedAt: IsoDateTime,
  slashCommands: Schema.Array(ServerProviderSlashCommand),
  slashCommandsPending: Schema.optional(Schema.Boolean),
  skills: Schema.Array(ServerProviderSkill),
  optionDescriptors: Schema.optional(Schema.Array(ProviderOptionDescriptor)),
  // Absent means the provider's machine `models`, which keeps most snapshots small.
  models: Schema.optional(Schema.Array(ServerProviderModel)),
  modelsPending: Schema.optional(Schema.Boolean),
});
export type ServerProviderWorkspaceSnapshot = typeof ServerProviderWorkspaceSnapshot.Type;

export const PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS = 5 * 60_000;

export function isProviderWorkspaceSnapshotCurrent(
  snapshot: Pick<ServerProviderWorkspaceSnapshot, "checkedAt">,
  nowMs: number,
): boolean {
  return nowMs - Date.parse(snapshot.checkedAt) < PROVIDER_WORKSPACE_SNAPSHOT_TTL_MS;
}

/** A pending snapshot keeps what it found before and is rescanned before its TTL. */
export function isProviderWorkspaceSnapshotPending(
  snapshot: Pick<ServerProviderWorkspaceSnapshot, "slashCommandsPending" | "modelsPending">,
): boolean {
  return snapshot.slashCommandsPending === true || snapshot.modelsPending === true;
}

/** Unavailable snapshots must set installed and enabled false. */
export const ServerProviderAvailability = Schema.Literals(["available", "unavailable"]);
export type ServerProviderAvailability = typeof ServerProviderAvailability.Type;

export const ServerProviderContinuation = Schema.Struct({
  groupKey: TrimmedNonEmptyString,
});
export type ServerProviderContinuation = typeof ServerProviderContinuation.Type;

export const ServerProviderCompatibilityStatus = Schema.Literals([
  "unknown",
  "supported",
  "graceful",
  "unsupported",
  "broken",
]);
export const ServerProviderCompatibilityAdvisory = Schema.Struct({
  status: ServerProviderCompatibilityStatus,
  latestVersionStatus: Schema.optionalKey(ServerProviderCompatibilityStatus),
  message: Schema.NullOr(TrimmedNonEmptyString),
  recommendedVersion: Schema.NullOr(TrimmedNonEmptyString),
  recommendedRange: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerProviderCompatibilityAdvisory = typeof ServerProviderCompatibilityAdvisory.Type;

export const ServerProviderVersionAdvisoryStatus = Schema.Literals([
  "unknown",
  "current",
  "behind_latest",
]);
export type ServerProviderVersionAdvisoryStatus = typeof ServerProviderVersionAdvisoryStatus.Type;

export const ServerProviderVersionAdvisory = Schema.Struct({
  status: ServerProviderVersionAdvisoryStatus,
  currentVersion: Schema.NullOr(TrimmedNonEmptyString),
  latestVersion: Schema.NullOr(TrimmedNonEmptyString),
  updateCommand: Schema.NullOr(TrimmedNonEmptyString),
  canUpdate: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
  canInstallVersion: Schema.optionalKey(Schema.Boolean),
  checkedAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(TrimmedNonEmptyString),
});
export type ServerProviderVersionAdvisory = typeof ServerProviderVersionAdvisory.Type;

export const ServerProviderUpdateStatus = Schema.Literals([
  "idle",
  "queued",
  "running",
  "succeeded",
  "failed",
  "unchanged",
]);
export type ServerProviderUpdateStatus = typeof ServerProviderUpdateStatus.Type;

export const ServerProviderUpdateState = Schema.Struct({
  status: ServerProviderUpdateStatus,
  startedAt: Schema.NullOr(IsoDateTime),
  finishedAt: Schema.NullOr(IsoDateTime),
  message: Schema.NullOr(TrimmedNonEmptyString),
  output: Schema.NullOr(Schema.String.check(Schema.isMaxLength(10_000))),
});
export type ServerProviderUpdateState = typeof ServerProviderUpdateState.Type;

export const ServerProvider = Schema.Struct({
  // Only instanceId is stable enough for provider routing.
  instanceId: ProviderInstanceId,
  driver: ProviderDriverKind,
  displayName: Schema.optional(TrimmedNonEmptyString),
  accentColor: Schema.optional(TrimmedNonEmptyString),
  // Validate driver-supplied remote icons against the driver's trusted origin.
  iconUrl: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
  badgeLabel: Schema.optional(TrimmedNonEmptyString),
  continuation: Schema.optional(ServerProviderContinuation),
  showInteractionModeToggle: Schema.optional(Schema.Boolean),
  reportsContextWindow: Schema.optional(Schema.Boolean),
  supportedRuntimeModes: Schema.optional(ForwardCompatibleArray(RuntimeMode)),
  supportsConversationRollback: Schema.optional(Schema.Boolean),
  supportsTextGeneration: Schema.optional(Schema.Boolean),
  setup: Schema.optional(
    Schema.Struct({
      canAuthenticate: Schema.Boolean,
      canInstall: Schema.Boolean,
      documentationUrl: Schema.optionalKey(TrimmedNonEmptyString.check(Schema.isMaxLength(2_048))),
    }),
  ),
  nativeSessions: Schema.optional(
    Schema.Struct({
      canList: Schema.Boolean,
      canLoad: Schema.Boolean,
      canResume: Schema.Boolean,
      canDelete: Schema.optional(Schema.Boolean),
    }),
  ),
  configurableProviders: Schema.optional(Schema.Boolean),
  runtimePaths: Schema.optionalKey(
    Schema.Struct({
      homePath: TrimmedNonEmptyString,
      shadowHomePath: Schema.NullOr(TrimmedNonEmptyString),
    }),
  ),
  enabled: Schema.Boolean,
  installed: Schema.Boolean,
  version: Schema.NullOr(TrimmedNonEmptyString),
  // Version reported by the installed CLI for a local provider with a separate
  // server. Null means unknown; absence keeps legacy snapshots on `version`.
  installedVersion: Schema.optionalKey(Schema.NullOr(TrimmedNonEmptyString)),
  status: ServerProviderState,
  auth: ServerProviderAuth,
  checkedAt: IsoDateTime,
  message: Schema.optional(TrimmedNonEmptyString),
  availability: Schema.optional(ServerProviderAvailability),
  unavailableReason: Schema.optional(TrimmedNonEmptyString),
  models: Schema.Array(ServerProviderModel),
  // Pickers group `models` under these, in order, by `subProvider`.
  subProviders: Schema.optional(Schema.Array(ServerProviderSubProvider)),
  // Set for the one failed check that follows a ready one: pickers keep offering `models`.
  modelsRetained: Schema.optionalKey(Schema.Boolean),
  // Kept apart from `models` so clients that predate it never offer them.
  updateRequiredModels: Schema.optionalKey(Schema.Array(ServerProviderUpdateRequiredModel)),
  slashCommands: Schema.Array(ServerProviderSlashCommand).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
  skills: Schema.Array(ServerProviderSkill).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
  workspaceSnapshots: Schema.optionalKey(Schema.Array(ServerProviderWorkspaceSnapshot)),
  /**
   * Set when the server rescanned a workspace after a session start and its skills or commands
   * changed. Clients holding fetched workspace snapshots for this provider fetch them again.
   */
  workspaceRescannedAt: Schema.optionalKey(IsoDateTime),
  usageLimits: Schema.optional(ServerProviderUsageLimits),
  /** Endpoints whose usage hubs report accounts this instance can route to. */
  usageRoutes: Schema.optionalKey(ForwardCompatibleArray(ServerProviderUsageRoute)),
  /** Quotas read from this instance's own logins, beyond its primary limits. */
  usageSources: Schema.optionalKey(ForwardCompatibleArray(ServerProviderUsageSource)),
  versionAdvisory: Schema.optionalKey(ServerProviderVersionAdvisory),
  compatibilityAdvisory: Schema.optionalKey(ServerProviderCompatibilityAdvisory),
  updateState: Schema.optionalKey(ServerProviderUpdateState),
  canUpdateExtensions: Schema.optionalKey(Schema.Boolean),
  /**
   * Stands for the machine slash commands and skills, which are then left out. Sent to clients
   * that ask for catalog digests; they load both lists with their next cwd snapshot.
   */
  catalogDigest: Schema.optionalKey(TrimmedNonEmptyString),
  /** Set by the client, never sent: the `catalogDigest` its slash commands and skills belong to. */
  loadedCatalogDigest: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ServerProvider = typeof ServerProvider.Type;

/** A provider without the lists that equal the ones its reader already holds. */
export const ServerProviderDelta = ServerProvider.mapFields((fields) => ({
  ...fields,
  models: Schema.optionalKey(fields.models),
  // Declared again without the decoding default, which would read as a change to an empty list.
  slashCommands: Schema.optionalKey(Schema.Array(ServerProviderSlashCommand)),
  skills: Schema.optionalKey(Schema.Array(ServerProviderSkill)),
}));
export type ServerProviderDelta = typeof ServerProviderDelta.Type;

const sameJson = (left: unknown, right: unknown) =>
  left === right || JSON.stringify(left) === JSON.stringify(right);

/** Leaves each provider's models, slash commands, and skills out when `previous` has the same. */
export function serverProviderDeltas(
  previous: ReadonlyArray<ServerProvider>,
  next: ReadonlyArray<ServerProvider>,
): ServerProviderDelta[] {
  const held = new Map(previous.map((provider) => [provider.instanceId, provider]));
  return next.map((provider) => {
    const base = held.get(provider.instanceId);
    if (base === undefined) return provider;
    const { models, slashCommands, skills, ...rest } = provider;
    return {
      ...rest,
      ...(sameJson(base.models, models) ? {} : { models }),
      ...(sameJson(base.slashCommands, slashCommands) ? {} : { slashCommands }),
      ...(sameJson(base.skills, skills) ? {} : { skills }),
    };
  });
}

/** Rebuilds the provider list `serverProviderDeltas` was made from. */
export function applyServerProviderDeltas(
  previous: ReadonlyArray<ServerProvider>,
  deltas: ReadonlyArray<ServerProviderDelta>,
): ServerProvider[] {
  const held = new Map(previous.map((provider) => [provider.instanceId, provider]));
  return deltas.flatMap((delta) => {
    const base = held.get(delta.instanceId);
    const models = delta.models ?? base?.models;
    const slashCommands = delta.slashCommands ?? base?.slashCommands;
    const skills = delta.skills ?? base?.skills;
    // A list this reader never held cannot be rebuilt; drop the provider like an unreadable one.
    return models && slashCommands && skills ? [{ ...delta, models, slashCommands, skills }] : [];
  });
}

export const ServerProviders = ForwardCompatibleArray(ServerProvider);
export type ServerProviders = typeof ServerProviders.Type;

export const isProviderAvailable = (snapshot: ServerProvider): boolean =>
  snapshot.availability !== "unavailable";

/** Legacy producers omit this field and support text generation. */
export const isProviderTextGenerationCapable = (snapshot: ServerProvider): boolean =>
  snapshot.supportsTextGeneration !== false;

export const OtlpEndpointSource = Schema.Literals(["environment", "bootstrap", "settings"]);
export type OtlpEndpointSource = typeof OtlpEndpointSource.Type;

export const ServerObservability = Schema.Struct({
  logsDirectoryPath: TrimmedNonEmptyString,
  localTracingEnabled: Schema.Boolean,
  otlpTracesUrl: Schema.optional(TrimmedNonEmptyString),
  otlpTracesSource: Schema.optional(OtlpEndpointSource),
  otlpTracesVariable: Schema.optional(TrimmedNonEmptyString),
  otlpTracesEnabled: Schema.Boolean,
  otlpMetricsUrl: Schema.optional(TrimmedNonEmptyString),
  otlpMetricsSource: Schema.optional(OtlpEndpointSource),
  otlpMetricsVariable: Schema.optional(TrimmedNonEmptyString),
  otlpMetricsEnabled: Schema.Boolean,
  otlpLogsUrl: Schema.optional(TrimmedNonEmptyString),
  otlpLogsSource: Schema.optional(OtlpEndpointSource),
  otlpLogsVariable: Schema.optional(TrimmedNonEmptyString),
  otlpLogsEnabled: Schema.Boolean.pipe(Schema.withDecodingDefault(Effect.succeed(false))),
});
export type ServerObservability = typeof ServerObservability.Type;

export const OtlpSignal = Schema.Literals(["traces", "metrics", "logs"]);
export type OtlpSignal = typeof OtlpSignal.Type;

export const OtlpEndpointCheckInput = Schema.Struct({
  signal: OtlpSignal,
  url: TrimmedNonEmptyString.check(Schema.isPattern(/^https?:\/\/./i)),
});
export type OtlpEndpointCheckInput = typeof OtlpEndpointCheckInput.Type;

export const OtlpEndpointCheckResult = Schema.Union([
  Schema.TaggedStruct("Accepted", { latencyMs: Schema.Number }),
  Schema.TaggedStruct("Rejected", { status: Schema.Number }),
  Schema.TaggedStruct("Unreachable", { timedOut: Schema.Boolean }),
]);
export type OtlpEndpointCheckResult = typeof OtlpEndpointCheckResult.Type;

/** The client tells the server what it is, so the triage context can name it. */
export const ServerPrepareTriageInput = Schema.Struct({
  client: AuthClientPresentationMetadata,
});
export type ServerPrepareTriageInput = typeof ServerPrepareTriageInput.Type;

export const ServerPrepareTriageResult = Schema.Struct({
  /** Composer text that links the session's prompt file. */
  prompt: Schema.String,
});
export type ServerPrepareTriageResult = typeof ServerPrepareTriageResult.Type;

/**
 * The prompt file links as a chip in the user's message; clients spot a triage
 * draft by it.
 */
export const TRIAGE_PROMPT_FILE_NAME = "triage-playbook.md";

export class ServerPrepareTriageError extends Schema.TaggedError<ServerPrepareTriageError>()(
  "ServerPrepareTriageError",
  { cause: Schema.optional(Schema.Defect()) },
) {
  override get message(): string {
    return "Could not write the triage session files.";
  }
}

export const ServerTraceDiagnosticsErrorKind = Schema.Literals([
  "trace-file-not-found",
  "trace-file-read-failed",
]);
export type ServerTraceDiagnosticsErrorKind = typeof ServerTraceDiagnosticsErrorKind.Type;

export const ServerTraceDiagnosticsSpanSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  count: NonNegativeInt,
  failureCount: NonNegativeInt,
  totalDurationMs: Schema.Number,
  averageDurationMs: Schema.Number,
  maxDurationMs: Schema.Number,
});
export type ServerTraceDiagnosticsSpanSummary = typeof ServerTraceDiagnosticsSpanSummary.Type;

export const ServerTraceDiagnosticsFailureSummary = Schema.Struct({
  name: TrimmedNonEmptyString,
  cause: TrimmedNonEmptyString,
  count: NonNegativeInt,
  lastSeenAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsFailureSummary = typeof ServerTraceDiagnosticsFailureSummary.Type;

export const ServerTraceDiagnosticsRecentFailure = Schema.Struct({
  name: TrimmedNonEmptyString,
  cause: TrimmedNonEmptyString,
  durationMs: Schema.Number,
  endedAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsRecentFailure = typeof ServerTraceDiagnosticsRecentFailure.Type;

export const ServerTraceDiagnosticsSpanOccurrence = Schema.Struct({
  name: TrimmedNonEmptyString,
  durationMs: Schema.Number,
  endedAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsSpanOccurrence = typeof ServerTraceDiagnosticsSpanOccurrence.Type;

export const ServerTraceDiagnosticsLogEvent = Schema.Struct({
  spanName: TrimmedNonEmptyString,
  level: TrimmedNonEmptyString,
  message: TrimmedNonEmptyString,
  seenAt: Schema.DateTimeUtc,
  traceId: TrimmedNonEmptyString,
  spanId: TrimmedNonEmptyString,
});
export type ServerTraceDiagnosticsLogEvent = typeof ServerTraceDiagnosticsLogEvent.Type;

export const ServerTraceDiagnosticsResult = Schema.Struct({
  traceFilePath: TrimmedNonEmptyString,
  scannedFilePaths: Schema.Array(TrimmedNonEmptyString),
  readAt: Schema.DateTimeUtc,
  recordCount: NonNegativeInt,
  parseErrorCount: NonNegativeInt,
  firstSpanAt: Schema.Option(Schema.DateTimeUtc),
  lastSpanAt: Schema.Option(Schema.DateTimeUtc),
  failureCount: NonNegativeInt,
  interruptionCount: NonNegativeInt,
  slowSpanThresholdMs: NonNegativeInt,
  slowSpanCount: NonNegativeInt,
  logLevelCounts: Schema.Record(TrimmedNonEmptyString, NonNegativeInt),
  topSpansByCount: Schema.Array(ServerTraceDiagnosticsSpanSummary),
  slowestSpans: Schema.Array(ServerTraceDiagnosticsSpanOccurrence),
  commonFailures: Schema.Array(ServerTraceDiagnosticsFailureSummary),
  latestFailures: Schema.Array(ServerTraceDiagnosticsRecentFailure),
  latestWarningAndErrorLogs: Schema.Array(ServerTraceDiagnosticsLogEvent),
  partialFailure: Schema.Option(Schema.Boolean),
  error: Schema.Option(
    Schema.Struct({
      kind: ServerTraceDiagnosticsErrorKind,
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type ServerTraceDiagnosticsResult = typeof ServerTraceDiagnosticsResult.Type;

export const ServerProcessSignal = Schema.Literals(["SIGINT", "SIGKILL"]);
export type ServerProcessSignal = typeof ServerProcessSignal.Type;

export const ServerProcessDiagnosticsEntry = Schema.Struct({
  pid: PositiveInt,
  startTimeMs: NonNegativeInt,
  ppid: NonNegativeInt,
  pgid: Schema.Option(Schema.Int),
  status: TrimmedNonEmptyString,
  cpuPercent: Schema.Number,
  rssBytes: NonNegativeInt,
  elapsed: TrimmedNonEmptyString,
  command: TrimmedNonEmptyString,
  depth: NonNegativeInt,
  childPids: Schema.Array(PositiveInt),
});
export type ServerProcessDiagnosticsEntry = typeof ServerProcessDiagnosticsEntry.Type;

export const ServerProcessDiagnosticsResult = Schema.Struct({
  serverPid: PositiveInt,
  readAt: Schema.DateTimeUtc,
  processCount: NonNegativeInt,
  totalRssBytes: NonNegativeInt,
  totalCpuPercent: Schema.Number,
  processes: Schema.Array(ServerProcessDiagnosticsEntry),
  error: Schema.Option(
    Schema.Struct({
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type ServerProcessDiagnosticsResult = typeof ServerProcessDiagnosticsResult.Type;

export const ServerProcessResourceHistoryInput = Schema.Struct({
  windowMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
});
export type ServerProcessResourceHistoryInput = typeof ServerProcessResourceHistoryInput.Type;

export const ServerProcessResourceHistoryBucket = Schema.Struct({
  startedAt: Schema.DateTimeUtc,
  endedAt: Schema.DateTimeUtc,
  avgCpuPercent: Schema.Number,
  maxCpuPercent: Schema.Number,
  maxRssBytes: NonNegativeInt,
  maxProcessCount: NonNegativeInt,
});
export type ServerProcessResourceHistoryBucket = typeof ServerProcessResourceHistoryBucket.Type;

export const ServerProcessResourceHistorySummary = Schema.Struct({
  processKey: TrimmedNonEmptyString,
  pid: PositiveInt,
  ppid: NonNegativeInt,
  command: TrimmedNonEmptyString,
  depth: NonNegativeInt,
  isServerRoot: Schema.Boolean,
  firstSeenAt: Schema.DateTimeUtc,
  lastSeenAt: Schema.DateTimeUtc,
  currentCpuPercent: Schema.Number,
  avgCpuPercent: Schema.Number,
  maxCpuPercent: Schema.Number,
  cpuSecondsApprox: Schema.Number,
  currentRssBytes: NonNegativeInt,
  maxRssBytes: NonNegativeInt,
  sampleCount: NonNegativeInt,
});
export type ServerProcessResourceHistorySummary = typeof ServerProcessResourceHistorySummary.Type;

export const ServerProcessResourceHistoryFailureTag = Schema.Literals([
  "ProcessDiagnosticsQueryTimeoutError",
  "ProcessDiagnosticsQueryFailedError",
  "ProcessDiagnosticsServerProcessSignalError",
  "ProcessDiagnosticsNotDescendantError",
  "ProcessDiagnosticsSignalFailedError",
]);
export type ServerProcessResourceHistoryFailureTag =
  typeof ServerProcessResourceHistoryFailureTag.Type;

export const ServerProcessResourceHistoryResult = Schema.Struct({
  readAt: Schema.DateTimeUtc,
  windowMs: NonNegativeInt,
  bucketMs: NonNegativeInt,
  sampleIntervalMs: NonNegativeInt,
  retainedSampleCount: NonNegativeInt,
  totalCpuSecondsApprox: Schema.Number,
  buckets: Schema.Array(ServerProcessResourceHistoryBucket),
  topProcesses: Schema.Array(ServerProcessResourceHistorySummary),
  error: Schema.Option(
    Schema.Struct({
      failureTag: ServerProcessResourceHistoryFailureTag,
      message: TrimmedNonEmptyString,
    }),
  ),
});
export type ServerProcessResourceHistoryResult = typeof ServerProcessResourceHistoryResult.Type;

export const ServerSignalProcessInput = Schema.Struct({
  pid: PositiveInt,
  startTimeMs: NonNegativeInt,
  signal: ServerProcessSignal,
});
export type ServerSignalProcessInput = typeof ServerSignalProcessInput.Type;

export const ServerSignalProcessResult = Schema.Struct({
  pid: PositiveInt,
  signal: ServerProcessSignal,
  signaled: Schema.Boolean,
  message: Schema.Option(TrimmedNonEmptyString),
});
export type ServerSignalProcessResult = typeof ServerSignalProcessResult.Type;

export const EnvironmentThemeColor = Schema.String.check(
  Schema.isPattern(/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/),
);
export type EnvironmentThemeColor = typeof EnvironmentThemeColor.Type;

/** Reserve appearance keywords so published themes cannot replace stock preferences. */
export const EnvironmentThemeId = Schema.String.check(
  Schema.isPattern(/^(?!(?:system|light|dark)$)[a-z0-9](?:[a-z0-9-]{0,47})$/),
);
export type EnvironmentThemeId = typeof EnvironmentThemeId.Type;

const EnvironmentThemeColors = Schema.Record(
  Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9]{0,63}$/)),
  TrimmedNonEmptyString.check(Schema.isMaxLength(64)),
);

export const THEME_CSS_MAX_LENGTH = 100_000;
const MAX_THEME_SETTINGS = 32;
export const MAX_LIQUID_GLASS_BLUR = 24;
export const MAX_LIQUID_GLASS_PERCENT = 200;
export const MAX_LIQUID_GLASS_DISPERSION = 2000;

export const ThemeSettingKey = Schema.String.check(
  Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/),
);
export type ThemeSettingKey = typeof ThemeSettingKey.Type;

export const ThemeSettingCondition = Schema.Struct({
  setting: ThemeSettingKey,
  equals: Schema.Union([
    Schema.Boolean,
    Schema.Finite,
    Schema.String.check(Schema.isMaxLength(64)),
  ]),
});
export type ThemeSettingCondition = typeof ThemeSettingCondition.Type;

const themeSettingBaseFields = {
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(48)),
  description: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(240))),
  when: Schema.optional(ThemeSettingCondition),
};

export const ThemeSettingBoolean = Schema.Struct({
  type: Schema.Literal("boolean"),
  ...themeSettingBaseFields,
  default: Schema.Boolean,
});
export type ThemeSettingBoolean = typeof ThemeSettingBoolean.Type;

export const ThemeSettingNumberUnit = Schema.Literals(["px", "%", "rem", "em", "ms", "s", "deg"]);
export type ThemeSettingNumberUnit = typeof ThemeSettingNumberUnit.Type;

export const ThemeSettingNumber = Schema.Struct({
  type: Schema.Literal("number"),
  ...themeSettingBaseFields,
  default: Schema.Finite,
  min: Schema.Finite,
  max: Schema.Finite,
  step: Schema.optional(Schema.Finite),
  unit: Schema.optional(ThemeSettingNumberUnit),
});
export type ThemeSettingNumber = typeof ThemeSettingNumber.Type;

export const ThemeSettingSelectOption = Schema.Struct({
  id: ThemeSettingKey,
  label: TrimmedNonEmptyString.check(Schema.isMaxLength(48)),
});
export type ThemeSettingSelectOption = typeof ThemeSettingSelectOption.Type;

export const ThemeSettingSelect = Schema.Struct({
  type: Schema.Literal("select"),
  ...themeSettingBaseFields,
  default: ThemeSettingKey,
  options: Schema.Array(ThemeSettingSelectOption).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(24),
  ),
});
export type ThemeSettingSelect = typeof ThemeSettingSelect.Type;

export const ThemeSettingColor = Schema.Struct({
  type: Schema.Literal("color"),
  ...themeSettingBaseFields,
  default: EnvironmentThemeColor,
});
export type ThemeSettingColor = typeof ThemeSettingColor.Type;

export const ThemeSettingDefinition = Schema.Union([
  ThemeSettingBoolean,
  ThemeSettingNumber,
  ThemeSettingSelect,
  ThemeSettingColor,
]);
export type ThemeSettingDefinition = typeof ThemeSettingDefinition.Type;

export const ThemeSettingsSchema = Schema.Record(ThemeSettingKey, ThemeSettingDefinition);
export type ThemeSettingsSchema = typeof ThemeSettingsSchema.Type;

export const ThemeSettingRef = Schema.Struct({
  setting: ThemeSettingKey,
});
export type ThemeSettingRef = typeof ThemeSettingRef.Type;

const ThemeEffectBooleanParam = Schema.Union([Schema.Boolean, ThemeSettingRef]);
const ThemeEffectNumberParam = Schema.Union([Schema.Finite, ThemeSettingRef]);

export const ThemeLiquidGlassEffect = Schema.Struct({
  enabled: ThemeEffectBooleanParam,
  blur: Schema.optional(ThemeEffectNumberParam),
  centerBlur: Schema.optional(ThemeEffectNumberParam),
  saturation: Schema.optional(ThemeEffectNumberParam),
  refraction: Schema.optional(ThemeEffectNumberParam),
  dispersion: Schema.optional(ThemeEffectNumberParam),
  glare: Schema.optional(ThemeEffectNumberParam),
});
export type ThemeLiquidGlassEffect = typeof ThemeLiquidGlassEffect.Type;

export const ThemeToggleEffect = Schema.Struct({
  enabled: ThemeEffectBooleanParam,
});
export type ThemeToggleEffect = typeof ThemeToggleEffect.Type;

export const ThemeEffects = Schema.Struct({
  liquidGlass: Schema.optional(ThemeLiquidGlassEffect),
  ambientShimmer: Schema.optional(ThemeToggleEffect),
  floatingPanels: Schema.optional(ThemeToggleEffect),
});
export type ThemeEffects = typeof ThemeEffects.Type;

export const EnvironmentThemeKind = Schema.Literals(["palette", "style"]);
export type EnvironmentThemeKind = typeof EnvironmentThemeKind.Type;

const environmentThemePaletteBaseFields = {
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(48)),
  appearance: Schema.Literals(["light", "dark"]),
  /** Derive the palette from canvas/accent, then overlay colors; without them, colors is the palette. */
  canvas: Schema.optional(EnvironmentThemeColor),
  accent: Schema.optional(EnvironmentThemeColor),
  colors: Schema.optional(EnvironmentThemeColors),
  variants: Schema.optional(
    Schema.Struct({
      light: Schema.optional(EnvironmentThemeColors),
      dark: Schema.optional(EnvironmentThemeColors),
    }),
  ),
  /** Custom styles for web and desktop clients. */
  css: Schema.optional(Schema.String.check(Schema.isMaxLength(THEME_CSS_MAX_LENGTH))),
};

const environmentThemeV1Fields = {
  version: Schema.optional(Schema.Literal(1)),
  ...environmentThemePaletteBaseFields,
};

const environmentThemeV2PaletteFields = {
  version: Schema.Literal(2),
  kind: Schema.Literal("palette"),
  ...environmentThemePaletteBaseFields,
  settings: Schema.optional(ThemeSettingsSchema),
  effects: Schema.optional(ThemeEffects),
};

const environmentThemeV2StyleFields = {
  version: Schema.Literal(2),
  kind: Schema.Literal("style"),
  name: TrimmedNonEmptyString.check(Schema.isMaxLength(48)),
  css: Schema.optional(Schema.String.check(Schema.isMaxLength(THEME_CSS_MAX_LENGTH))),
  settings: Schema.optional(ThemeSettingsSchema),
  effects: Schema.optional(ThemeEffects),
};

export const EnvironmentThemeFileV1 = Schema.Struct(environmentThemeV1Fields);
export type EnvironmentThemeFileV1 = typeof EnvironmentThemeFileV1.Type;

export const EnvironmentThemeFileV2Palette = Schema.Struct(environmentThemeV2PaletteFields);
export type EnvironmentThemeFileV2Palette = typeof EnvironmentThemeFileV2Palette.Type;

export const EnvironmentThemeFileV2Style = Schema.Struct(environmentThemeV2StyleFields);
export type EnvironmentThemeFileV2Style = typeof EnvironmentThemeFileV2Style.Type;

export const EnvironmentThemeFile = Schema.Union([
  EnvironmentThemeFileV1,
  EnvironmentThemeFileV2Palette,
  EnvironmentThemeFileV2Style,
]);
export type EnvironmentThemeFile = typeof EnvironmentThemeFile.Type;

const backgroundField = {
  /** Revision of the image file published beside the theme; absent without one. */
  background: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(64))),
};

export const EnvironmentThemeV1 = Schema.Struct({
  id: EnvironmentThemeId,
  ...environmentThemeV1Fields,
  ...backgroundField,
});

export const EnvironmentThemeV2Palette = Schema.Struct({
  id: EnvironmentThemeId,
  ...environmentThemeV2PaletteFields,
  ...backgroundField,
});

export const EnvironmentThemeV2Style = Schema.Struct({
  id: EnvironmentThemeId,
  ...environmentThemeV2StyleFields,
});

export const EnvironmentTheme = Schema.Union([
  EnvironmentThemeV1,
  EnvironmentThemeV2Palette,
  EnvironmentThemeV2Style,
]);
export type EnvironmentTheme = typeof EnvironmentTheme.Type;

export type EnvironmentPaletteTheme =
  | typeof EnvironmentThemeV1.Type
  | typeof EnvironmentThemeV2Palette.Type;
export type EnvironmentStyleTheme = typeof EnvironmentThemeV2Style.Type;

export function environmentThemeKind(
  file: EnvironmentThemeFile | EnvironmentTheme,
): EnvironmentThemeKind {
  return "kind" in file ? file.kind : "palette";
}

export function isEnvironmentStyleTheme(theme: EnvironmentTheme): theme is EnvironmentStyleTheme {
  return environmentThemeKind(theme) === "style";
}

function environmentThemeFileHasColors(file: EnvironmentThemeFile): boolean {
  if (environmentThemeKind(file) === "style") return false;
  const palette = file as EnvironmentThemeFileV1 | EnvironmentThemeFileV2Palette;
  return (
    (palette.canvas !== undefined && palette.accent !== undefined) ||
    (palette.colors !== undefined && Object.keys(palette.colors).length > 0)
  );
}

function isThemeSettingRef(value: unknown): value is ThemeSettingRef {
  return typeof value === "object" && value !== null && "setting" in value;
}

const LIQUID_GLASS_NUMERIC_BOUNDS = {
  blur: { min: 0, max: MAX_LIQUID_GLASS_BLUR },
  centerBlur: { min: 0, max: MAX_LIQUID_GLASS_BLUR },
  saturation: { min: 0, max: MAX_LIQUID_GLASS_PERCENT },
  refraction: { min: 0, max: MAX_LIQUID_GLASS_PERCENT },
  dispersion: { min: 0, max: MAX_LIQUID_GLASS_DISPERSION },
  glare: { min: 0, max: MAX_LIQUID_GLASS_PERCENT },
} as const;

function validateThemeEffectBoolean(
  path: string,
  param: boolean | ThemeSettingRef,
  settings: ThemeSettingsSchema | undefined,
): string | null {
  if (!isThemeSettingRef(param)) return null;
  const def = settings?.[param.setting];
  if (!def) return `references unknown setting "${param.setting}" in ${path}.`;
  if (def.type !== "boolean") {
    return `references non-boolean setting "${param.setting}" in ${path}.`;
  }
  return null;
}

function validateThemeEffectNumber(
  path: string,
  param: number | ThemeSettingRef | undefined,
  bounds: { readonly min: number; readonly max: number },
  settings: ThemeSettingsSchema | undefined,
): string | null {
  if (param === undefined) return null;
  if (!isThemeSettingRef(param)) {
    if (param < bounds.min || param > bounds.max) {
      return `has ${path} outside ${bounds.min}..${bounds.max}.`;
    }
    return null;
  }
  const def = settings?.[param.setting];
  if (!def) return `references unknown setting "${param.setting}" in ${path}.`;
  if (def.type !== "number") {
    return `references non-number setting "${param.setting}" in ${path}.`;
  }
  if (def.min < bounds.min || def.max > bounds.max) {
    return `setting "${param.setting}" for ${path} exceeds ${bounds.min}..${bounds.max}.`;
  }
  return null;
}

/** Returns a problem suffix sentence if invalid, or null if valid. */
export function validateEnvironmentThemeFile(file: EnvironmentThemeFile): string | null {
  const kind = environmentThemeKind(file);
  if (kind === "palette") {
    if (!environmentThemeFileHasColors(file)) {
      return "has no colors. Give canvas and accent, or at least one color role.";
    }
  } else {
    const style = file as EnvironmentThemeFileV2Style;
    const hasCss = style.css !== undefined && style.css.trim().length > 0;
    const hasEffects =
      style.effects !== undefined &&
      (style.effects.liquidGlass !== undefined ||
        style.effects.ambientShimmer !== undefined ||
        style.effects.floatingPanels !== undefined);
    if (!hasCss && !hasEffects) {
      return "has no styles or effects. Give non-empty css or at least one effect.";
    }
  }

  if (!("settings" in file) && !("effects" in file)) return null;
  const settings = "settings" in file ? file.settings : undefined;
  const effects = "effects" in file ? file.effects : undefined;

  if (settings !== undefined) {
    const entries = Object.entries(settings);
    if (entries.length > MAX_THEME_SETTINGS) {
      return `declares more than ${MAX_THEME_SETTINGS} settings.`;
    }
    for (const [key, def] of entries) {
      if (def.type === "number") {
        if (def.min >= def.max) {
          return `has invalid range for setting "${key}" (min must be less than max).`;
        }
        if (def.default < def.min || def.default > def.max) {
          return `has default outside [${def.min}, ${def.max}] for setting "${key}".`;
        }
        if (def.step !== undefined && def.step <= 0) {
          return `has non-positive step for setting "${key}".`;
        }
      } else if (def.type === "select") {
        const optionIds = new Set<string>();
        for (const option of def.options) {
          if (optionIds.has(option.id)) {
            return `has duplicate option id "${option.id}" in setting "${key}".`;
          }
          optionIds.add(option.id);
        }
        if (!optionIds.has(def.default)) {
          return `has default "${def.default}" missing from options in setting "${key}".`;
        }
      }
      if (def.when !== undefined) {
        if (def.when.setting === key) {
          return `has self-referencing condition on setting "${key}".`;
        }
        const target = settings[def.when.setting];
        if (!target) {
          return `references unknown setting "${def.when.setting}" in condition for "${key}".`;
        }
        const valueType = typeof def.when.equals;
        if (
          (target.type === "boolean" && valueType !== "boolean") ||
          (target.type === "number" && valueType !== "number") ||
          ((target.type === "select" || target.type === "color") && valueType !== "string")
        ) {
          return `has mismatched condition value type for setting "${key}".`;
        }
        if (
          target.type === "select" &&
          !target.options.some((option) => option.id === def.when?.equals)
        ) {
          return `references unknown option "${String(def.when.equals)}" in condition for "${key}".`;
        }
      }
    }
  }

  if (effects !== undefined) {
    if (effects.liquidGlass !== undefined) {
      const problem = validateThemeEffectBoolean(
        "effects.liquidGlass.enabled",
        effects.liquidGlass.enabled,
        settings,
      );
      if (problem) return problem;
      for (const [field, bounds] of Object.entries(LIQUID_GLASS_NUMERIC_BOUNDS) as Array<
        [keyof typeof LIQUID_GLASS_NUMERIC_BOUNDS, { readonly min: number; readonly max: number }]
      >) {
        const numProblem = validateThemeEffectNumber(
          `effects.liquidGlass.${field}`,
          effects.liquidGlass[field],
          bounds,
          settings,
        );
        if (numProblem) return numProblem;
      }
    }
    if (effects.ambientShimmer !== undefined) {
      const problem = validateThemeEffectBoolean(
        "effects.ambientShimmer.enabled",
        effects.ambientShimmer.enabled,
        settings,
      );
      if (problem) return problem;
    }
    if (effects.floatingPanels !== undefined) {
      const problem = validateThemeEffectBoolean(
        "effects.floatingPanels.enabled",
        effects.floatingPanels.enabled,
        settings,
      );
      if (problem) return problem;
    }
  }

  return null;
}

/** tailnet means this machine's Tailscale interface; other private addresses are lan. */
export const ServerDirectEndpointKind = Schema.Literals(["lan", "tailnet"]);
export type ServerDirectEndpointKind = typeof ServerDirectEndpointKind.Type;

export const ServerDirectEndpoint = Schema.Struct({
  kind: ServerDirectEndpointKind,
  httpBaseUrl: TrimmedNonEmptyString,
});
export type ServerDirectEndpoint = typeof ServerDirectEndpoint.Type;

/**
 * A stretch where the server's event loop could not run, so it answered
 * nothing and clients may have dropped the connection.
 */
export const ServerEventLoopStall = Schema.Struct({
  detectedAt: IsoDateTime,
  durationMs: NonNegativeInt,
  /** One-minute load average when the stall was seen. Absent on Windows, which has none. */
  loadAverage: Schema.optionalKey(Schema.Number),
  cpuCount: PositiveInt,
});
export type ServerEventLoopStall = typeof ServerEventLoopStall.Type;

export const ServerConfig = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  auth: ServerAuthDescriptor,
  cwd: TrimmedNonEmptyString,
  /** The machine's own name, which file URIs from its shells may carry. Older servers omit it. */
  hostname: Schema.optionalKey(Schema.String),
  keybindingsConfigPath: TrimmedNonEmptyString,
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
  providers: ServerProviders,
  availableEditors: ForwardCompatibleArray(EditorId),
  remoteOpenTargets: Schema.optionalKey(ForwardCompatibleArray(RemoteOpenTarget)),
  /** Hints only; verify each address answers as this environment. */
  directEndpoints: Schema.optionalKey(ForwardCompatibleArray(ServerDirectEndpoint)),
  observability: ServerObservability,
  settings: ServerSettings,
  /** Present when an administrator's policy file manages this environment. */
  managedPolicy: Schema.optionalKey(ManagedPolicySummary),
  shellResumeCompletionMarker: Schema.optionalKey(Schema.Boolean),
  /**
   * The shell can leave idle subagent children out of snapshots (`omitIdleSubagents`), and
   * `getThreadFamily` and `getWorktreeThreadIds` serve the rows it leaves out.
   */
  shellThreadFamilies: Schema.optionalKey(Schema.Boolean),
  threadLinkMetadata: Schema.optionalKey(Schema.Boolean),
  /**
   * The shell can leave older settled threads out of snapshots (`omitOlderSettled`), and
   * `getOlderSettledThreads` serves them. Only servers that also advertise `shellThreadFamilies`.
   */
  shellOlderSettled: Schema.optionalKey(Schema.Boolean),
  shellRevealInFileManager: Schema.optionalKey(Schema.Boolean),
  shellRevealInFileManagerKind: Schema.optionalKey(FileManagerRevealKind),
  threadResumeCompletionMarker: Schema.optionalKey(Schema.Boolean),
  /** Send window fields only when advertised. */
  threadSnapshotPagination: Schema.optionalKey(Schema.Boolean),
  threadFind: Schema.optionalKey(Schema.Boolean),
  threadFindProgressive: Schema.optionalKey(Schema.Boolean),
  /** Settings patches may carry `secretProviders`; older servers drop the key without an error. */
  secretProviderSettings: Schema.optionalKey(Schema.Boolean),
  /** Secret settings may point at a secret provider; older servers drop the reference. */
  secretReferences: Schema.optionalKey(Schema.Boolean),
  /** A secret request card may be answered with a secret provider reference. */
  secretRequestReferences: Schema.optionalKey(Schema.Boolean),
  scratchWorkspaceRoot: Schema.optionalKey(TrimmedNonEmptyString),
  newProjectsRoot: Schema.optionalKey(TrimmedNonEmptyString),
  /** `projects.createNew` honors `parentDirectory` and `layout`; send them only when advertised. */
  newProjectPlacement: Schema.optionalKey(Schema.Boolean),
  /**
   * The latest stall long enough to notice, sent only for a few minutes after
   * it. A client that reconnects reads it to say why the host stopped
   * answering. Clients do not cache it, since it describes the host at connect.
   */
  lastEventLoopStall: Schema.optionalKey(ServerEventLoopStall),
  /**
   * The host's clock when it built the config, so clients can count live
   * elapsed times against host timestamps despite clock skew. Only a
   * subscription's first snapshot is fresh; later snapshots may repeat it.
   */
  serverTime: Schema.optionalKey(IsoDateTime),
  /**
   * Never sent in a config snapshot: the theme stream emits the current set
   * before any change, so a snapshot carrying it too would hand every
   * subscriber the same array twice per connect.
   */
  environmentThemes: Schema.optional(Schema.Array(EnvironmentTheme)),
  /** Stream-only and opt-in; the source stream emits the current set on subscribe. */
  usageLimitSources: Schema.optional(UsageLimitSourceSnapshots),
});
export type ServerConfig = typeof ServerConfig.Type;

export function resolveEnvironmentMachineKind(
  config: {
    readonly environment: Pick<ExecutionEnvironmentDescriptor, "platform">;
    readonly settings?: Pick<ServerSettings, "environmentIcon">;
  } | null,
): EnvironmentMachineKind {
  return config?.settings?.environmentIcon ?? config?.environment.platform.machine ?? "server";
}

const ServerUpsertKeybindingReplaceTarget = Schema.Struct({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
});

export const ServerUpsertKeybindingInput = Schema.Struct({
  key: KeybindingValue,
  command: KeybindingCommand,
  when: Schema.optional(KeybindingWhen),
  replace: Schema.optional(ServerUpsertKeybindingReplaceTarget),
});
export type ServerUpsertKeybindingInput = typeof ServerUpsertKeybindingInput.Type;

export const ServerRemoveKeybindingInput = ServerUpsertKeybindingReplaceTarget;
export type ServerRemoveKeybindingInput = typeof ServerRemoveKeybindingInput.Type;

export const ServerUpsertKeybindingResult = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerUpsertKeybindingResult = typeof ServerUpsertKeybindingResult.Type;

export const ServerRemoveKeybindingResult = ServerUpsertKeybindingResult;
export type ServerRemoveKeybindingResult = typeof ServerRemoveKeybindingResult.Type;

export const ServerConfigUpdatedPayload = Schema.Struct({
  issues: ServerConfigIssues,
  providers: ServerProviders,
  settings: Schema.optional(ServerSettings),
});
export type ServerConfigUpdatedPayload = typeof ServerConfigUpdatedPayload.Type;

export const ServerConfigKeybindingsUpdatedPayload = Schema.Struct({
  keybindings: ResolvedKeybindingsConfig,
  issues: ServerConfigIssues,
});
export type ServerConfigKeybindingsUpdatedPayload =
  typeof ServerConfigKeybindingsUpdatedPayload.Type;

export const ServerConfigProviderStatusesPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerConfigProviderStatusesPayload = typeof ServerConfigProviderStatusesPayload.Type;

export const ServerConfigProviderStatusDeltasPayload = Schema.Struct({
  /** Every provider in order, as `serverProviderDeltas` from the list this client last received. */
  providers: ForwardCompatibleArray(ServerProviderDelta),
});
export type ServerConfigProviderStatusDeltasPayload =
  typeof ServerConfigProviderStatusDeltasPayload.Type;

export const ServerConfigSettingsUpdatedPayload = Schema.Struct({
  settings: ServerSettings,
});
export type ServerConfigSettingsUpdatedPayload = typeof ServerConfigSettingsUpdatedPayload.Type;

export const ServerConfigStreamSnapshotEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("snapshot"),
  config: ServerConfig,
});
export type ServerConfigStreamSnapshotEvent = typeof ServerConfigStreamSnapshotEvent.Type;

export const ServerConfigStreamKeybindingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("keybindingsUpdated"),
  payload: ServerConfigKeybindingsUpdatedPayload,
});
export type ServerConfigStreamKeybindingsUpdatedEvent =
  typeof ServerConfigStreamKeybindingsUpdatedEvent.Type;

export const ServerConfigStreamProviderStatusesEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("providerStatuses"),
  payload: ServerConfigProviderStatusesPayload,
});
export type ServerConfigStreamProviderStatusesEvent =
  typeof ServerConfigStreamProviderStatusesEvent.Type;

export const ServerConfigStreamProviderStatusDeltasEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("providerStatusDeltas"),
  payload: ServerConfigProviderStatusDeltasPayload,
});
export type ServerConfigStreamProviderStatusDeltasEvent =
  typeof ServerConfigStreamProviderStatusDeltasEvent.Type;

export const ServerConfigStreamSettingsUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("settingsUpdated"),
  payload: ServerConfigSettingsUpdatedPayload,
});
export type ServerConfigStreamSettingsUpdatedEvent =
  typeof ServerConfigStreamSettingsUpdatedEvent.Type;

export const ServerConfigEnvironmentThemesUpdatedPayload = Schema.Struct({
  themes: Schema.Array(EnvironmentTheme),
});
export type ServerConfigEnvironmentThemesUpdatedPayload =
  typeof ServerConfigEnvironmentThemesUpdatedPayload.Type;

export const ServerConfigStreamEnvironmentThemesUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("environmentThemesUpdated"),
  payload: ServerConfigEnvironmentThemesUpdatedPayload,
});
export type ServerConfigStreamEnvironmentThemesUpdatedEvent =
  typeof ServerConfigStreamEnvironmentThemesUpdatedEvent.Type;

export const ServerConfigUsageLimitSourcesUpdatedPayload = Schema.Struct({
  sources: UsageLimitSourceSnapshots,
});
export type ServerConfigUsageLimitSourcesUpdatedPayload =
  typeof ServerConfigUsageLimitSourcesUpdatedPayload.Type;

export const ServerConfigStreamUsageLimitSourcesUpdatedEvent = Schema.Struct({
  version: Schema.Literal(1),
  type: Schema.Literal("usageLimitSourcesUpdated"),
  payload: ServerConfigUsageLimitSourcesUpdatedPayload,
});
export type ServerConfigStreamUsageLimitSourcesUpdatedEvent =
  typeof ServerConfigStreamUsageLimitSourcesUpdatedEvent.Type;

export const ServerConfigStreamEvent = Schema.Union([
  ServerConfigStreamSnapshotEvent,
  ServerConfigStreamKeybindingsUpdatedEvent,
  ServerConfigStreamProviderStatusesEvent,
  ServerConfigStreamProviderStatusDeltasEvent,
  ServerConfigStreamSettingsUpdatedEvent,
  ServerConfigStreamEnvironmentThemesUpdatedEvent,
  ServerConfigStreamUsageLimitSourcesUpdatedEvent,
]);
export type ServerConfigStreamEvent = typeof ServerConfigStreamEvent.Type;

export const ServerSelfUpdateOutcome = Schema.Struct({
  id: TrimmedNonEmptyString,
  fromVersion: TrimmedNonEmptyString,
  targetVersion: TrimmedNonEmptyString,
  status: Schema.Literals(["committed", "rolled-back", "failed"]),
  reason: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ServerSelfUpdateOutcome = typeof ServerSelfUpdateOutcome.Type;

export const ServerLifecycleReadyPayload = Schema.Struct({
  at: IsoDateTime,
  environment: ExecutionEnvironmentDescriptor,
  updateOutcome: Schema.optionalKey(ServerSelfUpdateOutcome),
});
export type ServerLifecycleReadyPayload = typeof ServerLifecycleReadyPayload.Type;

export const ServerLifecycleWelcomePayload = Schema.Struct({
  environment: ExecutionEnvironmentDescriptor,
  cwd: TrimmedNonEmptyString,
  projectName: TrimmedNonEmptyString,
  bootstrapStatus: Schema.optional(Schema.Literals(["pending", "complete"])),
  bootstrapProjectId: Schema.optional(ProjectId),
  bootstrapThreadId: Schema.optional(ThreadId),
  bootstrapProjectCreated: Schema.optional(Schema.Boolean),
  bootstrapThreadCreated: Schema.optional(Schema.Boolean),
});
export type ServerLifecycleWelcomePayload = typeof ServerLifecycleWelcomePayload.Type;

export const ServerLifecycleLegacyThreadMigrationPayload = Schema.Struct({
  status: Schema.Union([Schema.Literal("running"), Schema.Literal("complete")]),
  totalThreadCount: NonNegativeInt,
});
export type ServerLifecycleLegacyThreadMigrationPayload =
  typeof ServerLifecycleLegacyThreadMigrationPayload.Type;

export const ServerLifecycleStreamWelcomeEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("welcome"),
  payload: ServerLifecycleWelcomePayload,
});
export type ServerLifecycleStreamWelcomeEvent = typeof ServerLifecycleStreamWelcomeEvent.Type;

export const ServerLifecycleStreamReadyEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("ready"),
  payload: ServerLifecycleReadyPayload,
});
export type ServerLifecycleStreamReadyEvent = typeof ServerLifecycleStreamReadyEvent.Type;

export const ServerLifecycleStreamLegacyThreadMigrationEvent = Schema.Struct({
  version: Schema.Literal(1),
  sequence: NonNegativeInt,
  type: Schema.Literal("legacyThreadMigration"),
  payload: ServerLifecycleLegacyThreadMigrationPayload,
});
export type ServerLifecycleStreamLegacyThreadMigrationEvent =
  typeof ServerLifecycleStreamLegacyThreadMigrationEvent.Type;

export const ServerLifecycleStreamEvent = Schema.Union([
  ServerLifecycleStreamWelcomeEvent,
  ServerLifecycleStreamReadyEvent,
  ServerLifecycleStreamLegacyThreadMigrationEvent,
]);
export type ServerLifecycleStreamEvent = typeof ServerLifecycleStreamEvent.Type;

export const ServerProviderUpdatedPayload = Schema.Struct({
  providers: ServerProviders,
});
export type ServerProviderUpdatedPayload = typeof ServerProviderUpdatedPayload.Type;

export const ServerProviderUpdateInput = Schema.Struct({
  provider: ProviderDriverKind,
  targetVersion: Schema.optionalKey(TrimmedNonEmptyString),
  instanceId: Schema.optionalKey(ProviderInstanceId),
  extensionsOnly: Schema.optionalKey(Schema.Boolean),
});
export type ServerProviderUpdateInput = typeof ServerProviderUpdateInput.Type;

export class ServerProviderUpdateError extends Schema.TaggedError<ServerProviderUpdateError>()(
  "ServerProviderUpdateError",
  {
    provider: ProviderDriverKind,
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Provider update failed for ${this.provider}: ${this.reason}`;
  }
}

export const ServerNpmReleaseInput = Schema.Struct({
  spec: Schema.String.check(
    Schema.isMaxLength(64),
    Schema.isPattern(/^(?:latest|nightly|\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/),
  ),
});
export type ServerNpmReleaseInput = typeof ServerNpmReleaseInput.Type;

export const ServerNpmRelease = Schema.Struct({
  version: Schema.String,
  databaseMigration: Schema.optionalKey(Schema.Int),
});
export type ServerNpmRelease = typeof ServerNpmRelease.Type;

export class ServerNpmReleaseError extends Schema.TaggedError<ServerNpmReleaseError>()(
  "ServerNpmReleaseError",
  { reason: Schema.String },
) {
  override get message(): string {
    return `Could not check the configured npm registry: ${this.reason}`;
  }
}

export const ServerSelfUpdateInput = Schema.Struct({
  /** Exact npm version, never a dist-tag, so server and client agree on the request. */
  targetVersion: TrimmedNonEmptyString,
  /** Desktop-managed hosts move their app to this update track first. Sent only for a track switch. */
  channel: Schema.optionalKey(DesktopUpdateChannelSchema),
  /** The target release's highest migration; the host refuses to leave Nightly without it. */
  targetDatabaseMigration: Schema.optionalKey(Schema.Int),
  stageOnly: Schema.optionalKey(Schema.Boolean),
});
export type ServerSelfUpdateInput = typeof ServerSelfUpdateInput.Type;

export const ServerSelfUpdateResult = Schema.Struct({
  targetVersion: TrimmedNonEmptyString,
  method: ServerSelfUpdateMethod,
  updateId: Schema.optionalKey(TrimmedNonEmptyString),
  desktopUpdateToken: Schema.optionalKey(TrimmedNonEmptyString),
});
export type ServerSelfUpdateResult = typeof ServerSelfUpdateResult.Type;

export const DesktopUpdateCommitInput = Schema.Struct({
  requestId: TrimmedNonEmptyString,
});
export type DesktopUpdateCommitInput = typeof DesktopUpdateCommitInput.Type;

export const ServerSelfUpdateProgressStage = Schema.Literals(["downloading", "installing"]);
export type ServerSelfUpdateProgressStage = typeof ServerSelfUpdateProgressStage.Type;

export const ServerSelfUpdateProgressEvent = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("progress"),
    stage: ServerSelfUpdateProgressStage,
  }),
  Schema.Struct({
    type: Schema.Literal("complete"),
    result: ServerSelfUpdateResult,
  }),
]);
export type ServerSelfUpdateProgressEvent = typeof ServerSelfUpdateProgressEvent.Type;

export class ServerSelfUpdateError extends Schema.TaggedError<ServerSelfUpdateError>()(
  "ServerSelfUpdateError",
  {
    reason: TrimmedNonEmptyString,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Server update failed: ${this.reason}`;
  }
}
