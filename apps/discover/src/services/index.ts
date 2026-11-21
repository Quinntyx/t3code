import type {
  DiscoverServiceCapability,
  DiscoverServiceEndpoint,
  DiscoverServiceHealth,
  DiscoverServiceProtocol,
} from "@t3tools/contracts/discover";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/http";

import type { DiscoverServiceConfig, ServicesConfig } from "../config.ts";
import { makeCliProxyService } from "./cliproxyapi.ts";
import { makeProcessService } from "./process.ts";
import { ServiceError, type DiscoverableService, type ManagedService } from "./types.ts";

export * from "./types.ts";
export { startAll, stopAll } from "./process.ts";

const defaultProtocol = (config: DiscoverServiceConfig): DiscoverServiceProtocol =>
  config.discoverable?.protocol ?? "openai";

const defaultBasePath = (protocol: DiscoverServiceProtocol, configured?: string) =>
  configured ?? (protocol === "openai" ? "/v1" : "");

const managementKey = (config: DiscoverServiceConfig): string => {
  const block = config.discoverable;
  if (block === undefined) return "";
  const fromEnv = block.managementKeyEnv ? process.env[block.managementKeyEnv] : undefined;
  return (fromEnv ?? block.managementKey ?? "").trim();
};

/** Advertises endpoints without key exchange; the service authenticates its own clients. */
const makeGenericService = Effect.fn("DiscoverServices.generic")(function* (
  config: DiscoverServiceConfig,
) {
  const http = yield* HttpClient.HttpClient;
  const protocol = defaultProtocol(config);
  const endpoints: ReadonlyArray<DiscoverServiceEndpoint> = config.discoverable?.endpoints ?? [];
  const capabilities: ReadonlyArray<DiscoverServiceCapability> = [];
  const origin = endpoints[0] === undefined ? undefined : new URL(endpoints[0].httpBaseUrl).origin;
  const health: Effect.Effect<DiscoverServiceHealth> =
    origin === undefined
      ? Effect.succeed("unknown")
      : http.execute(HttpClientRequest.get(origin)).pipe(
          Effect.map((): DiscoverServiceHealth => "online"),
          Effect.timeout("3 seconds"),
          Effect.orElseSucceed((): DiscoverServiceHealth => "offline"),
        );
  return {
    serviceId: config.serviceId,
    kind: config.kind,
    label: config.label ?? config.serviceId,
    protocol,
    endpoints,
    capabilities,
    health,
    issueCredential: () =>
      Effect.fail(
        new ServiceError({
          serviceId: config.serviceId,
          message: "This service does not issue credentials through discovery.",
        }),
      ),
    revokeCredential: () => Effect.void,
  };
});

const makeDiscoverable = (
  config: DiscoverServiceConfig,
): Effect.Effect<DiscoverableService, never, HttpClient.HttpClient> => {
  if (config.discoverable === undefined || config.kind === "generic") {
    return makeGenericService(config);
  }
  const protocol = defaultProtocol(config);
  return makeCliProxyService({
    serviceId: config.serviceId,
    label: config.label ?? config.serviceId,
    endpoints: config.discoverable.endpoints,
    managementKey: managementKey(config),
    protocol,
    basePath: defaultBasePath(protocol, config.discoverable.basePath),
    ...(config.discoverable.managementBasePath === undefined
      ? {}
      : { managementBasePath: config.discoverable.managementBasePath }),
  });
};

export interface BuiltServices {
  readonly discoverable: ReadonlyArray<DiscoverableService>;
  readonly managed: ReadonlyArray<ManagedService>;
}

/**
 * Discovery and management are built from independent config blocks, so a service started
 * elsewhere can still be discoverable and a managed service can stay private.
 */
export const buildServices = Effect.fn("DiscoverServices.build")(function* (
  config: ServicesConfig,
) {
  const discoverable: DiscoverableService[] = [];
  const managed: ManagedService[] = [];
  for (const service of config.services) {
    if (service.discoverable !== undefined) {
      discoverable.push(yield* makeDiscoverable(service));
    }
    if (service.managed !== undefined) {
      managed.push(
        yield* makeProcessService({
          serviceId: service.serviceId,
          command: service.managed.command,
          ...(service.managed.args === undefined ? {} : { args: service.managed.args }),
          ...(service.managed.env === undefined ? {} : { env: service.managed.env }),
          ...(service.managed.cwd === undefined ? {} : { cwd: service.managed.cwd }),
        }),
      );
    }
  }
  return { discoverable, managed } satisfies BuiltServices;
});

/** Only services that opted in start with the broker. */
export const autostartServices = (config: ServicesConfig, built: BuiltServices) => {
  const autostart = new Set(
    config.services
      .filter((service) => service.managed?.autostart === true)
      .map((service) => service.serviceId),
  );
  return built.managed.filter((service) => autostart.has(service.serviceId));
};
