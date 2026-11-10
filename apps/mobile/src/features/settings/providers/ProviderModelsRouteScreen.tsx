import type { MenuAction } from "@react-native-menu/menu";
import type { StaticScreenProps } from "@react-navigation/native";
import {
  deriveProviderInstanceRows,
  deriveProviderModelsForDisplay,
  modelListChanges,
  nextConfigBlobWithValue,
} from "@t3tools/client-runtime/provider-settings/instance";
import {
  CUSTOM_MODEL_PLACEHOLDER_BY_KIND,
  describeModelCapabilities,
  groupModelsForDisplay,
  nextHiddenModelsForBulkToggle,
  validateCustomModelSlug,
} from "@t3tools/client-runtime/provider-settings/models";
import {
  isProviderDriverKind,
  type EnvironmentId,
  type ProviderInstanceConfig,
  type ProviderInstanceId,
  type ServerProviderModel,
  type ServerSettingsPatch,
} from "@t3tools/contracts";
import {
  createModelHiddenPredicate,
  readCustomModelEntries,
  toCustomModelSetting,
  type CustomModelDefinition,
} from "@t3tools/shared/model";
import { useState } from "react";
import { Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import * as Dialog from "../../../components/ui/Dialog";
import { AppText as Text, AppTextInput } from "../../../components/ui/AppText";
import { SymbolView } from "../../../components/ui/AppSymbol";
import { ControlPill } from "../../../components/ui/ControlPill";
import { ListActionRow } from "../../../components/ui/ListActionRow";
import { ListToggleRow } from "../../../components/ui/ListToggleRow";
import { Menu } from "../../../components/ui/Menu";
import { ScreenScrollView } from "../../../components/ui/ScreenScrollView";
import { ThemedSwitch } from "../../../components/ui/ThemedSwitch";
import { cn } from "../../../lib/cn";
import { SettingsScreen } from "../components/SettingsScreen";
import { SettingsSection } from "../components/SettingsSection";
import { CustomModelEditor } from "./CustomModelEditor";
import { FieldBlock } from "./ProviderFields";
import { providerDisplayName } from "./ProviderStatus";
import {
  useEnvironmentProviders,
  useModelPreferences,
  useProviderInstanceActions,
} from "./useProviderSettings";

type Params = {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
};

const FILTER_THRESHOLD = 8;
const NO_MODELS: ReadonlyArray<string> = [];
const NO_CUSTOM_MODELS: ReadonlyArray<CustomModelDefinition> = [];

export function ProviderModelsRouteScreen({ route }: StaticScreenProps<Params>) {
  return (
    <ProviderModels
      key={`${route.params.environmentId}:${route.params.instanceId}`}
      environmentId={route.params.environmentId}
      instanceId={route.params.instanceId}
    />
  );
}

function ProviderModels({ environmentId, instanceId }: Params) {
  const insets = useSafeAreaInsets();
  const actions = useProviderInstanceActions(environmentId);
  const providers = useEnvironmentProviders(environmentId);
  const row = deriveProviderInstanceRows({
    providerInstances: actions.settings.providerInstances,
    serverProviders: providers,
    targetInstanceId: instanceId,
  }).find((candidate) => candidate.instanceId === instanceId);
  const instance = row ? (row.explicitInstance ?? { driver: row.driver }) : null;
  const provider = providers.find((candidate) => candidate.instanceId === instanceId);
  return (
    <SettingsScreen title={instance ? `${providerDisplayName(instance)} models` : "Models"}>
      <ScreenScrollView
        className="flex-1"
        contentInsetAdjustmentBehavior="automatic"
        keyboardShouldPersistTaps="handled"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {instance ? (
          <ModelsEditor
            environmentId={environmentId}
            instanceId={instanceId}
            instance={instance}
            liveModels={provider?.models}
            actions={actions}
          />
        ) : (
          <Text className="text-foreground-muted">This provider is no longer configured.</Text>
        )}
      </ScreenScrollView>
    </SettingsScreen>
  );
}

function ModelsEditor(props: {
  readonly environmentId: EnvironmentId;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly liveModels: ReadonlyArray<ServerProviderModel> | undefined;
  readonly actions: ReturnType<typeof useProviderInstanceActions>;
}) {
  const { instanceId, instance, actions } = props;
  const driverKind = isProviderDriverKind(instance.driver) ? instance.driver : null;
  const supportsCustomModels = instance.driver !== "antigravity";
  const canManageCustom = actions.canManage && supportsCustomModels;
  const canWritePreferences = actions.canWriteSettings;
  const customModels = supportsCustomModels
    ? readCustomModelEntries(
        instance.config !== null && typeof instance.config === "object"
          ? (instance.config as Record<string, unknown>).customModels
          : undefined,
      )
    : NO_CUSTOM_MODELS;
  const models = deriveProviderModelsForDisplay({ liveModels: props.liveModels, customModels });
  const { preferences, favoritesLoaded, favoritesMigration } = useModelPreferences(
    actions.settings,
  );
  const instancePreferences = preferences.providerModelPreferences[instanceId];
  const savedHidden = instancePreferences?.hiddenModels ?? NO_MODELS;
  const modelOrder = instancePreferences?.modelOrder ?? NO_MODELS;
  const newModelsEnabled = instancePreferences?.newModelsEnabled ?? true;
  const favoriteModels = preferences.favorites
    .filter((favorite) => favorite.provider === instanceId)
    .map((favorite) => favorite.model);

  const [filter, setFilter] = useState("");
  const [adding, setAdding] = useState("");
  const [addError, setAddError] = useState<string | null>(null);
  const [editingSlug, setEditingSlug] = useState<string | null>(null);
  // A tap before the settings stream echoes the last one must toggle from what the user sees.
  const [pendingFavorites, setPendingFavorites] = useState<
    ReadonlyMap<string, { readonly favorite: boolean; readonly over: unknown }>
  >(new Map());

  const isHidden = createModelHiddenPredicate({
    hiddenModels: savedHidden,
    modelOrder,
    newModelsEnabled,
    enabledModels: instancePreferences?.enabledModels ?? NO_MODELS,
  });
  const hiddenModels = [
    ...new Set([...savedHidden, ...models.filter(isHidden).map((model) => model.slug)]),
  ];
  const hiddenSet = new Set(hiddenModels);
  const favoriteSet = new Set(favoriteModels);
  for (const [slug, pending] of pendingFavorites) {
    if (pending.over !== actions.settings.favorites) continue;
    if (pending.favorite) favoriteSet.add(slug);
    else favoriteSet.delete(slug);
  }
  const displayModels = groupModelsForDisplay(models, {
    favoriteModels: favoriteSet,
    hiddenModels: hiddenSet,
    modelOrder,
  });
  const groupOf = (model: ServerProviderModel) =>
    favoriteSet.has(model.slug)
      ? "favorite"
      : !model.isCustom && hiddenSet.has(model.slug)
        ? "hidden"
        : "visible";
  const builtInModels = models.filter((model) => !model.isCustom);
  const allBuiltInHidden =
    builtInModels.length > 0 && builtInModels.every((model) => hiddenSet.has(model.slug));
  const normalizedFilter = filter.trim().toLowerCase();
  const filtering = models.length > FILTER_THRESHOLD && normalizedFilter.length > 0;
  const visibleModels = filtering
    ? displayModels.filter(
        (model) =>
          model.name.toLowerCase().includes(normalizedFilter) ||
          model.slug.toLowerCase().includes(normalizedFilter),
      )
    : displayModels;

  const savePreferences = (patch: ServerSettingsPatch) => actions.updateSettings(patch);
  const updateCustomModels = (next: ReadonlyArray<CustomModelDefinition>) => {
    const { config: _omit, ...rest } = instance;
    return actions.persistInstance(instanceId, {
      ...rest,
      config: nextConfigBlobWithValue(
        instance.config,
        "customModels",
        next.map(toCustomModelSetting),
      ),
    });
  };
  const setHidden = (slug: string, hidden: boolean) => {
    if (!canWritePreferences || hidden === hiddenSet.has(slug)) return;
    void savePreferences({ setModelsHidden: [{ provider: instanceId, model: slug, hidden }] });
  };
  const toggleFavorite = (slug: string) => {
    if (!canWritePreferences || !favoritesLoaded) return;
    const favorite = !favoriteSet.has(slug);
    const over = actions.settings.favorites;
    const withPending = (
      current: typeof pendingFavorites,
      entry: { readonly favorite: boolean; readonly over: unknown } | null,
    ) => {
      const next = new Map([...current].filter(([, pending]) => pending.over === over));
      if (entry) next.set(slug, entry);
      else next.delete(slug);
      return next;
    };
    setPendingFavorites((current) => withPending(current, { favorite, over }));
    void savePreferences({
      setModelFavorites: [{ provider: instanceId, model: slug, favorite }],
      ...favoritesMigration,
    }).then((saved) => {
      if (!saved) setPendingFavorites((current) => withPending(current, null));
    });
  };
  const move = (slug: string, direction: -1 | 1) => {
    const index = displayModels.findIndex((model) => model.slug === slug);
    const target = index + direction;
    if (!canWritePreferences || index < 0 || target < 0 || target >= displayModels.length) return;
    if (groupOf(displayModels[index]!) !== groupOf(displayModels[target]!)) return;
    const next = displayModels.map((model) => model.slug);
    [next[index], next[target]] = [next[target]!, next[index]!];
    void savePreferences({ setProviderModelOrder: { provider: instanceId, modelOrder: next } });
  };
  const addCustomModel = () => {
    const validated = validateCustomModelSlug(adding, models, customModels);
    if ("error" in validated) {
      setAddError(validated.error);
      return;
    }
    setAdding("");
    setAddError(null);
    setFilter("");
    void updateCustomModels([
      ...customModels,
      { slug: validated.slug, name: validated.slug, capabilities: null },
    ]);
  };
  const removeCustomModel = (slug: string) => {
    if (editingSlug === slug) setEditingSlug(null);
    void updateCustomModels(customModels.filter((entry) => entry.slug !== slug)).then((saved) => {
      if (!saved) return;
      const favorites = modelListChanges(
        favoriteModels,
        favoriteModels.filter((model) => model !== slug),
      );
      void savePreferences({
        setProviderModelOrder: {
          provider: instanceId,
          modelOrder: modelOrder.filter((model) => model !== slug),
        },
        ...(favorites.length > 0 && favoritesLoaded
          ? {
              setModelFavorites: favorites.map(({ model, selected }) => ({
                provider: instanceId,
                model,
                favorite: selected,
              })),
              ...favoritesMigration,
            }
          : {}),
      });
    });
  };

  const editingEntry =
    editingSlug !== null ? customModels.find((entry) => entry.slug === editingSlug) : undefined;
  if (editingEntry && driverKind) {
    return (
      <CustomModelEditor
        driverKind={driverKind}
        entry={editingEntry}
        builtInModels={builtInModels}
        onCancel={() => setEditingSlug(null)}
        onSave={(next) => {
          setEditingSlug(null);
          void updateCustomModels(
            customModels.map((entry) => (entry.slug === next.slug ? next : entry)),
          );
        }}
      />
    );
  }

  const favoriteCount = displayModels.filter((model) => favoriteSet.has(model.slug)).length;
  const hiddenCount = displayModels.filter(
    (model) => !model.isCustom && hiddenSet.has(model.slug),
  ).length;
  const groups = (["favorite", "visible", "hidden"] as const)
    .map((group) => ({ group, models: visibleModels.filter((model) => groupOf(model) === group) }))
    .filter((entry) => entry.models.length > 0);

  return (
    <>
      <SettingsSection
        footer={`Preferences are saved on this environment and shared across devices. ${[
          `${models.length} model${models.length === 1 ? "" : "s"}`,
          favoriteCount > 0 ? `${favoriteCount} favorite${favoriteCount === 1 ? "" : "s"}` : null,
          hiddenCount > 0 ? `${hiddenCount} hidden` : null,
        ]
          .filter(Boolean)
          .join(" · ")}.`}
      >
        <ListToggleRow
          label="Turn on new models"
          description="New models from this provider show in the picker. Existing choices stay as they are."
          disabled={!canWritePreferences}
          value={newModelsEnabled}
          onValueChange={(enabled) =>
            void savePreferences({
              setProviderNewModelsEnabled: {
                provider: instanceId,
                enabled,
                models: builtInModels.map((model) => model.slug),
              },
            })
          }
        />
        {builtInModels.length > 0 ? (
          <View className="border-t border-border-subtle">
            <ListActionRow
              icon={allBuiltInHidden ? "eye" : "eye.slash"}
              label={allBuiltInHidden ? "Show all models" : "Hide all models"}
              disabled={!canWritePreferences}
              onPress={() => {
                const nextHidden = new Set(nextHiddenModelsForBulkToggle(models, hiddenModels));
                void savePreferences({
                  setModelsHidden: builtInModels.map((model) => ({
                    provider: instanceId,
                    model: model.slug,
                    hidden: nextHidden.has(model.slug),
                  })),
                });
              }}
            />
          </View>
        ) : null}
      </SettingsSection>

      {models.length > FILTER_THRESHOLD ? (
        <AppTextInput
          accessibilityLabel="Filter models"
          value={filter}
          placeholder="Filter models"
          autoCapitalize="none"
          autoCorrect={false}
          clearButtonMode="while-editing"
          className="min-h-11 rounded-xl px-3 py-2 text-base"
          onChangeText={setFilter}
        />
      ) : null}

      {models.length === 0 ? (
        <Text className="px-2 text-foreground-muted">
          No models reported for this provider yet.
        </Text>
      ) : visibleModels.length === 0 ? (
        <Text className="px-2 text-foreground-muted">No models match.</Text>
      ) : (
        groups.map(({ group, models: groupModels }) => (
          <SettingsSection
            key={group}
            title={
              group === "favorite"
                ? "Favorites"
                : group === "hidden"
                  ? "Hidden from picker"
                  : favoriteCount > 0
                    ? "All"
                    : "Models"
            }
          >
            {groupModels.map((model, index) => {
              const position = displayModels.indexOf(model);
              const previous = displayModels[position - 1];
              const next = displayModels[position + 1];
              return (
                <ModelRow
                  key={model.slug}
                  model={model}
                  separated={index > 0}
                  favorite={group === "favorite"}
                  hidden={group === "hidden"}
                  canMoveUp={!filtering && previous !== undefined && groupOf(previous) === group}
                  canMoveDown={!filtering && next !== undefined && groupOf(next) === group}
                  canWritePreferences={canWritePreferences}
                  canManageCustom={canManageCustom}
                  onToggleFavorite={() => toggleFavorite(model.slug)}
                  onSetHidden={(hidden) => setHidden(model.slug, hidden)}
                  onMove={(direction) => move(model.slug, direction)}
                  onEdit={() => setEditingSlug(model.slug)}
                  onRemove={() =>
                    Dialog.confirm({
                      title: `Remove ${model.slug}?`,
                      message: "The custom model leaves this provider's picker.",
                      confirmText: "Remove",
                      destructive: true,
                      onConfirm: () => removeCustomModel(model.slug),
                    })
                  }
                />
              );
            })}
          </SettingsSection>
        ))
      )}

      {canManageCustom ? (
        <SettingsSection title="Custom model">
          <FieldBlock
            label="Model slug"
            description="Any model the provider accepts that it does not list. Custom models always show in the picker."
            trailing={
              <ControlPill
                variant="primary"
                label="Add"
                disabled={adding.trim().length === 0}
                onPress={addCustomModel}
              />
            }
          >
            <AppTextInput
              accessibilityLabel="Custom model slug"
              value={adding}
              placeholder={
                (driverKind ? CUSTOM_MODEL_PLACEHOLDER_BY_KIND[driverKind] : undefined) ??
                "model-slug"
              }
              autoCapitalize="none"
              autoCorrect={false}
              spellCheck={false}
              returnKeyType="done"
              className="min-h-11 rounded-xl px-3 py-2 font-mono text-sm"
              onChangeText={(value) => {
                setAdding(value);
                setAddError(null);
              }}
              onSubmitEditing={addCustomModel}
            />
            {addError ? (
              <Text
                accessibilityRole="alert"
                textRole="footnote"
                className="text-danger-foreground"
              >
                {addError}
              </Text>
            ) : null}
          </FieldBlock>
        </SettingsSection>
      ) : null}
    </>
  );
}

function ModelRow(props: {
  readonly model: ServerProviderModel;
  readonly separated: boolean;
  readonly favorite: boolean;
  readonly hidden: boolean;
  readonly canMoveUp: boolean;
  readonly canMoveDown: boolean;
  readonly canWritePreferences: boolean;
  readonly canManageCustom: boolean;
  readonly onToggleFavorite: () => void;
  readonly onSetHidden: (hidden: boolean) => void;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onEdit: () => void;
  readonly onRemove: () => void;
}) {
  const { model } = props;
  const capabilities = describeModelCapabilities(model);
  const detail = [
    model.name !== model.slug ? model.slug : null,
    model.isCustom ? "custom" : null,
    capabilities.length > 0 ? capabilities.join(" · ") : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const menuActions: MenuAction[] = [
    ...(props.canWritePreferences && !props.hidden
      ? [
          {
            id: "up",
            title: "Move up",
            image: "arrow.up",
            attributes: { disabled: !props.canMoveUp },
          },
          {
            id: "down",
            title: "Move down",
            image: "arrow.down",
            attributes: { disabled: !props.canMoveDown },
          },
        ]
      : []),
    ...(model.isCustom && props.canManageCustom
      ? [
          { id: "edit", title: "Edit name and options", image: "pencil" },
          {
            id: "remove",
            title: "Remove custom model",
            image: "trash",
            attributes: { destructive: true },
          },
        ]
      : []),
  ];
  return (
    <View
      className={cn(
        "min-h-14 flex-row items-center gap-2 py-2 pr-4 pl-2",
        props.separated && "border-t border-border-subtle",
      )}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={
          props.favorite ? `Remove ${model.name} from favorites` : `Add ${model.name} to favorites`
        }
        accessibilityState={{ selected: props.favorite, disabled: !props.canWritePreferences }}
        disabled={!props.canWritePreferences}
        hitSlop={4}
        onPress={props.onToggleFavorite}
        className="size-10 items-center justify-center"
      >
        <SymbolView
          name={props.favorite ? "star.fill" : "star"}
          size={18}
          tintColorClassName={props.favorite ? "accent-warning" : "accent-icon-muted"}
          type="monochrome"
        />
      </Pressable>
      <View className={cn("min-w-0 flex-1 gap-0.5", props.hidden && "opacity-55")}>
        <Text textRole="body" className="text-foreground" numberOfLines={1}>
          {model.name}
        </Text>
        {detail ? (
          <Text textRole="footnote" className="text-foreground-muted" numberOfLines={1}>
            {detail}
          </Text>
        ) : null}
      </View>
      {menuActions.length > 0 ? (
        <Menu
          accessible
          accessibilityRole="button"
          accessibilityLabel={`${model.name} options`}
          title={model.name}
          actions={menuActions}
          onPressAction={({ nativeEvent }) => {
            if (nativeEvent.event === "up" && props.canMoveUp) props.onMove(-1);
            else if (nativeEvent.event === "down" && props.canMoveDown) props.onMove(1);
            else if (nativeEvent.event === "edit") props.onEdit();
            else if (nativeEvent.event === "remove") props.onRemove();
          }}
        >
          <ControlPill icon="ellipsis" accessibilityLabel={`${model.name} options`} />
        </Menu>
      ) : null}
      <ThemedSwitch
        accessibilityLabel={`Show ${model.name} in the model picker`}
        disabled={!props.canWritePreferences || model.isCustom}
        value={!props.hidden}
        onValueChange={(shown) => props.onSetHidden(!shown)}
      />
    </View>
  );
}
