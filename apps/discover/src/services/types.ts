import type {
  DiscoverServiceCapability,
  DiscoverServiceCredential,
  DiscoverServiceEndpoint,
  DiscoverServiceHealth,
  DiscoverServiceKind,
  DiscoverServiceProtocol,
} from "@t3tools/contracts/discover";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ServiceError extends Schema.TaggedError<ServiceError>()("DiscoverServiceError", {
  serviceId: Schema.String,
  message: Schema.String,
}) {}

export interface ServiceMember {
  readonly id: string;
  readonly label: string;
}

/**
 * A service the broker advertises and, when it supports key exchange, issues one credential per
 * member. Discovery and management are independent: a discoverable service may be started by
 * something else, and a managed service need not be discoverable.
 */
export interface DiscoverableService {
  readonly serviceId: string;
  readonly kind: DiscoverServiceKind;
  readonly label: string;
  readonly protocol: DiscoverServiceProtocol;
  readonly endpoints: ReadonlyArray<DiscoverServiceEndpoint>;
  readonly capabilities: ReadonlyArray<DiscoverServiceCapability>;
  readonly health: Effect.Effect<DiscoverServiceHealth>;
  /** `endpoint` is the one the member asked for, so a remote client gets an address it can reach. */
  readonly issueCredential: (
    member: ServiceMember,
    endpoint: DiscoverServiceEndpoint | undefined,
  ) => Effect.Effect<DiscoverServiceCredential, ServiceError>;
  readonly revokeCredential: (
    member: ServiceMember,
    credential: DiscoverServiceCredential,
  ) => Effect.Effect<void, ServiceError>;
}

export const ManagedServiceState = Schema.Literals(["stopped", "starting", "running", "failed"]);
export type ManagedServiceState = typeof ManagedServiceState.Type;

export interface ManagedServiceStatus {
  readonly serviceId: string;
  readonly state: ManagedServiceState;
  readonly pid: number | null;
  readonly restarts: number;
  readonly error: string | null;
}

/** A service this process owns: it starts it, restarts it, and stops it on shutdown. */
export interface ManagedService {
  readonly serviceId: string;
  readonly status: Effect.Effect<ManagedServiceStatus>;
  readonly start: Effect.Effect<void, ServiceError>;
  readonly stop: Effect.Effect<void>;
}
