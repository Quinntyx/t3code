import type { MenuAction } from "@react-native-menu/menu";
import {
  DESCRIPTOR_PRESETS_BY_KIND,
  choiceFromPreset,
  definitionFromDraft,
  descriptorFromPreset,
  descriptorsFromCapabilities,
  draftFromDefinition,
  emptyEditorChoice,
  emptyEditorDescriptor,
  validateDraft,
  type CustomModelDraft,
  type EditorChoice,
  type EditorDescriptor,
} from "@t3tools/client-runtime/provider-settings/custom-model-editor";
import type { ProviderDriverKind, ServerProviderModel } from "@t3tools/contracts";
import type { CustomModelDefinition } from "@t3tools/shared/model";
import { useState } from "react";
import { View } from "react-native";

import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { Button } from "../../../components/ui/Button";
import { ControlPill } from "../../../components/ui/ControlPill";
import { Menu } from "../../../components/ui/Menu";
import { ThemedSwitch } from "../../../components/ui/ThemedSwitch";
import { cn } from "../../../lib/cn";
import { SettingsSection } from "../components/SettingsSection";
import { FieldBlock } from "./ProviderFields";

const CUSTOM_ID = "__custom__";

function EditorInput(props: {
  readonly value: string;
  readonly onChangeText: (value: string) => void;
  readonly accessibilityLabel: string;
  readonly placeholder?: string;
  readonly mono?: boolean;
}) {
  return (
    <AppTextInput
      accessibilityLabel={props.accessibilityLabel}
      value={props.value}
      placeholder={props.placeholder}
      autoCapitalize="none"
      autoCorrect={false}
      spellCheck={false}
      onChangeText={props.onChangeText}
      className={cn("min-h-11 rounded-xl px-3 py-2 text-base", props.mono && "font-mono text-sm")}
    />
  );
}

/** Name and composer options for one custom model, edited as a draft and saved together. */
export function CustomModelEditor(props: {
  readonly driverKind: ProviderDriverKind;
  readonly entry: CustomModelDefinition;
  readonly builtInModels: ReadonlyArray<ServerProviderModel>;
  readonly onSave: (next: CustomModelDefinition) => void;
  readonly onCancel: () => void;
}) {
  const [draft, setDraft] = useState<CustomModelDraft>(() => draftFromDefinition(props.entry));
  const [error, setError] = useState<string | null>(null);
  const presets = DESCRIPTOR_PRESETS_BY_KIND[props.driverKind] ?? [];
  const startFrom = props.builtInModels.filter(
    (model) => (model.capabilities?.optionDescriptors?.length ?? 0) > 0,
  );
  const edit = (next: (current: CustomModelDraft) => CustomModelDraft) => {
    setError(null);
    setDraft(next);
  };
  const updateDescriptor = (key: string, patch: Partial<EditorDescriptor>) =>
    edit((current) => ({
      ...current,
      descriptors: current.descriptors.map((descriptor) =>
        descriptor.key === key ? { ...descriptor, ...patch } : descriptor,
      ),
    }));
  const updateChoice = (descriptorKey: string, choiceKey: string, patch: Partial<EditorChoice>) =>
    edit((current) => ({
      ...current,
      descriptors: current.descriptors.map((descriptor) =>
        descriptor.key !== descriptorKey
          ? descriptor
          : {
              ...descriptor,
              choices: descriptor.choices.map((choice) =>
                choice.key === choiceKey
                  ? { ...choice, ...patch }
                  : patch.isDefault
                    ? { ...choice, isDefault: false }
                    : choice,
              ),
            },
      ),
    }));
  const presetIdOf = (descriptor: EditorDescriptor) =>
    presets.some((preset) => preset.id === descriptor.id) ? descriptor.id : CUSTOM_ID;

  const save = () => {
    const problem = validateDraft(draft);
    if (problem) {
      setError(problem);
      return;
    }
    props.onSave(definitionFromDraft(draft));
  };

  const startFromActions: MenuAction[] = startFrom.map((model) => ({
    id: model.slug,
    title: model.name,
  }));
  const addable = presets.filter(
    (preset) => !draft.descriptors.some((descriptor) => descriptor.id === preset.id),
  );

  return (
    <>
      <SettingsSection title="Custom model">
        <FieldBlock label="Display name" description={draft.slug}>
          <EditorInput
            accessibilityLabel="Display name"
            value={draft.name}
            placeholder={draft.slug}
            onChangeText={(name) => edit((current) => ({ ...current, name }))}
          />
        </FieldBlock>
      </SettingsSection>

      <SettingsSection
        title="Options shown in the composer"
        trailing={
          startFrom.length > 0 ? (
            <Menu
              accessible
              accessibilityRole="button"
              accessibilityLabel="Copy options from a built-in model"
              title="Copy options from"
              actions={startFromActions}
              onPressAction={({ nativeEvent }) => {
                const model = startFrom.find((candidate) => candidate.slug === nativeEvent.event);
                if (!model) return;
                edit((current) => ({
                  ...current,
                  descriptors: descriptorsFromCapabilities(model.capabilities, props.driverKind),
                }));
              }}
            >
              <ControlPill variant="pill" label="Copy from…" />
            </Menu>
          ) : null
        }
        footer={
          draft.descriptors.length === 0
            ? "No custom options. The composer uses the provider's default options."
            : undefined
        }
      >
        {draft.descriptors.map((descriptor, index) => {
          const presetId = presetIdOf(descriptor);
          const idActions: MenuAction[] = [
            ...presets.map((preset) => ({
              id: preset.id,
              title: preset.id,
              subtitle: preset.label,
              state: (preset.id === presetId ? "on" : "off") as "on" | "off",
            })),
            { id: CUSTOM_ID, title: "Custom…", state: presetId === CUSTOM_ID ? "on" : "off" },
          ];
          return (
            <View
              key={descriptor.key}
              className={cn("gap-2 px-4 py-3", index > 0 && "border-t border-border-subtle")}
            >
              <View className="flex-row items-center justify-between gap-2">
                <Text textRole="body" className="text-foreground">
                  {`Option ${index + 1}`}
                </Text>
                <View className="flex-row items-center gap-2">
                  {presets.length > 0 ? (
                    <Menu
                      accessible
                      accessibilityRole="button"
                      accessibilityLabel={`Option ${index + 1} id`}
                      title="Option id"
                      actions={idActions}
                      onPressAction={({ nativeEvent }) => {
                        if (nativeEvent.event === CUSTOM_ID) {
                          updateDescriptor(descriptor.key, { id: "" });
                          return;
                        }
                        const preset = presets.find(
                          (candidate) => candidate.id === nativeEvent.event,
                        );
                        if (!preset) return;
                        updateDescriptor(descriptor.key, {
                          id: preset.id,
                          label: preset.label,
                          type: preset.type,
                          choices: (preset.choices ?? []).map(choiceFromPreset),
                          currentBooleanValue: undefined,
                          description: undefined,
                        });
                      }}
                    >
                      <ControlPill
                        variant="pill"
                        label={presetId === CUSTOM_ID ? "Custom…" : descriptor.id}
                      />
                    </Menu>
                  ) : null}
                  <Menu
                    accessible
                    accessibilityRole="button"
                    accessibilityLabel={`Option ${index + 1} type`}
                    title="Option type"
                    actions={[
                      {
                        id: "select",
                        title: "Choices",
                        state: descriptor.type === "select" ? "on" : "off",
                      },
                      {
                        id: "boolean",
                        title: "Toggle",
                        state: descriptor.type === "boolean" ? "on" : "off",
                      },
                    ]}
                    onPressAction={({ nativeEvent }) =>
                      updateDescriptor(descriptor.key, {
                        type: nativeEvent.event === "boolean" ? "boolean" : "select",
                      })
                    }
                  >
                    <ControlPill
                      variant="pill"
                      label={descriptor.type === "boolean" ? "Toggle" : "Choices"}
                    />
                  </Menu>
                  <ControlPill
                    icon="xmark"
                    accessibilityLabel={`Remove option ${index + 1}`}
                    onPress={() =>
                      edit((current) => ({
                        ...current,
                        descriptors: current.descriptors.filter(
                          (candidate) => candidate.key !== descriptor.key,
                        ),
                      }))
                    }
                  />
                </View>
              </View>
              {presetId === CUSTOM_ID ? (
                <EditorInput
                  accessibilityLabel={`Option ${index + 1} id`}
                  value={descriptor.id}
                  placeholder="optionId"
                  mono
                  onChangeText={(id) => updateDescriptor(descriptor.key, { id })}
                />
              ) : null}
              <EditorInput
                accessibilityLabel={`Option ${index + 1} label`}
                value={descriptor.label}
                placeholder="Label"
                onChangeText={(label) => updateDescriptor(descriptor.key, { label })}
              />
              {descriptor.type === "select" ? (
                <View className="gap-2 rounded-2xl bg-subtle p-3">
                  {descriptor.choices.map((choice, choiceIndex) => (
                    <View
                      key={choice.key}
                      className={cn(
                        "gap-2",
                        choiceIndex > 0 && "border-t border-border-subtle pt-2",
                      )}
                    >
                      <View className="flex-row items-center gap-2">
                        <View className="min-w-0 flex-1">
                          <EditorInput
                            accessibilityLabel={`Choice ${choiceIndex + 1} value`}
                            value={choice.id}
                            placeholder="value"
                            mono
                            onChangeText={(id) => updateChoice(descriptor.key, choice.key, { id })}
                          />
                        </View>
                        <ControlPill
                          icon="xmark"
                          accessibilityLabel={`Remove choice ${choiceIndex + 1}`}
                          onPress={() =>
                            updateDescriptor(descriptor.key, {
                              choices: descriptor.choices.filter(
                                (candidate) => candidate.key !== choice.key,
                              ),
                            })
                          }
                        />
                      </View>
                      <EditorInput
                        accessibilityLabel={`Choice ${choiceIndex + 1} label`}
                        value={choice.label}
                        placeholder="Label"
                        onChangeText={(label) =>
                          updateChoice(descriptor.key, choice.key, { label })
                        }
                      />
                      <View className="flex-row items-center justify-between gap-3">
                        <Text textRole="footnote" className="text-foreground-muted">
                          Default
                        </Text>
                        <ThemedSwitch
                          accessibilityLabel={`Choice ${choiceIndex + 1} is the default`}
                          value={choice.isDefault}
                          onValueChange={(isDefault) =>
                            updateChoice(descriptor.key, choice.key, { isDefault })
                          }
                        />
                      </View>
                    </View>
                  ))}
                  <View className="flex-row">
                    <ControlPill
                      variant="pill"
                      icon="plus"
                      label="Add choice"
                      onPress={() =>
                        updateDescriptor(descriptor.key, {
                          choices: [...descriptor.choices, emptyEditorChoice()],
                        })
                      }
                    />
                  </View>
                </View>
              ) : null}
            </View>
          );
        })}
        <View
          className={cn(
            "flex-row flex-wrap gap-2 px-4 py-3",
            draft.descriptors.length > 0 && "border-t border-border-subtle",
          )}
        >
          {addable.map((preset) => (
            <ControlPill
              key={preset.id}
              variant="pill"
              icon="plus"
              label={preset.label}
              onPress={() =>
                edit((current) => ({
                  ...current,
                  descriptors: [...current.descriptors, descriptorFromPreset(preset)],
                }))
              }
            />
          ))}
          <ControlPill
            variant="pill"
            icon="plus"
            label="Custom option"
            onPress={() =>
              edit((current) => ({
                ...current,
                descriptors: [...current.descriptors, emptyEditorDescriptor()],
              }))
            }
          />
        </View>
      </SettingsSection>

      {error ? (
        <Text accessibilityRole="alert" textRole="footnote" className="px-2 text-danger-foreground">
          {error}
        </Text>
      ) : null}

      <View className="flex-row gap-3">
        <View className="flex-1">
          <Button label="Cancel" tone="secondary" fullWidth onPress={props.onCancel} />
        </View>
        <View className="flex-1">
          <Button label="Save" tone="primary" fullWidth onPress={save} />
        </View>
      </View>
    </>
  );
}
