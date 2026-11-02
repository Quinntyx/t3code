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

export const DiscoverDirectory = Schema.Struct({
  hosts: Schema.Array(DiscoverDirectoryEntry),
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
