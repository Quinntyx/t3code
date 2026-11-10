import {
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  resolveProviderInstanceEnabled,
  type ManagedPolicySummary,
  type ProviderInstanceConfig,
  type ProviderInstanceEnvironmentVariable,
  type ProviderInstanceId,
  type SecretReference,
  type ServerProvider,
  type ServerProviderModel,
  type ServerSettings,
} from "@t3tools/contracts";
import type { ProviderEnvironmentField } from "@t3tools/provider-core/client";
import type { CustomModelDefinition } from "@t3tools/shared/model";
import * as Arr from "effect/Array";
import * as Result from "effect/Result";

import { providerClients } from "../providerClients.ts";
import { reconcileRowsDraft, seedRowsDraft, type RowsDraft } from "./form.ts";

const ENVIRONMENT_VARIABLE_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

let environmentVariableDraftId = 0;
const DRAFT_ROW_ID_PREFIX = "provider-env-";
export const nextEnvironmentVariableDraftId = () =>
  `${DRAFT_ROW_ID_PREFIX}${environmentVariableDraftId++}`;

export type EnvironmentDraftRow = {
  readonly id: string;
  readonly name: string;
  readonly value: ProviderInstanceEnvironmentVariable["value"];
  readonly sensitive: boolean;
  readonly valueRedacted?: boolean;
};

export type EnvironmentRowsDraft = RowsDraft<
  ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  EnvironmentDraftRow
>;

function makeEnvironmentDraftRow(
  variable: ProviderInstanceEnvironmentVariable,
  index: number,
): EnvironmentDraftRow {
  return {
    id: `${index}:${variable.name}`,
    name: variable.name,
    value: variable.value,
    sensitive: variable.sensitive,
    ...(variable.valueRedacted !== undefined ? { valueRedacted: variable.valueRedacted } : {}),
  };
}

const toEnvironmentDraftRows = (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) =>
  environment.map(makeEnvironmentDraftRow);

function environmentValuesEqual(
  left: ProviderInstanceEnvironmentVariable["value"],
  right: ProviderInstanceEnvironmentVariable["value"],
): boolean {
  if (typeof left === "string" || typeof right === "string") return left === right;
  return left.provider === right.provider && left.reference === right.reference;
}

function providerEnvironmentsEqual(
  left: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
  right: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): boolean {
  return (
    left.length === right.length &&
    left.every((variable, index) => {
      const other = right[index];
      return (
        other !== undefined &&
        variable.name === other.name &&
        environmentValuesEqual(variable.value, other.value) &&
        variable.sensitive === other.sensitive &&
        variable.valueRedacted === other.valueRedacted
      );
    })
  );
}

export const seedEnvironmentDraft = (
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): EnvironmentRowsDraft => seedRowsDraft(environment, toEnvironmentDraftRows);

/**
 * Reseeds the variable rows on an outside change, keeping rows the server never acknowledged so a
 * half-typed variable survives another device's write.
 */
export function reconcileEnvironmentDraft(
  stored: EnvironmentRowsDraft,
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>,
): EnvironmentRowsDraft {
  const draft = reconcileRowsDraft(
    stored,
    environment,
    providerEnvironmentsEqual,
    toEnvironmentDraftRows,
  );
  if (draft.rows === stored.rows) return draft;
  const acknowledged = new Set(stored.seen.map((variable) => variable.name));
  const unpublished = stored.rows.filter(
    (row) =>
      row.id.startsWith(DRAFT_ROW_ID_PREFIX) &&
      !acknowledged.has(row.name) &&
      !draft.rows.some((incoming) => incoming.name === row.name),
  );
  return unpublished.length > 0 ? { ...draft, rows: [...draft.rows, ...unpublished] } : draft;
}

export function readConfigString(config: unknown, key: string): string | null {
  if (config === null || typeof config !== "object") return null;
  const value = (config as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

/** Preserve explicit empty arrays/objects; clearing a custom list differs from selecting driver defaults. */
export function nextConfigBlobWithValue(
  config: unknown,
  key: string,
  value: unknown,
): Record<string, unknown> {
  const base: Record<string, unknown> =
    config !== null && typeof config === "object" ? { ...(config as Record<string, unknown>) } : {};
  base[key] = value;
  return base;
}

/** Returns null while a row still has an invalid name, so a half-typed row is not saved. */
export function publishEnvironmentDraftRows(
  rows: ReadonlyArray<EnvironmentDraftRow>,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> | null {
  const published: ProviderInstanceEnvironmentVariable[] = [];
  for (const row of rows) {
    const name = row.name.trim();
    if (!ENVIRONMENT_VARIABLE_NAME_PATTERN.test(name)) {
      if (
        name.length > 0 ||
        row.value !== "" ||
        row.sensitive !== true ||
        row.valueRedacted !== undefined
      ) {
        return null;
      }
      continue;
    }
    const { id: _id, ...rest } = row;
    published.push({ ...rest, name });
  }
  return published;
}

/** The variable row pointed at a secret provider reference, or back at a value when cleared. */
export function environmentDraftRowWithSecret(
  row: EnvironmentDraftRow,
  secret: SecretReference | undefined,
): EnvironmentDraftRow {
  const { valueRedacted: _valueRedacted, ...rest } = row;
  return { ...rest, value: secret ?? "" };
}

export function deriveProviderModelsForDisplay(input: {
  readonly liveModels: ReadonlyArray<ServerProviderModel> | undefined;
  readonly customModels: ReadonlyArray<CustomModelDefinition>;
}): ReadonlyArray<ServerProviderModel> {
  const liveCustomModelsBySlug = new Map(
    Arr.filterMap(input.liveModels ?? [], (model) =>
      model.isCustom ? Result.succeed([model.slug, model] as const) : Result.failVoid,
    ),
  );
  const serverModels = input.liveModels?.filter((model) => !model.isCustom) ?? [];
  const serverSlugs = new Set(serverModels.map((model) => model.slug));
  const customModels = input.customModels.flatMap((entry) =>
    serverSlugs.has(entry.slug)
      ? []
      : [
          {
            slug: entry.slug,
            name: entry.name,
            isCustom: true,
            capabilities:
              entry.capabilities ?? liveCustomModelsBySlug.get(entry.slug)?.capabilities ?? null,
          },
        ],
  );
  return [...serverModels, ...customModels];
}

export function readProviderEnvironmentVariable(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  name: string,
): ProviderInstanceEnvironmentVariable | undefined {
  return environment?.find((variable) => variable.name === name);
}

export function providerEnvironmentWithoutNames(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  names: ReadonlySet<string>,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  return (environment ?? []).filter((variable) => !names.has(variable.name));
}

export function nextProviderEnvironmentWithFieldValue(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  field: ProviderEnvironmentField,
  value: string,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  const trimmed = value.trim();
  const next: ProviderInstanceEnvironmentVariable[] = [];
  let found = false;

  for (const variable of environment ?? []) {
    if (variable.name !== field.name) {
      next.push(variable);
      continue;
    }
    found = true;
    if (trimmed.length > 0) {
      next.push({
        name: variable.name,
        value: trimmed,
        sensitive: field.sensitive ?? true,
      });
    }
  }

  if (!found && trimmed.length > 0) {
    next.push({
      name: field.name,
      value: trimmed,
      sensitive: field.sensitive ?? true,
    });
  }

  return next;
}

export function nextProviderEnvironmentWithFieldSecret(
  environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined,
  field: ProviderEnvironmentField,
  secret: SecretReference | undefined,
): ReadonlyArray<ProviderInstanceEnvironmentVariable> {
  const others = providerEnvironmentWithoutNames(environment, new Set([field.name]));
  return secret === undefined
    ? others
    : [...others, { name: field.name, value: secret, sensitive: true }];
}

export function modelListChanges(current: ReadonlyArray<string>, next: ReadonlyArray<string>) {
  const currentSet = new Set(current);
  const nextSet = new Set(next.map((model) => model.trim()).filter(Boolean));
  return [...new Set([...currentSet, ...nextSet])]
    .filter((model) => currentSet.has(model) !== nextSet.has(model))
    .map((model) => ({ model, selected: nextSet.has(model) }));
}

export interface ProviderInstanceRow {
  readonly instanceId: ProviderInstanceId;
  /** Undefined for a default slot the user never configured. */
  readonly explicitInstance: ProviderInstanceConfig | undefined;
  readonly driver: ProviderDriverKind;
  readonly isDefault: boolean;
  readonly isDirty?: boolean;
}

const CURSOR_DRIVER = ProviderDriverKind.make("cursor");
const ACP_REGISTRY_DRIVER = ProviderDriverKind.make("acpRegistry");

/** Default slots for every driver this build knows, then each configured custom instance. */
export function deriveProviderInstanceRows(input: {
  readonly providerInstances: ServerSettings["providerInstances"] | undefined;
  readonly serverProviders: ReadonlyArray<Pick<ServerProvider, "instanceId">>;
  readonly targetInstanceId?: ProviderInstanceId | undefined;
}): ProviderInstanceRow[] {
  const visibleProviderSettings = providerClients.definitions
    .map((definition) => ({
      provider: definition.driverKind,
      hasDefaultInstance: definition.hasDefaultInstance !== false,
    }))
    .filter(
      (providerSettings) =>
        providerSettings.provider !== CURSOR_DRIVER ||
        input.serverProviders.some(
          (provider) => provider.instanceId === defaultInstanceIdForDriver(CURSOR_DRIVER),
        ),
    );
  const instancesByDriver = new Map<
    ProviderDriverKind,
    Array<[ProviderInstanceId, ProviderInstanceConfig]>
  >();
  for (const [rawId, instance] of Object.entries(input.providerInstances ?? {})) {
    const list = instancesByDriver.get(instance.driver) ?? [];
    list.push([rawId as ProviderInstanceId, instance]);
    instancesByDriver.set(instance.driver, list);
  }
  const defaultSlotIds = new Set<string>(
    visibleProviderSettings.map((providerSettings) =>
      String(defaultInstanceIdForDriver(providerSettings.provider)),
    ),
  );
  const visibleDriverKinds = new Set<ProviderDriverKind>(
    visibleProviderSettings.map((providerSettings) => providerSettings.provider),
  );

  const rows: ProviderInstanceRow[] = [];
  for (const providerSettings of visibleProviderSettings) {
    const driver = providerSettings.provider;
    const defaultInstanceId = defaultInstanceIdForDriver(driver);
    const explicitInstance = input.providerInstances?.[defaultInstanceId];
    const isDirty = explicitInstance !== undefined;
    const hasDefaultSlot = providerSettings.hasDefaultInstance || explicitInstance !== undefined;
    if (
      hasDefaultSlot &&
      (driver === "codex" ||
        driver === "claudeAgent" ||
        isDirty ||
        resolveProviderInstanceEnabled(explicitInstance ?? { driver }) ||
        defaultInstanceId === input.targetInstanceId)
    ) {
      rows.push({
        instanceId: defaultInstanceId,
        explicitInstance,
        driver,
        isDefault: true,
        isDirty,
      });
    }
    for (const [id, instance] of instancesByDriver.get(driver) ?? []) {
      if (id === defaultInstanceId) continue;
      rows.push({
        instanceId: id,
        explicitInstance: instance,
        driver: instance.driver,
        isDefault: false,
      });
    }
  }
  for (const [driver, list] of instancesByDriver) {
    if (visibleDriverKinds.has(driver)) continue;
    for (const [id, instance] of list) {
      rows.push({
        instanceId: id,
        explicitInstance: instance,
        driver: instance.driver,
        isDefault: defaultSlotIds.has(String(id)),
      });
    }
  }
  return rows;
}

export function providerInstanceName(instance: ProviderInstanceConfig): string {
  return (
    instance.displayName?.trim() ||
    providerClients.get(instance.driver)?.label ||
    String(instance.driver)
  );
}

/** Removing or resetting drops the instance's saved settings; a reset can also turn it off. */
export function providerInstanceRemovalPrompt(
  operation: "remove" | "reset",
  instance: ProviderInstanceConfig,
): { readonly question: string; readonly detail: string } {
  const name = providerInstanceName(instance);
  const turnsOff =
    operation === "reset" &&
    resolveProviderInstanceEnabled(instance) &&
    !resolveProviderInstanceEnabled({ driver: instance.driver });
  return {
    question:
      operation === "remove"
        ? `Remove the ${name} provider instance?`
        : `Reset the ${name} provider to its defaults?`,
    detail: `Its saved settings, including any custom binary path, will be removed.${turnsOff ? " It will also be turned off." : ""}`,
  };
}

/** The registry agent whose managed binary T3 installed for this instance, if any. */
export function managedAcpRegistryAgentId(instance: ProviderInstanceConfig): string | null {
  if (instance.driver !== ACP_REGISTRY_DRIVER) return null;
  if (readConfigString(instance.config, "source") === "local") return null;
  return readConfigString(instance.config, "agentId");
}

export interface ManagedInstanceLocks {
  /** Keys inside the instance's `config` users cannot change. */
  readonly configKeys: ReadonlySet<string>;
  /** Environment variables users cannot edit, rename, or remove. */
  readonly environmentNames: ReadonlySet<string>;
  /** Under a runtime-mode ceiling every variable is the administrator's, not only named ones. */
  readonly wholeEnvironment: boolean;
  readonly reason: string;
}

/** What the policy pins on instances of `driver`, or undefined when nothing is. */
export function managedInstanceLocks(
  policy: ManagedPolicySummary | undefined,
  driver: ProviderDriverKind,
): ManagedInstanceLocks | undefined {
  const paths = policy?.limits?.providers?.lockedInstanceFields?.[driver];
  if (policy === undefined || paths === undefined || paths.length === 0) return undefined;
  const fieldsUnder = (prefix: string) =>
    new Set(paths.flatMap((path) => (path.startsWith(prefix) ? [path.slice(prefix.length)] : [])));
  return {
    configKeys: fieldsUnder("config."),
    environmentNames: fieldsUnder("environment."),
    wholeEnvironment: paths.includes("environment"),
    reason: `Managed by ${policy.organization}.`,
  };
}
