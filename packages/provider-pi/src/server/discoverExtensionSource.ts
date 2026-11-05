/**
 * Pi has no base-URL environment variable, so a discovered service reaches it as a registered
 * provider. The variables are the whole configuration: whatever T3 sets on this instance shows up
 * in Pi's model picker without touching the user's `models.json`.
 */
export const PI_T3_DISCOVER_EXTENSION_FILENAME = "pi-t3-discover-extension.ts";

export const PI_T3_DISCOVER_EXTENSION_SOURCE = `\
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

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

async function listModels(baseUrl: string, apiKey: string, signal: AbortSignal) {
  const response = await fetch(baseUrl.replace(/\\/+$/, "") + "/models", {
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

// The factory awaits this list so get_available_models and --list-models see the hub without a
// separate refresh; a hub that is down only costs the timeout, never a failed startup.
export default async function registerDiscoveredServices(pi: ExtensionAPI) {
  for (const [slug, hub] of hubs()) {
    const baseUrl = hub.BASE_URL;
    if (!baseUrl) continue;
    const apiKeyEnv = PREFIX + slug + "_API_KEY";
    const api = hub.API === "anthropic-messages" ? "anthropic-messages" : "openai-completions";
    const apiKey = process.env[apiKeyEnv];
    const initial = apiKey
      ? await listModels(baseUrl, apiKey, AbortSignal.timeout(4000)).catch(() => [])
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
        const models = await listModels(baseUrl, current, signal);
        return models.map(toPiModel);
      },
    });
  }
}
`;
