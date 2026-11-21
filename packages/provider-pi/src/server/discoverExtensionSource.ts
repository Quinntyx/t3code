/**
 * Pi has no base-URL environment variable, so a discovered service reaches it as a registered
 * provider. The variables are the whole configuration: whatever T3 sets on this instance shows up
 * in Pi's model picker without touching the user's `models.json`.
 */
export const PI_T3_DISCOVER_EXTENSION_FILENAME = "pi-t3-discover-extension.ts";

/** JSON `[{ url, models }]`: each usage hub's catalog, read by T3 with the hub's management key. */
const PI_T3_HUB_MODELS_ENV = "T3_HUB_MODELS";

export function withHubModelsEnvironment(
  environment: NodeJS.ProcessEnv,
  catalogs: ReadonlyArray<{ readonly url: string; readonly models: ReadonlyArray<string> }>,
): NodeJS.ProcessEnv {
  const { [PI_T3_HUB_MODELS_ENV]: _stale, ...rest } = environment;
  return catalogs.length === 0
    ? rest
    : { ...rest, [PI_T3_HUB_MODELS_ENV]: JSON.stringify(catalogs) };
}

export const PI_T3_DISCOVER_EXTENSION_SOURCE = `\
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const PREFIX = "T3_DISCOVER_";
const SUFFIXES = ["BASE_URL", "API_KEY", "LABEL", "API"] as const;
const DEFAULT_CONTEXT_WINDOW = 200000;
const DEFAULT_MAX_TOKENS = 32000;

type Suffix = (typeof SUFFIXES)[number];
type Hub = Partial<Record<Suffix, string>>;

type HubModel = {
  readonly id: string;
  readonly name?: string;
  readonly context_window?: number;
  readonly max_tokens?: number;
};

function hubs(): Array<[string, Hub]> {
  const found = new Map<string, Hub>();
  for (const [name, value] of Object.entries(process.env)) {
    if (!name.startsWith(PREFIX) || !value) continue;
    for (const suffix of SUFFIXES) {
      const tail = "_" + suffix;
      if (!name.endsWith(tail)) continue;
      const slug = name.slice(PREFIX.length, name.length - tail.length);
      if (slug.length === 0) continue;
      const hub = found.get(slug) ?? {};
      hub[suffix] = value;
      found.set(slug, hub);
      break;
    }
  }
  return [...found.entries()];
}

function providerId(slug: string): string {
  return "t3-discover-" + slug.toLowerCase().replace(/_/g, "-");
}

// An Anthropic base URL is the bare origin so message requests can append /v1/messages, but the
// model list still lives under /v1. An OpenAI base URL already ends in /v1.
async function listModels(baseUrl: string, api: string, apiKey: string, signal: AbortSignal) {
  const root = baseUrl.replace(/\\/+$/, "");
  const url = api === "anthropic-messages" ? root + "/v1/models" : root + "/models";
  const response = await fetch(url, {
    headers: { authorization: "Bearer " + apiKey },
    signal,
  });
  if (!response.ok) throw new Error("model list returned " + response.status);
  const payload = (await response.json()) as { data?: HubModel[] };
  return Array.isArray(payload.data) ? payload.data.filter((model) => typeof model?.id === "string") : [];
}

function toPiModel(model: HubModel) {
  return {
    id: model.id,
    name: model.name ?? model.id,
    reasoning: false,
    input: ["text", "image"] as const,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: model.context_window ?? DEFAULT_CONTEXT_WINDOW,
    maxTokens: model.max_tokens ?? DEFAULT_MAX_TOKENS,
  };
}

type HubCatalog = { readonly url: string; readonly models: ReadonlyArray<string> };

function hubCatalogs(): HubCatalog[] {
  try {
    const parsed: unknown = JSON.parse(process.env.${PI_T3_HUB_MODELS_ENV} ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter(
          (entry): entry is HubCatalog =>
            typeof entry?.url === "string" && Array.isArray(entry.models),
        )
      : [];
  } catch {
    return [];
  }
}

function originOf(url: string | undefined): string | undefined {
  try {
    return url ? new URL(url).origin : undefined;
  } catch {
    return undefined;
  }
}

type RegistryModel = ReturnType<ExtensionContext["modelRegistry"]["getAll"]>[number];

// A provider in models.json whose base URL is on a hub's host gains the hub's other models. Each
// added model copies the shape of one the user configured there; listing it keeps its own.
function addHubModels(pi: ExtensionAPI, models: ReadonlyArray<RegistryModel>) {
  const catalogs = new Map<string, HubCatalog>();
  for (const catalog of hubCatalogs()) {
    const origin = originOf(catalog.url);
    if (origin) catalogs.set(origin, catalog);
  }
  if (catalogs.size === 0) return;
  const byProvider = new Map<string, RegistryModel[]>();
  for (const model of models) {
    byProvider.set(model.provider, [...(byProvider.get(model.provider) ?? []), model]);
  }
  for (const [provider, existing] of byProvider) {
    const catalog = existing
      .map((model) => catalogs.get(originOf(model.baseUrl) ?? ""))
      .find((entry) => entry !== undefined);
    const template = existing[0];
    if (!catalog || !template) continue;
    const known = new Set(existing.map((model) => model.id));
    const added = catalog.models.filter((id) => !known.has(id));
    if (added.length === 0) continue;
    pi.registerProvider(provider, {
      models: [
        ...existing,
        ...added.map((id) => ({
          ...template,
          id,
          name: id,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        })),
      ],
    });
  }
}

// The factory awaits this list so get_available_models and --list-models see the hub without a
// separate refresh; a hub that is down only costs the timeout, never a failed startup.
export default async function registerDiscoveredServices(pi: ExtensionAPI) {
  // Pi binds extensions, and so fires session_start, before RPC mode reads its first command.
  pi.on("session_start", (_event, ctx) => addHubModels(pi, ctx.modelRegistry.getAll()));
  for (const [slug, hub] of hubs()) {
    const baseUrl = hub.BASE_URL;
    if (!baseUrl) continue;
    const apiKeyEnv = PREFIX + slug + "_API_KEY";
    const api = hub.API === "anthropic-messages" ? "anthropic-messages" : "openai-completions";
    const apiKey = process.env[apiKeyEnv];
    const initial = apiKey
      ? await listModels(baseUrl, api, apiKey, AbortSignal.timeout(4000)).catch(() => [])
      : [];
    pi.registerProvider(providerId(slug), {
      name: hub.LABEL ?? providerId(slug),
      baseUrl,
      apiKey: "$" + apiKeyEnv,
      api,
      models: initial.map(toPiModel),
      async refreshModels({ signal }) {
        const current = process.env[apiKeyEnv];
        if (!current) return [];
        const models = await listModels(baseUrl, api, current, signal);
        return models.map(toPiModel);
      },
    });
  }
}
`;
