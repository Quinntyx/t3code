// @effect-diagnostics-next-line nodeBuiltinImport:off -- The CLI reads its own config before any runtime exists.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The CLI reads its own config before any runtime exists.
import * as NodePath from "node:path";

import {
  DiscoverServiceEndpoint,
  DiscoverServiceKind,
  DiscoverServiceProtocol,
} from "@t3tools/contracts/discover";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const SERVICES_CONFIG_FILENAME = "services.json";

const ServiceId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-z0-9][a-z0-9-]*$/),
);

const DiscoverableConfig = Schema.Struct({
  endpoints: Schema.Array(DiscoverServiceEndpoint),
  protocol: Schema.optional(DiscoverServiceProtocol),
  /** Appended to each endpoint origin; defaults to `/v1` for OpenAI and empty for Anthropic. */
  basePath: Schema.optional(Schema.String),
  managementKey: Schema.optional(Schema.String),
  managementKeyEnv: Schema.optional(Schema.String),
  managementBasePath: Schema.optional(Schema.String),
});

const ManagedConfig = Schema.Struct({
  command: Schema.String.check(Schema.isMinLength(1)),
  args: Schema.optional(Schema.Array(Schema.String)),
  env: Schema.optional(Schema.Record(Schema.String, Schema.String)),
  cwd: Schema.optional(Schema.String),
  /** Start with the broker. False keeps the command configured but leaves startup to you. */
  autostart: Schema.optional(Schema.Boolean),
});

export const DiscoverServiceConfig = Schema.Struct({
  serviceId: ServiceId,
  kind: DiscoverServiceKind,
  label: Schema.optional(Schema.String),
  discoverable: Schema.optional(DiscoverableConfig),
  managed: Schema.optional(ManagedConfig),
});
export type DiscoverServiceConfig = typeof DiscoverServiceConfig.Type;

export const ServicesConfig = Schema.Struct({
  services: Schema.Array(DiscoverServiceConfig).pipe(
    Schema.withDecodingDefault(Effect.succeed([])),
  ),
});
export type ServicesConfig = typeof ServicesConfig.Type;

export class ServicesConfigError extends Schema.TaggedError<ServicesConfigError>()(
  "ServicesConfigError",
  { path: Schema.String, message: Schema.String },
) {}

const decodeConfig = Schema.decodeUnknownEffect(Schema.fromJsonString(ServicesConfig));

export const servicesConfigPath = (home: string) => NodePath.join(home, SERVICES_CONFIG_FILENAME);

const validate = Effect.fn("DiscoverServices.validate")(function* (config: ServicesConfig) {
  const seen = new Set<string>();
  for (const service of config.services) {
    if (seen.has(service.serviceId)) {
      return yield* new ServicesConfigError({
        path: "",
        message: `Duplicate service id '${service.serviceId}'.`,
      });
    }
    seen.add(service.serviceId);
    if (service.discoverable === undefined && service.managed === undefined) {
      return yield* new ServicesConfigError({
        path: "",
        message: `Service '${service.serviceId}' needs a discoverable or managed block.`,
      });
    }
    if (service.discoverable !== undefined && service.discoverable.endpoints.length === 0) {
      return yield* new ServicesConfigError({
        path: "",
        message: `Service '${service.serviceId}' needs at least one discoverable endpoint.`,
      });
    }
  }
  return config;
});

/** A missing file means no services; a malformed one must fail loudly instead of starting nothing. */
export const loadServicesConfig = Effect.fn("DiscoverServices.loadConfig")(function* (
  home: string,
) {
  const path = servicesConfigPath(home);
  const read = yield* Effect.sync(() => {
    try {
      return { ok: true as const, raw: NodeFS.readFileSync(path, "utf8") as string | null };
    } catch (cause) {
      // Only a missing file means "no services"; an unreadable one must not look like that.
      return (cause as NodeJS.ErrnoException).code === "ENOENT"
        ? { ok: true as const, raw: null }
        : { ok: false as const };
    }
  });
  if (!read.ok) {
    return yield* new ServicesConfigError({
      path,
      message: "Could not read the services configuration.",
    });
  }
  const raw = read.raw;
  if (raw === null) return { services: [] } satisfies ServicesConfig;
  const decoded = yield* decodeConfig(raw).pipe(
    Effect.mapError(
      (cause) =>
        new ServicesConfigError({
          path,
          message: cause instanceof Error ? cause.message : "Invalid services configuration.",
        }),
    ),
  );
  return yield* validate(decoded).pipe(
    Effect.mapError((error) => new ServicesConfigError({ path, message: error.message })),
  );
});
