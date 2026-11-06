import type { DiscoverServiceCredential, DiscoverServiceProtocol } from "./discover.ts";
import {
  ProviderDriverKind,
  type ProviderInstanceEnvironment,
  type ProviderInstanceEnvironmentVariable,
} from "./providerInstance.ts";

/**
 * Harnesses that accept a hub through environment variables only. Claude Code and Codex read
 * their own base URL, so a discovered service becomes a normal provider instance env change.
 * Pi ignores base URL variables, so T3 injects an extension that registers the provider from
 * the namespaced variables below.
 */
const DISCOVER_ENV_PREFIX = "T3_DISCOVER";

const discoverServiceEnvironmentSlug = (serviceId: string): string => {
  const slug = serviceId
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return slug.length > 0 ? slug : "SERVICE";
};

export type DiscoverServiceEnvironmentNames = {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly label: string;
  readonly api: string;
};

export const discoverServiceEnvironmentNames = (
  serviceId: string,
): DiscoverServiceEnvironmentNames => {
  const slug = discoverServiceEnvironmentSlug(serviceId);
  return {
    baseUrl: `${DISCOVER_ENV_PREFIX}_${slug}_BASE_URL`,
    apiKey: `${DISCOVER_ENV_PREFIX}_${slug}_API_KEY`,
    label: `${DISCOVER_ENV_PREFIX}_${slug}_LABEL`,
    api: `${DISCOVER_ENV_PREFIX}_${slug}_API`,
  };
};

/** Matches Pi's `api` field for an OpenAI-compatible endpoint. */
const DISCOVER_SERVICE_PI_OPENAI_API = "openai-completions";

const variable = (
  name: string,
  value: string,
  sensitive = false,
): ProviderInstanceEnvironmentVariable => ({ name, value, sensitive });

const target = (
  protocols: ReadonlyArray<DiscoverServiceProtocol>,
  variables: (
    credential: DiscoverServiceCredential,
    serviceId: string,
  ) => ReadonlyArray<ProviderInstanceEnvironmentVariable>,
) => ({ protocols, variables });

const TARGETS = new Map<string, ReturnType<typeof target>>([
  [
    ProviderDriverKind.make("claudeAgent"),
    target(["anthropic"], (credential) => [
      variable("ANTHROPIC_BASE_URL", credential.baseUrl),
      variable("ANTHROPIC_AUTH_TOKEN", credential.apiKey, true),
    ]),
  ],
  [
    ProviderDriverKind.make("codex"),
    target(["openai"], (credential) => [
      variable("OPENAI_BASE_URL", credential.baseUrl),
      variable("OPENAI_API_KEY", credential.apiKey, true),
    ]),
  ],
  [
    ProviderDriverKind.make("pi"),
    target(["openai", "anthropic"], (credential, serviceId) => {
      const names = discoverServiceEnvironmentNames(serviceId);
      return [
        variable(names.baseUrl, credential.baseUrl),
        variable(names.apiKey, credential.apiKey, true),
        variable(
          names.api,
          credential.protocol === "anthropic"
            ? "anthropic-messages"
            : DISCOVER_SERVICE_PI_OPENAI_API,
        ),
      ];
    }),
  ],
]);

export const discoverServiceSupportsDriver = (
  driver: ProviderDriverKind,
  protocol: DiscoverServiceProtocol,
): boolean => TARGETS.get(driver)?.protocols.includes(protocol) ?? false;

/**
 * Environment variables that point one provider instance at a discovered service. Null means
 * this harness cannot reach that protocol through its environment.
 */
export const discoverServiceProviderEnvironment = (input: {
  readonly driver: ProviderDriverKind;
  readonly serviceId: string;
  readonly credential: DiscoverServiceCredential;
}): ProviderInstanceEnvironment | null => {
  const entry = TARGETS.get(input.driver);
  if (entry === undefined || !entry.protocols.includes(input.credential.protocol)) return null;
  return entry.variables(input.credential, input.serviceId);
};

/** Preserves redacted secrets and unrelated variables while replacing the target names. */
export const mergeProviderInstanceEnvironment = (
  existing: ProviderInstanceEnvironment | undefined,
  additions: ProviderInstanceEnvironment,
): ProviderInstanceEnvironment => {
  const added = new Set(additions.map((entry) => entry.name));
  return [
    ...(existing ?? []).filter((entry) => !added.has(entry.name)),
    ...additions.map((entry) => ({ ...entry })),
  ];
};
