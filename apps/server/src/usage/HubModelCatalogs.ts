import type { UsageLimitSourceConfig } from "@t3tools/contracts";
import type { HubModelCatalog } from "@t3tools/provider-core/server/ProviderHost";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Effect from "effect/Effect";

import * as Settings from "../serverSettings.ts";
import { makeCliproxyApi } from "./cliproxyApi.ts";
import { readSourceManagementKey } from "./UsageLimitSources.ts";

// Pi launches wait on this read, so a slow or unreachable hub costs a few seconds once per minute
// and then reads as an empty catalog, never as a failed launch.
const CATALOG_TTL = "1 minute";
const READ_TIMEOUT = "4 seconds";

/** Reads every enabled usage hub's model catalog through its management key. */
export const makeHubModelCatalogs = Effect.gen(function* () {
  const api = yield* makeCliproxyApi;
  const settingsService = yield* Settings.ServerSettingsService;
  const secrets = yield* SecretResolver.SecretResolver;

  const readCatalog = (config: UsageLimitSourceConfig) =>
    readSourceManagementKey(secrets, config).pipe(
      Effect.flatMap((managementKey) =>
        managementKey.length === 0
          ? Effect.succeed([])
          : api.readModels({ url: config.url, managementKey }),
      ),
      Effect.timeout(READ_TIMEOUT),
      Effect.map((models): HubModelCatalog => ({ url: config.url, models })),
      Effect.catchCause((cause) =>
        Effect.logDebug("hub model catalog read failed", { url: config.url, cause }).pipe(
          Effect.as<HubModelCatalog | null>(null),
        ),
      ),
    );

  const readAll = Effect.fn("HubModelCatalogs.read")(function* () {
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    const sources = Object.values(settings?.usageLimitSources ?? {}).filter(
      (config) => config.enabled,
    );
    const catalogs = yield* Effect.forEach(sources, readCatalog, { concurrency: 4 });
    return catalogs.filter(
      (catalog): catalog is HubModelCatalog => catalog !== null && catalog.models.length > 0,
    );
  });

  return yield* Effect.cachedWithTTL(readAll(), CATALOG_TTL);
});
