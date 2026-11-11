import { deriveAvailableInstanceId, deriveInstanceId } from "../providerInstanceIds.ts";

const INSTANCE_ID_PATTERN = /^[a-zA-Z][a-zA-Z0-9_-]*$/;

export function validateInstanceId(id: string, existing: ReadonlySet<string>): string | null {
  if (id.length === 0) return "Instance ID is required.";
  if (id.length > 64) return "Instance ID must be 64 characters or fewer.";
  if (!INSTANCE_ID_PATTERN.test(id)) {
    return "Instance ID must start with a letter and use only letters, digits, '-', or '_'.";
  }
  if (existing.has(id)) return `An instance named '${id}' already exists.`;
  return null;
}

/** Codex and Claude default slots run before anyone configures them, so their ids stay reserved. */
export function reservedInstanceIds(
  providerInstances: Readonly<Record<string, unknown>> | undefined,
): ReadonlySet<string> {
  return new Set(["codex", "claudeAgent", ...Object.keys(providerInstances ?? {})]);
}

/** A free id for a new instance; a blank or default label claims the driver's own slot first. */
export function deriveNewInstanceId(input: {
  readonly driver: string;
  readonly driverLabel: string;
  readonly label: string;
  readonly existingIds: ReadonlySet<string>;
}): string {
  return deriveAvailableInstanceId(
    (candidate) =>
      !candidate.trim() || candidate === input.driverLabel
        ? input.driver === "acpRegistry"
          ? `${input.driver}_custom`
          : input.driver
        : deriveInstanceId(input.driver, candidate),
    input.label,
    input.existingIds,
  );
}

export type WizardNavigation =
  | { readonly kind: "navigate"; readonly step: number }
  | { readonly kind: "blocked"; readonly step: number; readonly error: string };

const IDENTITY_STEP = 1;
const ACP_REGISTRY_IDENTITY_STEP = 1;

export const ADD_PROVIDER_WIZARD_STEPS = ["Provider", "Identity", "Config"] as const;
export const ACP_REGISTRY_WIZARD_STEPS = ["Provider", "Identity", "Sign in"] as const;
export const LOCAL_ACP_WIZARD_STEPS = ["Provider", "Identity"] as const;

export interface ProviderIdentityDraft {
  readonly label: string;
  readonly accentColor: string;
  readonly instanceIdOverride: string | null;
}

const EMPTY_PROVIDER_IDENTITY_DRAFT: ProviderIdentityDraft = {
  label: "",
  accentColor: "",
  instanceIdOverride: null,
};

export function getProviderIdentityDraft(
  drafts: Readonly<Record<string, ProviderIdentityDraft>>,
  driver: string,
): ProviderIdentityDraft {
  return drafts[driver] ?? EMPTY_PROVIDER_IDENTITY_DRAFT;
}

export function updateProviderIdentityDraft(
  drafts: Readonly<Record<string, ProviderIdentityDraft>>,
  driver: string,
  update: Partial<ProviderIdentityDraft>,
): Record<string, ProviderIdentityDraft> {
  return {
    ...drafts,
    [driver]: { ...getProviderIdentityDraft(drafts, driver), ...update },
  };
}

export function isConfiguredAcpRegistryAgent(
  instances: Readonly<Record<string, { readonly driver: string; readonly config?: unknown }>>,
  agentId: string,
): boolean {
  return Object.values(instances).some((instance) => {
    if (
      instance.driver !== "acpRegistry" ||
      !instance.config ||
      typeof instance.config !== "object"
    ) {
      return false;
    }
    const config = instance.config as Record<string, unknown>;
    return config.source !== "local" && config.agentId === agentId;
  });
}

export function resolveWizardNavigation(
  currentStep: number,
  requestedStep: number,
  stepCount: number,
  validation: {
    readonly instanceIdError: string | null;
    readonly identityStep?: number;
    readonly prerequisite?: {
      readonly step: number;
      readonly error: string | null;
    };
  },
): WizardNavigation {
  const lastStep = Math.max(0, stepCount - 1);
  const targetStep = Math.max(0, Math.min(lastStep, requestedStep));
  const identityStep = validation.identityStep ?? IDENTITY_STEP;
  const prerequisite = validation.prerequisite;

  if (prerequisite?.error && currentStep <= prerequisite.step && targetStep > prerequisite.step) {
    return {
      kind: "blocked",
      step: Math.min(prerequisite.step, lastStep),
      error: prerequisite.error,
    };
  }

  const movesForwardPastIdentity = currentStep <= identityStep && targetStep > identityStep;

  if (movesForwardPastIdentity && validation.instanceIdError !== null) {
    return {
      kind: "blocked",
      step: Math.min(identityStep, lastStep),
      error: validation.instanceIdError,
    };
  }

  return { kind: "navigate", step: targetStep };
}

export function resolveAcpRegistryWizardNavigation(
  currentStep: number,
  requestedStep: number,
  validation: {
    readonly instanceIdError: string | null;
    readonly selectionError: string | null;
  },
): WizardNavigation {
  return resolveWizardNavigation(currentStep, requestedStep, ACP_REGISTRY_WIZARD_STEPS.length, {
    instanceIdError: validation.instanceIdError,
    identityStep: ACP_REGISTRY_IDENTITY_STEP,
    prerequisite: { step: 0, error: validation.selectionError },
  });
}
