import type {
  AcpRegistryConfigurableProvider,
  AcpRegistryPrepareResult,
  AcpRegistrySearchAgent,
} from "@t3tools/contracts";

import { providerClients } from "../providerClients.ts";

export const ACP_REGISTRY_SEARCH_DEBOUNCE_MS = 300;

/** Registry agents a first-class driver already covers; the registry list hides them. */
export const FIRST_CLASS_REGISTRY_AGENT_IDS: ReadonlySet<string> = new Set(
  providerClients.definitions.flatMap((definition) => definition.acpRegistryAgentIds ?? []),
);

export function acpRegistryPrepareErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.trim()
    ? error.message
    : "The ACP could not be prepared.";
}

export function applyAcpRegistryPrepareResult(
  agent: AcpRegistrySearchAgent,
  prepared: AcpRegistryPrepareResult,
): AcpRegistrySearchAgent {
  return {
    ...agent,
    id: prepared.agentId,
    version: prepared.version,
    distribution: prepared.distribution,
  };
}

export function parseProviderHeaders(
  text: string,
):
  | { readonly ok: true; readonly headers: Record<string, string> | undefined }
  | { readonly ok: false; readonly error: string } {
  if (text.trim().length === 0) return { ok: true, headers: undefined };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : "Headers must be valid JSON.",
    };
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    !Object.values(parsed).every((value) => typeof value === "string")
  ) {
    return { ok: false, error: "Headers must be a JSON object with string values." };
  }
  return { ok: true, headers: parsed as Record<string, string> };
}

export interface AcpProviderDraft {
  readonly apiType: string;
  readonly baseUrl: string;
  readonly headers: string;
}

export function initialAcpProviderDraft(
  provider: AcpRegistryConfigurableProvider,
): AcpProviderDraft {
  return {
    apiType: provider.current?.apiType ?? provider.supported[0] ?? "",
    baseUrl: provider.current?.baseUrl ?? "",
    headers: "",
  };
}

/** After saving one provider, only its draft resets; unsaved edits to the others survive the reload. */
export function reloadedAcpProviderDrafts(
  providers: ReadonlyArray<AcpRegistryConfigurableProvider>,
  current: Readonly<Record<string, AcpProviderDraft>>,
  resetProviderId?: string,
): Record<string, AcpProviderDraft> {
  return Object.fromEntries(
    providers.map((provider) => [
      provider.providerId,
      (resetProviderId !== undefined && provider.providerId !== resetProviderId
        ? current[provider.providerId]
        : undefined) ?? initialAcpProviderDraft(provider),
    ]),
  );
}
