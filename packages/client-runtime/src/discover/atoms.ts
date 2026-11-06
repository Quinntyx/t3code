import type { DiscoverTransport } from "@t3tools/contracts/discover";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import { createRuntimeCommand, withEnvironmentRpcPermissions } from "../state/runtime.ts";
import { DirectoryDiscovery, EMPTY_DISCOVERY_STATE } from "./service.ts";

export function createDiscoveryAtoms<R, E>(
  runtime: Atom.AtomRuntime<DirectoryDiscovery | EnvironmentRegistry | R, E>,
) {
  const stateAtom = runtime.atom(
    Stream.unwrap(
      DirectoryDiscovery.pipe(Effect.map((discovery) => SubscriptionRef.changes(discovery.state))),
    ),
    { initialValue: EMPTY_DISCOVERY_STATE },
  );
  const stateValueAtom = Atom.make((get) =>
    AsyncResult.getOrElse(get(stateAtom), () => EMPTY_DISCOVERY_STATE),
  ).pipe(Atom.withLabel("directory-discovery-value"));
  const enroll = createRuntimeCommand(runtime, {
    label: "directory-discovery:enroll",
    concurrency: { mode: "singleFlight", key: () => "enroll" },
    execute: (
      input: { readonly enrollmentUrl: string; readonly transport?: DiscoverTransport },
      registry,
    ) =>
      DirectoryDiscovery.pipe(
        Effect.flatMap((discovery) => discovery.enroll(input)),
        withEnvironmentRpcPermissions(runtime, registry),
      ),
  });
  const refresh = createRuntimeCommand(runtime, {
    label: "directory-discovery:refresh",
    concurrency: { mode: "singleFlight", key: () => "refresh" },
    execute: (_input: void) =>
      DirectoryDiscovery.pipe(Effect.flatMap((discovery) => discovery.refresh())),
  });
  const disconnect = createRuntimeCommand(runtime, {
    label: "directory-discovery:disconnect",
    concurrency: { mode: "singleFlight", key: () => "disconnect" },
    execute: (_input: void, registry) =>
      DirectoryDiscovery.pipe(
        Effect.flatMap((discovery) => discovery.disconnect()),
        withEnvironmentRpcPermissions(runtime, registry),
      ),
  });
  const linkService = createRuntimeCommand(runtime, {
    label: "directory-discovery:link-service",
    concurrency: { mode: "singleFlight", key: (input) => input.serviceId },
    execute: (input: { readonly serviceId: string; readonly transport?: DiscoverTransport }) =>
      DirectoryDiscovery.pipe(Effect.flatMap((discovery) => discovery.linkService(input))),
  });
  const unlinkService = createRuntimeCommand(runtime, {
    label: "directory-discovery:unlink-service",
    concurrency: { mode: "singleFlight", key: (serviceId) => serviceId },
    execute: (serviceId: string) =>
      DirectoryDiscovery.pipe(Effect.flatMap((discovery) => discovery.unlinkService(serviceId))),
  });
  const serviceLink = createRuntimeCommand(runtime, {
    label: "directory-discovery:service-link",
    concurrency: { mode: "singleFlight", key: (serviceId) => serviceId },
    execute: (serviceId: string) =>
      DirectoryDiscovery.pipe(Effect.flatMap((discovery) => discovery.serviceLink(serviceId))),
  });
  return { stateValueAtom, enroll, refresh, disconnect, linkService, unlinkService, serviceLink };
}
