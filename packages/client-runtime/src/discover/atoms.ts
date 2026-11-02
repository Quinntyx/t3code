import { WS_METHODS } from "@t3tools/contracts";
import type { DiscoverTransport } from "@t3tools/contracts/discover";
import * as Effect from "effect/Effect";

import type { EnvironmentRegistry } from "../connection/registry.ts";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { AsyncResult, Atom } from "effect/reactivity";

import { createRuntimeCommand, createEnvironmentRpcCommand } from "../state/runtime.ts";
import { DirectoryDiscovery, EMPTY_DISCOVERY_STATE } from "./service.ts";

export function createDiscoveryAtoms<R, E>(runtime: Atom.AtomRuntime<DirectoryDiscovery | R, E>) {
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
    execute: (input: { readonly enrollmentUrl: string }) =>
      DirectoryDiscovery.pipe(Effect.flatMap((discovery) => discovery.enroll(input))),
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
    execute: (_input: void) =>
      DirectoryDiscovery.pipe(Effect.flatMap((discovery) => discovery.disconnect())),
  });
  const hostConfiguration = createRuntimeCommand(runtime, {
    label: "directory-discovery:host-configuration",
    execute: (transport: DiscoverTransport) =>
      DirectoryDiscovery.pipe(
        Effect.flatMap((discovery) => discovery.getHostConfiguration(transport)),
      ),
  });
  return { stateValueAtom, enroll, refresh, disconnect, hostConfiguration };
}

export function createDiscoveryHostAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  return {
    status: createEnvironmentRpcCommand(runtime, {
      label: "discover:status",
      tag: WS_METHODS.discoverStatus,
    }),
    configure: createEnvironmentRpcCommand(runtime, {
      label: "discover:configure",
      tag: WS_METHODS.discoverConfigure,
    }),
    revoke: createEnvironmentRpcCommand(runtime, {
      label: "discover:revoke",
      tag: WS_METHODS.discoverRevoke,
    }),
  };
}
