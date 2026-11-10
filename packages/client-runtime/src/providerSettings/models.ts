import { ProviderDriverKind, type ServerProviderModel } from "@t3tools/contracts";
import { type CustomModelDefinition, normalizeCustomModelSlug } from "@t3tools/shared/model";

import { sortModelsForProviderInstance } from "../modelOrdering.ts";
import { isReasoningControl } from "../modelTraits.ts";

export const CUSTOM_MODEL_PLACEHOLDER_BY_KIND: Partial<Record<ProviderDriverKind, string>> = {
  [ProviderDriverKind.make("codex")]: "gpt-6.7-codex-ultra-preview",
  [ProviderDriverKind.make("claudeAgent")]: "claude-sonnet-5",
  [ProviderDriverKind.make("cursor")]: "claude-sonnet-4-6",
  [ProviderDriverKind.make("opencode")]: "openai/gpt-5",
  [ProviderDriverKind.make("pi")]: "anthropic/claude-sonnet-5",
};

const PROVIDER_ALIAS_SLUGS = new Set(["default", "auto"]);

export function hasReasoningControl(model: ServerProviderModel): boolean {
  return (model.capabilities?.optionDescriptors ?? []).some(isReasoningControl);
}

// Reasoning is the norm, so only its absence is labeled, and only when other models have it.
// Custom and null capabilities are fallbacks or user-written, not discovered, so they prove nothing.
// Alias slugs ("default", Cursor's "auto") defer to the provider's own model choice, so reasoning is unknown.
export function describeModelCapabilities(
  model: ServerProviderModel,
  flagMissingReasoning: boolean,
): string[] {
  const descriptors = model.capabilities?.optionDescriptors ?? [];
  const labels: string[] = [];
  const hasFastMode = descriptors.some(
    (descriptor) =>
      descriptor.id === "fastMode" ||
      (descriptor.id === "serviceTier" &&
        descriptor.type === "select" &&
        descriptor.options.some((option) => option.id === "fast" || option.label === "Fast")),
  );
  if (hasFastMode) labels.push("Fast mode");
  if (
    flagMissingReasoning &&
    !model.isCustom &&
    model.capabilities &&
    !PROVIDER_ALIAS_SLUGS.has(model.slug) &&
    !hasReasoningControl(model)
  ) {
    labels.push("No reasoning");
  }
  return labels;
}

export function groupModelsForDisplay<
  T extends { readonly slug: string; readonly isCustom: boolean },
>(
  models: ReadonlyArray<T>,
  options: {
    readonly favoriteModels: ReadonlySet<string>;
    readonly hiddenModels: ReadonlySet<string>;
    readonly modelOrder: ReadonlyArray<string>;
  },
): T[] {
  const ordered = sortModelsForProviderInstance(models, {
    favoriteModels: options.favoriteModels,
    groupFavorites: true,
    modelOrder: options.modelOrder,
  });
  const isHidden = (model: T) => !model.isCustom && options.hiddenModels.has(model.slug);
  return [
    ...ordered.filter((model) => options.favoriteModels.has(model.slug)),
    ...ordered.filter((model) => !options.favoriteModels.has(model.slug) && !isHidden(model)),
    ...ordered.filter((model) => !options.favoriteModels.has(model.slug) && isHidden(model)),
  ];
}

export function nextHiddenModelsForBulkToggle(
  models: ReadonlyArray<Pick<ServerProviderModel, "slug" | "isCustom">>,
  hiddenModels: ReadonlyArray<string>,
): string[] {
  const builtInSlugs = models.filter((model) => !model.isCustom).map((model) => model.slug);
  const builtInSlugSet = new Set(builtInSlugs);
  const allBuiltInModelsHidden = builtInSlugs.every((slug) => hiddenModels.includes(slug));

  if (allBuiltInModelsHidden) {
    return hiddenModels.filter((slug) => !builtInSlugSet.has(slug));
  }

  return [...new Set([...hiddenModels, ...builtInSlugs])];
}

export const MAX_CUSTOM_MODEL_LENGTH = 256;

export function validateCustomModelSlug(
  input: string,
  models: ReadonlyArray<Pick<ServerProviderModel, "slug" | "isCustom">>,
  customModels: ReadonlyArray<CustomModelDefinition>,
): { readonly slug: string } | { readonly error: string } {
  const normalized = normalizeCustomModelSlug(input);
  if (!normalized) return { error: "Enter a model slug." };
  if (models.some((model) => !model.isCustom && model.slug === normalized)) {
    return { error: "That model is already built in." };
  }
  if (normalized.length > MAX_CUSTOM_MODEL_LENGTH) {
    return { error: `Model slugs must be ${MAX_CUSTOM_MODEL_LENGTH} characters or less.` };
  }
  if (customModels.some((entry) => entry.slug === normalized)) {
    return { error: "That custom model is already saved." };
  }
  return { slug: normalized };
}
