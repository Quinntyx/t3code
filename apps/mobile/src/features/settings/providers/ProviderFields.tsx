import type { MenuAction } from "@react-native-menu/menu";
import {
  commandArgumentsEqual,
  configuredCommandArgs,
  deriveProviderSettingsFields,
  makeCommandArgumentDraftRow,
  nextProviderConfigWithFieldValue,
  readProviderConfigBoolean,
  readProviderConfigString,
  reconcileRowsDraft,
  seedRowsDraft,
  toCommandArgumentRows,
  type ProviderEnvironmentField,
  type ProviderSettingsFieldModel,
  type SettingsFormDefinition,
} from "@t3tools/client-runtime/provider-settings/form";
import {
  environmentDraftRowWithSecret,
  nextEnvironmentVariableDraftId,
  publishEnvironmentDraftRows,
  reconcileEnvironmentDraft,
  seedEnvironmentDraft,
  type EnvironmentDraftRow,
} from "@t3tools/client-runtime/provider-settings/instance";
import {
  secretRequestReference,
  type SecretRequestSource,
} from "@t3tools/client-runtime/secret-request";
import { normalizeProviderAccentColor } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  isSecretReference,
  type ProviderInstanceEnvironmentVariable,
  type SecretReference,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { Pressable, View } from "react-native";

import * as Dialog from "../../../components/ui/Dialog";
import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { ControlPill } from "../../../components/ui/ControlPill";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListToggleRow } from "../../../components/ui/ListToggleRow";
import { Menu } from "../../../components/ui/Menu";
import { cn } from "../../../lib/cn";

export function FieldBlock(props: {
  readonly label: string;
  readonly description?: string | undefined;
  readonly separated?: boolean;
  readonly trailing?: ReactNode;
  readonly children?: ReactNode;
}) {
  return (
    <View className={cn("gap-2 px-4 py-3", props.separated && "border-t border-border-subtle")}>
      <View className="min-h-6 flex-row items-center justify-between gap-3">
        <Text textRole="body" className="shrink text-foreground">
          {props.label}
        </Text>
        {props.trailing}
      </View>
      {props.children}
      {props.description ? (
        <Text textRole="footnote" className="text-foreground-muted">
          {props.description}
        </Text>
      ) : null}
    </View>
  );
}

/**
 * Commits when editing ends, not per keystroke, like the desktop's draft inputs. A changed saved
 * value remounts the input; Android Back hides the keyboard without ending editing, so an unsent
 * draft also commits on unmount.
 */
export function CommitTextInput(props: {
  readonly value: string;
  readonly onCommit: (value: string) => void;
  readonly accessibilityLabel: string;
  readonly placeholder?: string | undefined;
  readonly secret?: boolean;
  readonly configured?: boolean;
  readonly multiline?: boolean;
  readonly mono?: boolean;
  readonly editable?: boolean;
  readonly autoFocus?: boolean;
}) {
  // `over` is the saved value the draft was typed against; a changed one remounted the input.
  const draft = useRef<{ readonly text: string; readonly over: string } | null>(null);
  // A secret's saved value never comes back, so a commit clears the field by remounting it.
  const [generation, setGeneration] = useState(0);
  const commit = useEffectEvent(() => {
    const current = draft.current;
    draft.current = null;
    if (current === null || current.over !== props.value) return;
    const next = current.text;
    if (next === props.value) return;
    // A blank secret keeps the stored one; Clear removes it.
    if (props.secret && next.length === 0) return;
    props.onCommit(next);
    if (props.secret) setGeneration((current) => current + 1);
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- commits an unsent draft when the field unmounts, since Android Back never ends editing
  useEffect(() => () => commit(), []);
  return (
    <AppTextInput
      key={`${props.value}:${generation}`}
      accessibilityLabel={props.accessibilityLabel}
      defaultValue={props.secret ? "" : props.value}
      placeholder={
        props.secret && props.configured
          ? "Saved. Enter a new value to replace it."
          : (props.placeholder ?? (props.secret ? "Not set" : undefined))
      }
      secureTextEntry={props.secret}
      multiline={props.multiline}
      editable={props.editable ?? true}
      autoFocus={props.autoFocus}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      className={cn(
        "min-h-11 rounded-xl px-3 py-2 text-base",
        props.multiline && "min-h-24",
        props.mono && "font-mono text-sm",
      )}
      onChangeText={(text) => {
        draft.current = { text, over: props.value };
      }}
      onEndEditing={() => commit()}
    />
  );
}

const STORED_VALUE = "__stored__";

/**
 * A sensitive value saved on the server, or, once the environment has secret providers, a
 * reference the server resolves from one of them.
 */
export function SecretValueInput(props: {
  readonly accessibilityLabel: string;
  readonly value: string | SecretReference | undefined;
  /** A value is saved but redacted, so it never comes back to the app. */
  readonly configured: boolean;
  readonly sources: ReadonlyArray<SecretRequestSource>;
  readonly placeholder?: string | undefined;
  readonly mono?: boolean;
  readonly editable: boolean;
  readonly onCommit: (value: string) => void;
  readonly onSecretChange: (secret: SecretReference) => void;
}) {
  const reference = isSecretReference(props.value) ? props.value : undefined;
  const savedKey = reference ? `${reference.provider}\u0000${reference.reference}` : null;
  const [chosen, setChosen] = useState(reference?.provider ?? null);
  const [previousSavedKey, setPreviousSavedKey] = useState(savedKey);
  if (previousSavedKey !== savedKey) {
    setPreviousSavedKey(savedKey);
    setChosen(reference?.provider ?? null);
  }
  const source = props.sources.find((candidate) => candidate.id === chosen);
  // A reference to a provider this app cannot list still shows which one it names.
  const unknownSource =
    reference !== undefined &&
    !props.sources.some((candidate) => candidate.id === reference.provider)
      ? reference.provider
      : null;
  const sourceLabel =
    chosen === null ? "Stored value" : (source?.label ?? `${chosen} (unavailable)`);
  const actions: MenuAction[] = [
    { id: STORED_VALUE, title: "Stored value", state: chosen === null ? "on" : "off" },
    ...props.sources.map((candidate) => ({
      id: candidate.id,
      title: candidate.label,
      state: candidate.id === chosen ? ("on" as const) : ("off" as const),
    })),
    ...(unknownSource !== null
      ? [{ id: unknownSource, title: `${unknownSource} (unavailable)`, state: "on" as const }]
      : []),
  ];
  return (
    <View className="gap-2">
      {props.sources.length > 0 || reference !== undefined ? (
        <View className="flex-row">
          <Menu
            accessible
            accessibilityRole="button"
            accessibilityLabel={`${props.accessibilityLabel} source: ${sourceLabel}`}
            title="Value comes from"
            actions={actions}
            onPressAction={({ nativeEvent }) => {
              if (!props.editable) return;
              setChosen(
                nativeEvent.event === STORED_VALUE
                  ? null
                  : (props.sources.find((candidate) => candidate.id === nativeEvent.event)?.id ??
                      chosen),
              );
            }}
          >
            <ControlPill variant="pill" label={sourceLabel} disabled={!props.editable} />
          </Menu>
        </View>
      ) : null}
      {chosen === null ? (
        <CommitTextInput
          accessibilityLabel={props.accessibilityLabel}
          value=""
          placeholder={
            reference !== undefined ? "Enter a value to store instead" : props.placeholder
          }
          secret
          configured={reference === undefined && props.configured}
          mono={props.mono}
          editable={props.editable}
          onCommit={props.onCommit}
        />
      ) : (
        <CommitTextInput
          accessibilityLabel={`${props.accessibilityLabel} reference`}
          value={reference?.provider === chosen ? reference.reference : ""}
          placeholder={source?.referencePlaceholder}
          mono
          editable={props.editable && source !== undefined}
          onCommit={(text) => {
            if (source === undefined) return;
            const next = secretRequestReference(source, text);
            if (next === undefined) {
              Dialog.alert("Invalid reference", source.invalidReferenceMessage);
              return;
            }
            props.onSecretChange(next);
          }}
        />
      )}
    </View>
  );
}

/** Fields an administrator's policy pins, shown inert with the reason. */
export type ManagedKeys = { readonly keys: ReadonlySet<string>; readonly reason: string };

function SelectField(props: {
  readonly field: ProviderSettingsFieldModel;
  readonly description: string | undefined;
  readonly value: unknown;
  readonly separated: boolean;
  readonly disabled: boolean;
  readonly onChange: (config: Record<string, unknown> | undefined) => void;
}) {
  const options = props.field.options ?? [];
  const fallback = options[0]?.value ?? "";
  const current = readProviderConfigString(props.value, props.field.key) || fallback;
  const label = options.find((option) => option.value === current)?.label ?? current;
  const actions: MenuAction[] = options.map((option) => ({
    id: option.value,
    title: option.label,
    state: option.value === current ? "on" : "off",
  }));
  return (
    <FieldBlock
      label={props.field.label}
      description={props.description}
      separated={props.separated}
      trailing={
        <Menu
          accessible
          accessibilityRole="button"
          accessibilityLabel={`${props.field.label}: ${label}`}
          title={props.field.label}
          actions={actions}
          onPressAction={({ nativeEvent }) => {
            if (props.disabled) return;
            const next = nativeEvent.event;
            props.onChange(
              nextProviderConfigWithFieldValue(
                props.value,
                props.field,
                next === fallback ? "" : next,
              ),
            );
          }}
        >
          <ControlPill variant="pill" label={label} disabled={props.disabled} />
        </Menu>
      }
    />
  );
}

/** The driver's settings schema rendered as rows, the same fields the desktop form shows. */
export function ProviderSettingsFields(props: {
  readonly definition: SettingsFormDefinition;
  readonly value: unknown;
  readonly disabled: boolean;
  readonly onChange: (config: Record<string, unknown> | undefined) => void;
  readonly sources: ReadonlyArray<SecretRequestSource>;
  readonly managed?: ManagedKeys | undefined;
}) {
  const fields = deriveProviderSettingsFields(props.definition, props.value);
  const isLocalAcp =
    props.definition.driverKind === "acpRegistry" &&
    readProviderConfigString(props.value, "source") === "local";
  return (
    <>
      {fields.map((field, index) => {
        const separated = index > 0;
        const managedReason = props.managed?.keys.has(field.key) ? props.managed.reason : undefined;
        const disabled = props.disabled || managedReason !== undefined;
        const description =
          managedReason === undefined
            ? field.description
            : [field.description, managedReason].filter(Boolean).join(" ");
        if (field.control === "switch") {
          return (
            <View
              key={field.key}
              className={separated ? "border-t border-border-subtle" : undefined}
            >
              <ListToggleRow
                label={field.label}
                description={description}
                disabled={disabled}
                value={readProviderConfigBoolean(props.value, field.key, field.defaultBooleanValue)}
                onValueChange={(checked) =>
                  props.onChange(nextProviderConfigWithFieldValue(props.value, field, checked))
                }
              />
            </View>
          );
        }
        if (field.control === "select") {
          return (
            <SelectField
              key={field.key}
              field={field}
              description={description}
              value={props.value}
              separated={separated}
              disabled={disabled}
              onChange={props.onChange}
            />
          );
        }
        const raw =
          props.value !== null && typeof props.value === "object"
            ? (props.value as Record<string, unknown>)[field.key]
            : undefined;
        const saved = readProviderConfigString(props.value, field.key);
        const secretConfigured =
          field.secret === true && (saved.length > 0 || isSecretReference(raw));
        return (
          <FieldBlock
            key={field.key}
            label={field.label}
            description={description}
            separated={separated}
            trailing={
              secretConfigured && !disabled ? (
                <ControlPill
                  variant="pill"
                  label="Clear"
                  accessibilityLabel={`Clear ${field.label}`}
                  onPress={() =>
                    props.onChange(nextProviderConfigWithFieldValue(props.value, field, ""))
                  }
                />
              ) : null
            }
          >
            {field.acceptsSecretReference ? (
              <SecretValueInput
                accessibilityLabel={field.label}
                value={isSecretReference(raw) ? raw : saved}
                configured={saved.length > 0}
                sources={props.sources}
                placeholder={field.placeholder}
                editable={!disabled}
                onCommit={(next) =>
                  props.onChange(nextProviderConfigWithFieldValue(props.value, field, next))
                }
                onSecretChange={(secret) =>
                  props.onChange(nextProviderConfigWithFieldValue(props.value, field, secret))
                }
              />
            ) : (
              <CommitTextInput
                accessibilityLabel={field.label}
                value={field.secret ? "" : saved}
                placeholder={field.placeholder}
                secret={field.secret === true || field.control === "password"}
                configured={secretConfigured}
                multiline={field.control === "textarea"}
                editable={!disabled}
                onCommit={(next) =>
                  props.onChange(nextProviderConfigWithFieldValue(props.value, field, next))
                }
              />
            )}
          </FieldBlock>
        );
      })}
      {isLocalAcp ? (
        <CommandArguments
          value={props.value}
          disabled={props.disabled || props.managed?.keys.has("commandArgs") === true}
          separated={fields.length > 0}
          onChange={props.onChange}
        />
      ) : null}
    </>
  );
}

function CommandArguments(props: {
  readonly value: unknown;
  readonly disabled: boolean;
  readonly separated: boolean;
  readonly onChange: (config: Record<string, unknown> | undefined) => void;
}) {
  const args = configuredCommandArgs(props.value);
  const [storedDraft, setDraft] = useState(() => seedRowsDraft(args, toCommandArgumentRows));
  const draft = reconcileRowsDraft(storedDraft, args, commandArgumentsEqual, toCommandArgumentRows);
  if (draft !== storedDraft) setDraft(draft);
  const update = (rows: typeof draft.rows) => {
    const next = rows.map((row) => row.value);
    setDraft({ rows, seen: draft.seen, lastPublished: next });
    const config =
      props.value !== null && typeof props.value === "object"
        ? { ...(props.value as Record<string, unknown>) }
        : {};
    props.onChange({ ...config, commandArgs: next });
  };
  return (
    <FieldBlock
      label="Arguments"
      description="One literal argument per row, in launch order."
      separated={props.separated}
    >
      {draft.rows.map((argument, index) => (
        <View key={argument.id} className="flex-row items-center gap-2">
          <View className="min-w-0 flex-1">
            <CommitTextInput
              accessibilityLabel={`Argument ${index + 1}`}
              value={argument.value}
              mono
              editable={!props.disabled}
              onCommit={(next) =>
                update(
                  draft.rows.map((row) => (row.id === argument.id ? { ...row, value: next } : row)),
                )
              }
            />
          </View>
          <ControlPill
            icon="xmark"
            accessibilityLabel={`Remove argument ${index + 1}`}
            disabled={props.disabled}
            onPress={() => update(draft.rows.filter((row) => row.id !== argument.id))}
          />
        </View>
      ))}
      {!props.disabled ? (
        <View className="flex-row">
          <ControlPill
            variant="pill"
            icon="plus"
            label="Add argument"
            onPress={() => update([...draft.rows, makeCommandArgumentDraftRow("")])}
          />
        </View>
      ) : null}
    </FieldBlock>
  );
}

/** Driver-declared variables such as API keys, edited as their own fields. */
export function ProviderEnvironmentFieldRows(props: {
  readonly fields: ReadonlyArray<ProviderEnvironmentField>;
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable> | undefined;
  readonly disabled: boolean;
  readonly separatedFirst: boolean;
  readonly sources: ReadonlyArray<SecretRequestSource>;
  readonly managedReason: (field: ProviderEnvironmentField) => string | undefined;
  readonly onCommit: (field: ProviderEnvironmentField, value: string) => void;
  readonly onSecretChange: (field: ProviderEnvironmentField, secret: SecretReference) => void;
  readonly onRemove: (field: ProviderEnvironmentField) => void;
}) {
  return props.fields.map((field, index) => {
    const variable = props.environment?.find((entry) => entry.name === field.name);
    const managedReason = props.managedReason(field);
    const disabled = props.disabled || managedReason !== undefined;
    return (
      <FieldBlock
        key={field.name}
        label={field.label}
        description={[field.description, managedReason].filter(Boolean).join(" ") || undefined}
        separated={index > 0 || props.separatedFirst}
        trailing={
          variable && !disabled ? (
            <ControlPill
              variant="pill"
              label="Clear"
              accessibilityLabel={`Clear ${field.label}`}
              onPress={() => props.onRemove(field)}
            />
          ) : null
        }
      >
        {field.sensitive === false ? (
          <CommitTextInput
            accessibilityLabel={field.label}
            value={
              variable?.valueRedacted || typeof variable?.value !== "string" ? "" : variable.value
            }
            placeholder={field.placeholder}
            editable={!disabled}
            onCommit={(next) => props.onCommit(field, next)}
          />
        ) : (
          <SecretValueInput
            accessibilityLabel={field.label}
            value={variable?.value}
            configured={variable !== undefined}
            sources={props.sources}
            placeholder={field.placeholder}
            editable={!disabled}
            onCommit={(next) => props.onCommit(field, next)}
            onSecretChange={(secret) => props.onSecretChange(field, secret)}
          />
        )}
      </FieldBlock>
    );
  });
}

/** Free-form per-instance variables; a row publishes once its name is a valid variable name. */
export function ProviderEnvironmentVariables(props: {
  readonly environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>;
  readonly disabled: boolean;
  readonly sources: ReadonlyArray<SecretRequestSource>;
  /** Variables an administrator's policy pins: listed by name, never editable or removable. */
  readonly managed?: { readonly names: ReadonlySet<string>; readonly reason: string } | undefined;
  readonly onChange: (environment: ReadonlyArray<ProviderInstanceEnvironmentVariable>) => void;
}) {
  const [storedDraft, setDraft] = useState(() => seedEnvironmentDraft(props.environment));
  const draft = reconcileEnvironmentDraft(storedDraft, props.environment);
  if (draft !== storedDraft) setDraft(draft);
  const publish = (rows: ReadonlyArray<EnvironmentDraftRow>) => {
    const published = publishEnvironmentDraftRows(rows);
    if (published === null) {
      setDraft({ ...draft, rows });
      return;
    }
    setDraft({ rows, seen: draft.seen, lastPublished: published });
    props.onChange(published);
  };
  const update = (id: string, patch: Partial<Omit<EnvironmentDraftRow, "id">>) => {
    // A row named like a pinned variable renders as the policy's, with no way to edit or remove it.
    if (patch.name !== undefined && props.managed?.names.has(patch.name)) return;
    publish(
      draft.rows.map((row) =>
        row.id === id
          ? { ...row, ...patch, ...(patch.value !== undefined ? { valueRedacted: false } : {}) }
          : row,
      ),
    );
  };
  return (
    <>
      {draft.rows.map((variable, index) =>
        props.managed?.names.has(variable.name) ? (
          <FieldBlock
            key={variable.id}
            label={variable.name}
            description={props.managed.reason}
            separated={index > 0}
          />
        ) : (
          <View
            key={variable.id}
            className={cn("gap-2 px-4 py-3", index > 0 && "border-t border-border-subtle")}
          >
            <View className="flex-row items-center gap-2">
              <View className="min-w-0 flex-1">
                <CommitTextInput
                  accessibilityLabel={`Variable ${index + 1} name`}
                  value={variable.name}
                  placeholder="VARIABLE_NAME"
                  mono
                  // A saved sensitive value never comes back, so renaming it would drop the value.
                  editable={!props.disabled && variable.valueRedacted !== true}
                  autoFocus={variable.name.length === 0 && variable.value === ""}
                  onCommit={(name) => update(variable.id, { name: name.trim() })}
                />
              </View>
              {typeof variable.value === "string" ? (
                <ControlPill
                  icon={variable.sensitive ? "eye.slash" : "eye"}
                  accessibilityLabel={
                    variable.sensitive
                      ? `${variable.name || `Variable ${index + 1}`} is sensitive. Make it plain text`
                      : `${variable.name || `Variable ${index + 1}`} is plain text. Make it sensitive`
                  }
                  disabled={props.disabled || variable.valueRedacted === true}
                  onPress={() => {
                    const sensitive = !variable.sensitive;
                    update(variable.id, {
                      sensitive,
                      ...(sensitive && variable.valueRedacted === undefined
                        ? {}
                        : { valueRedacted: sensitive ? variable.valueRedacted : false }),
                    });
                  }}
                />
              ) : null}
              <ControlPill
                icon="xmark"
                accessibilityLabel={`Remove ${variable.name || `variable ${index + 1}`}`}
                disabled={props.disabled}
                onPress={() => publish(draft.rows.filter((row) => row.id !== variable.id))}
              />
            </View>
            {variable.sensitive ? (
              <SecretValueInput
                accessibilityLabel={`${variable.name || `Variable ${index + 1}`} value`}
                value={variable.valueRedacted ? "" : variable.value}
                configured={variable.valueRedacted === true}
                sources={props.sources}
                placeholder="value"
                mono
                editable={!props.disabled}
                onCommit={(value) => update(variable.id, { value })}
                onSecretChange={(secret) =>
                  publish(
                    draft.rows.map((row) =>
                      row.id === variable.id ? environmentDraftRowWithSecret(row, secret) : row,
                    ),
                  )
                }
              />
            ) : (
              <CommitTextInput
                accessibilityLabel={`${variable.name || `Variable ${index + 1}`} value`}
                value={
                  variable.valueRedacted || typeof variable.value !== "string" ? "" : variable.value
                }
                placeholder="value"
                mono
                editable={!props.disabled}
                onCommit={(value) => update(variable.id, { value })}
              />
            )}
          </View>
        ),
      )}
      {draft.rows.some((row) => row.valueRedacted === true) ? (
        <Text textRole="footnote" className="px-4 pb-3 text-foreground-muted">
          Enter a new value to rename a saved one or make it plain text.
        </Text>
      ) : null}
      {!props.disabled ? (
        <View className={draft.rows.length > 0 ? "border-t border-border-subtle" : undefined}>
          <ListActionRow
            icon="plus"
            label="Add variable"
            onPress={() =>
              setDraft({
                ...draft,
                rows: [
                  ...draft.rows,
                  { id: nextEnvironmentVariableDraftId(), name: "", value: "", sensitive: true },
                ],
              })
            }
          />
        </View>
      ) : null}
    </>
  );
}

const ACCENT_PRESETS = [
  "#2563eb",
  "#7c3aed",
  "#db2777",
  "#dc2626",
  "#ea580c",
  "#ca8a04",
  "#16a34a",
  "#0891b2",
  "#475569",
] as const;

/** A swatch row in place of the desktop's color popover; any other hex is one prompt away. */
export function AccentColorPicker(props: {
  readonly value: string | undefined;
  readonly disabled: boolean;
  readonly onCommit: (value: string) => void;
}) {
  const current = normalizeProviderAccentColor(props.value);
  const custom = current !== undefined && !ACCENT_PRESETS.some((color) => color === current);
  const swatch = (color: string | undefined, label: string, selected: boolean) => (
    <Pressable
      key={label}
      accessibilityRole="radio"
      accessibilityLabel={label}
      accessibilityState={{ checked: selected, disabled: props.disabled }}
      disabled={props.disabled}
      hitSlop={4}
      onPress={() => props.onCommit(color ?? "")}
      className={cn(
        "size-9 items-center justify-center rounded-full border-2",
        selected ? "border-foreground" : "border-transparent",
      )}
    >
      <View
        className={cn(
          "size-7 items-center justify-center rounded-full",
          !color && "border border-border bg-subtle",
        )}
        style={color ? { backgroundColor: color } : undefined}
      >
        {!color ? (
          <SymbolView
            name="xmark"
            size={12}
            tintColorClassName="accent-icon-muted"
            type="monochrome"
          />
        ) : null}
      </View>
    </Pressable>
  );
  return (
    <View className="flex-row flex-wrap items-center gap-1" accessibilityRole="radiogroup">
      {swatch(undefined, "No accent color", current === undefined)}
      {ACCENT_PRESETS.map((color) => swatch(color, `Accent ${color}`, color === current))}
      {custom ? swatch(current, `Accent ${current}`, true) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Custom accent color"
        disabled={props.disabled}
        hitSlop={4}
        onPress={() =>
          Dialog.prompt({
            title: "Accent color",
            message: "Enter a hex color such as #2563eb.",
            placeholder: "#2563eb",
            initialValue: current ?? "",
            confirmText: "Save",
            onConfirm: (value) => {
              const normalized = normalizeProviderAccentColor(value.trim());
              if (normalized) props.onCommit(normalized);
              else if (value.trim().length > 0)
                Dialog.alert("Invalid color", "Enter a six-digit hex color such as #2563eb.");
              else props.onCommit("");
            },
          })
        }
        className="size-9 items-center justify-center rounded-full border border-dashed border-border"
      >
        <SymbolView name="plus" size={14} tintColorClassName="accent-icon" type="monochrome" />
      </Pressable>
    </View>
  );
}
