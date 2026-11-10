/* oxlint-disable react/no-array-index-key -- Snapshot outputs have no IDs; ordinals identify them within a cell. */
import { useIsFocused, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type {
  EnvironmentId,
  PycellsNotebookCell,
  PycellsNotebookKernel,
  ThreadId,
} from "@t3tools/contracts";
import { Image } from "expo-image";
import { useState, useSyncExternalStore } from "react";
import { AppState, Platform, Pressable, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/ui/AppText";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { SymbolView } from "../../components/ui/AppSymbol";
import { tryOpenExternalUrl } from "../../lib/openExternalUrl";
import { SelectableMarkdownText } from "../../native/SelectableMarkdownText";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useMarkdownPreviewStyles } from "../files/FileMarkdownPreview";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";

type NotebookTarget = { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
const subscribeAppState = (notify: () => void) => {
  const subscription = AppState.addEventListener("change", notify);
  return () => subscription.remove();
};
const appActive = () => AppState.currentState === "active";

export function ThreadNotebookSheet({ route }: StaticScreenProps<NotebookTarget>) {
  const navigation = useNavigation();
  const focused = useIsFocused();
  const active = useSyncExternalStore(subscribeAppState, appActive, () => false);
  return (
    <View className="flex-1 bg-sheet">
      <SheetHeader title="Notebook" onClose={() => navigation.goBack()} />
      <NotebookContent
        key={scopedThreadKey(route.params)}
        target={route.params}
        visible={focused && active}
      />
    </View>
  );
}

function NotebookContent({ target, visible }: { target: NotebookTarget; visible: boolean }) {
  const insets = useSafeAreaInsets();
  const query = useEnvironmentQuery(
    visible
      ? serverEnvironment.threadNotebook({
          environmentId: target.environmentId,
          input: { threadId: target.threadId },
        })
      : null,
  );
  const [kernelId, setKernelId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const kernels = query.data?.kernels ?? [];
  const kernel = kernels.find((entry) => entry.id === kernelId) ?? kernels[0];
  const toggle = (key: string) => setCollapsed((current) => ({ ...current, [key]: !current[key] }));
  return (
    <ScrollView
      className="flex-1"
      nestedScrollEnabled
      contentContainerStyle={{ padding: 12, paddingBottom: Math.max(insets.bottom, 16), gap: 12 }}
    >
      {query.error ? (
        <View className="gap-2">
          <Text accessibilityRole="alert" className="text-sm text-danger">
            Could not load notebook. {query.error}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry notebook"
            onPress={query.refresh}
            className="min-h-11 justify-center"
          >
            <Text className="text-sm text-link">Retry</Text>
          </Pressable>
        </View>
      ) : null}
      {kernels.length > 1 ? (
        <View className="flex-row flex-wrap gap-2">
          {kernels.map((entry) => (
            <Pressable
              key={entry.id}
              accessibilityRole="button"
              accessibilityLabel={`Kernel ${entry.name}`}
              accessibilityState={{ selected: entry.id === kernel?.id }}
              onPress={() => setKernelId(entry.id)}
              className={
                entry.id === kernel?.id
                  ? "min-h-11 justify-center rounded-xl bg-subtle-strong px-3"
                  : "min-h-11 justify-center rounded-xl bg-subtle px-3"
              }
            >
              <Text className="text-sm text-foreground">{entry.name}</Text>
            </Pressable>
          ))}
        </View>
      ) : null}
      {kernel ? (
        <>
          <View className="gap-1">
            <Text className="text-sm font-t3-bold text-foreground">
              {kernel.name} · {kernel.running ? "Running" : "Idle"}
            </Text>
            <Text numberOfLines={2} className="text-xs text-foreground-muted">
              {kernel.notebookPath}
            </Text>
          </View>
          {kernel.cells.length === 0 ? (
            <Text className="py-6 text-center text-sm text-foreground-muted">
              No cells in this kernel yet.
            </Text>
          ) : (
            kernel.cells.map((cell) => (
              <NotebookCell
                key={JSON.stringify([kernel.id, cell.id])}
                cell={cell}
                kernel={kernel}
                collapsed={collapsed}
                toggle={toggle}
              />
            ))
          )}
        </>
      ) : (
        <Text className="py-6 text-center text-sm text-foreground-muted">
          {query.isPending
            ? "Loading notebook…"
            : query.error
              ? "Notebook unavailable."
              : "No notebook cells yet."}
        </Text>
      )}
    </ScrollView>
  );
}

function NotebookCell({
  cell,
  kernel,
  collapsed,
  toggle,
}: {
  cell: PycellsNotebookCell;
  kernel: PycellsNotebookKernel;
  collapsed: Record<string, boolean>;
  toggle: (key: string) => void;
}) {
  const { nativeTextStyle } = useMarkdownPreviewStyles();
  const { appearance } = useAppearancePreferences();
  const codeStyle = {
    fontFamily: appearance.codeFontFamily ?? (Platform.OS === "ios" ? "Menlo" : "monospace"),
  };
  const key = (part: string) => JSON.stringify([kernel.id, cell.id, part]);
  const isCollapsed = (part: string) => collapsed[key(part)] ?? false;
  const count = cell.executionCount ?? " ";
  return (
    <View className="overflow-hidden rounded-xl border border-border">
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Cell ${cell.index}`}
        accessibilityState={{ expanded: !isCollapsed("cell") }}
        onPress={() => toggle(key("cell"))}
        className="min-h-11 flex-row items-center gap-2 px-3"
      >
        <SymbolView
          name={isCollapsed("cell") ? "chevron.right" : "chevron.down"}
          size={12}
          tintColorClassName="accent-foreground-muted"
        />
        <Text className="flex-1 text-xs text-foreground-muted">Cell {cell.index}</Text>
        <Text className="text-xs text-foreground-muted">{cell.cellType}</Text>
      </Pressable>
      {!isCollapsed("cell") ? (
        <>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Toggle source for cell ${cell.index}`}
            accessibilityState={{ expanded: !isCollapsed("source") }}
            onPress={() => toggle(key("source"))}
            className="min-h-11 flex-row items-center gap-2 px-3"
          >
            <SymbolView
              name={isCollapsed("source") ? "chevron.right" : "chevron.down"}
              size={12}
              tintColorClassName="accent-link"
            />
            <Text style={codeStyle} className="text-xs text-link">
              {cell.cellType === "code" ? `In [${count}]:` : "Source"}
            </Text>
          </Pressable>
          {!isCollapsed("source") ? (
            <View className="px-3 pb-3">
              {cell.cellType === "markdown" ? (
                <SelectableMarkdownText
                  markdown={cell.source}
                  textStyle={nativeTextStyle}
                  onLinkPress={(href) => void tryOpenExternalUrl(href, "markdown-link")}
                />
              ) : (
                <View className="rounded-lg bg-md-code-bg p-3">
                  <Text selectable style={codeStyle} className="text-xs text-md-code-text">
                    {cell.source || " "}
                  </Text>
                </View>
              )}
            </View>
          ) : null}
          {cell.outputs.length > 0 ? (
            <View className="border-t border-border">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Toggle outputs for cell ${cell.index}`}
                accessibilityState={{ expanded: !isCollapsed("outputs") }}
                onPress={() => toggle(key("outputs"))}
                className="min-h-11 flex-row items-center gap-2 px-3"
              >
                <SymbolView
                  name={isCollapsed("outputs") ? "chevron.right" : "chevron.down"}
                  size={12}
                  tintColorClassName="accent-foreground-muted"
                />
                <Text
                  style={codeStyle}
                  className="text-xs text-foreground-muted"
                >{`Out[${count}]:`}</Text>
              </Pressable>
              {!isCollapsed("outputs") ? (
                <View className="gap-3 px-3 pb-3">
                  {cell.outputs.map((output, index) =>
                    output.kind === "image" ? (
                      <NotebookImage
                        key={index}
                        uri={`data:${output.mimeType};base64,${output.data}`}
                        label={`Cell ${cell.index} output ${index + 1}`}
                      />
                    ) : (
                      <Text
                        key={index}
                        selectable
                        style={codeStyle}
                        className={
                          output.kind === "error"
                            ? "text-xs text-danger"
                            : "text-xs text-foreground"
                        }
                      >
                        {output.text}
                      </Text>
                    ),
                  )}
                </View>
              ) : null}
            </View>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function NotebookImage({ uri, label }: { uri: string; label: string }) {
  const [aspectRatio, setAspectRatio] = useState(1);
  return (
    <Image
      source={{ uri }}
      accessibilityLabel={label}
      contentFit="contain"
      style={{ width: "100%", aspectRatio }}
      onLoad={({ source }) => {
        if (source.width > 0 && source.height > 0) setAspectRatio(source.width / source.height);
      }}
    />
  );
}
