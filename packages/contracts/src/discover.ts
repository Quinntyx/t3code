import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { ExecutionEnvironmentDescriptor } from "./environment.ts";
import { EnvironmentId } from "./baseSchemas.ts";

export class DiscoverError extends Schema.TaggedError<DiscoverError>()("DiscoverError", {
  message: Schema.String,
}) {}

export const DiscoverTransport = Schema.Literals(["tailscale", "lan"]);
export type DiscoverTransport = typeof DiscoverTransport.Type;

export const DiscoverEndpoint = Schema.Struct({
  transport: DiscoverTransport,
  httpBaseUrl: Schema.String,
});
export type DiscoverEndpoint = typeof DiscoverEndpoint.Type;

export const DiscoverMembership = Schema.Struct({
  directoryId: Schema.String,
  label: Schema.String,
  memberId: Schema.String,
  token: Schema.String,
});
export type DiscoverMembership = typeof DiscoverMembership.Type;

export const DiscoverEnrollmentInput = Schema.Struct({
  code: Schema.String,
  label: Schema.String,
});

export const DiscoverHostRegistration = Schema.Struct({
  descriptor: ExecutionEnvironmentDescriptor,
  endpoints: Schema.Array(DiscoverEndpoint),
});
export type DiscoverHostRegistration = typeof DiscoverHostRegistration.Type;

export const DiscoverHostGrant = Schema.Struct({ hostToken: Schema.String });

export const DiscoverDirectoryEntry = Schema.Struct({
  ...DiscoverHostRegistration.fields,
  lastSeenAt: Schema.Number,
});
export type DiscoverDirectoryEntry = typeof DiscoverDirectoryEntry.Type;

export const DiscoverServiceKind = Schema.Literals(["cliproxyapi", "generic"]);
export type DiscoverServiceKind = typeof DiscoverServiceKind.Type;

/** Wire protocol a discovered service speaks to its clients. */
export const DiscoverServiceProtocol = Schema.Literals(["openai", "anthropic"]);
export type DiscoverServiceProtocol = typeof DiscoverServiceProtocol.Type;

export const DiscoverServiceCapability = Schema.Literals(["key-exchange"]);
export type DiscoverServiceCapability = typeof DiscoverServiceCapability.Type;

export const DiscoverServiceEndpoint = Schema.Struct({
  transport: DiscoverTransport,
  httpBaseUrl: Schema.String,
});
export type DiscoverServiceEndpoint = typeof DiscoverServiceEndpoint.Type;

export const DiscoverServiceHealth = Schema.Literals(["online", "offline", "unknown"]);
export type DiscoverServiceHealth = typeof DiscoverServiceHealth.Type;

/** A non-environment service the broker advertises, such as a model hub. */
export const DiscoverServiceEntry = Schema.Struct({
  serviceId: Schema.String,
  kind: DiscoverServiceKind,
  label: Schema.String,
  protocol: DiscoverServiceProtocol,
  endpoints: Schema.Array(DiscoverServiceEndpoint),
  capabilities: Schema.Array(DiscoverServiceCapability),
  health: DiscoverServiceHealth,
  lastSeenAt: Schema.Number,
  /** Null until this member links the service; linking is always an explicit user action. */
  linkedAt: Schema.NullOr(Schema.Number),
});
export type DiscoverServiceEntry = typeof DiscoverServiceEntry.Type;

/** What a linked service hands one member: one credential and the base URL it belongs to. */
export const DiscoverServiceCredential = Schema.Struct({
  protocol: DiscoverServiceProtocol,
  baseUrl: Schema.String,
  apiKey: Schema.String,
});
export type DiscoverServiceCredential = typeof DiscoverServiceCredential.Type;

export const DiscoverServiceLink = Schema.Struct({
  serviceId: Schema.String,
  linkedAt: Schema.Number,
  credential: Schema.NullOr(DiscoverServiceCredential),
});
export type DiscoverServiceLink = typeof DiscoverServiceLink.Type;

export const DiscoverDirectory = Schema.Struct({
  hosts: Schema.Array(DiscoverDirectoryEntry),
  // Older brokers predate services; absent means none.
  services: Schema.Array(DiscoverServiceEntry).pipe(Schema.withDecodingDefault(Effect.succeed([]))),
});

export const DiscoverPairingRequestInput = Schema.Struct({
  environmentId: EnvironmentId,
  transport: DiscoverTransport,
});

export const DiscoverPairingRequest = Schema.Struct({
  requestId: Schema.String,
  environmentId: EnvironmentId,
  transport: DiscoverTransport,
  expiresAt: Schema.Number,
});
export type DiscoverPairingRequest = typeof DiscoverPairingRequest.Type;

export const DiscoverWork = Schema.Struct({ requests: Schema.Array(DiscoverPairingRequest) });

export const DiscoverPairingResult = Schema.Union([
  Schema.Struct({ status: Schema.Literal("pending") }),
  Schema.Struct({
    status: Schema.Literal("ready"),
    pairingUrl: Schema.String,
    expiresAt: Schema.Number,
  }),
  Schema.Struct({ status: Schema.Literal("failed"), error: Schema.String }),
]);
export type DiscoverPairingResult = typeof DiscoverPairingResult.Type;

export const DiscoverHostConfiguration = Schema.Struct({
  brokerOrigin: Schema.String,
  memberToken: Schema.String,
  transport: DiscoverTransport,
});
export type DiscoverHostConfiguration = typeof DiscoverHostConfiguration.Type;

export const DiscoverHostStatus = Schema.Struct({
  brokerOrigin: Schema.NullOr(Schema.String),
  transport: Schema.NullOr(DiscoverTransport),
  error: Schema.NullOr(Schema.String),
});
export type DiscoverHostStatus = typeof DiscoverHostStatus.Type;
