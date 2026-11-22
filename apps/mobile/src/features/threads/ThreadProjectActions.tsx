import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import {
  AuthFilesystemReadScope,
  type EnvironmentId,
  type ProjectScript,
  ProjectScriptIcon,
  T3_PROJECT_FILE_NAME,
} from "@t3tools/contracts";
import { projectScriptMenuLabel } from "@t3tools/shared/projectScripts";
import { parseT3ProjectFile } from "@t3tools/shared/t3ProjectFile";
import { T, useGT } from "gt-react-native";
import { useRef, useState } from "react";
import { Pressable, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { IconButton } from "../../components/ui/IconButton";
import { ListRow } from "../../components/ui/ListRow";
import { ListSection } from "../../components/ui/ListSection";
import { ThemedSwitch } from "../../components/ui/ThemedSwitch";
import { uuidv4 } from "../../lib/uuid";
import { projectEnvironment } from "../../state/projects";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { replaceProjectAction } from "./thread-project-actions";

export function ThreadProjectActions(props: {
  readonly environmentId: EnvironmentId;
  readonly project: EnvironmentProject;
  readonly scripts: readonly ProjectScript[];
  readonly canRun: boolean;
  readonly onRun: (script: ProjectScript) => void;
}) {
  const gt = useGT();
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const canEdit = useAtomValue(
    serverEnvironment.updateSettings.permissionAtom(props.environmentId),
  );
  const canReadFiles = useEnvironmentScope(props.environmentId, AuthFilesystemReadScope);
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, "save project actions");
  const file = useEnvironmentQuery(
    props.project.workspaceRoot && canReadFiles
      ? projectEnvironment.readFile({
          environmentId: props.environmentId,
          input: { cwd: props.project.workspaceRoot, relativePath: T3_PROJECT_FILE_NAME },
        })
      : null,
  );
  const fileScripts =
    file.data?.exists && !file.data.truncated
      ? (parseT3ProjectFile(file.data.contents)?.scripts ?? [])
      : [];
  const importable = fileScripts.filter(
    (script) =>
      !props.scripts.some(
        (existing) =>
          existing.command === script.command ||
          existing.name.toLowerCase() === script.name.toLowerCase(),
      ),
  );
  const [editor, setEditor] = useState<ProjectScript | null>(null);
  const [pending, setPending] = useState(false);
  const saving = useRef(false);

  const persist = async (scripts: readonly ProjectScript[]) => {
    if (!config || !canEdit || saving.current) return false;
    saving.current = true;
    setPending(true);
    const result = await updateSettings({
      environmentId: props.environmentId,
      input: {
        patch:
          config.environment.capabilities.projectSettingsOverrides === true
            ? {
                projectSettingsOverrides: {
                  [props.project.id]: {
                    ...config.settings.projectSettingsOverrides[props.project.id],
                    defaultProjectScripts: scripts,
                  },
                },
              }
            : { projectScriptOverrides: { [props.project.id]: scripts } },
      },
    }).finally(() => {
      saving.current = false;
      setPending(false);
    });
    return result._tag === "Success";
  };
  const save = async () => {
    if (!editor || !editor.name.trim() || !editor.command.trim()) return;
    const { previewUrl, ...rest } = editor;
    const saved: ProjectScript = {
      ...rest,
      name: editor.name.trim(),
      command: editor.command.trim(),
      ...(previewUrl?.trim() ? { previewUrl: previewUrl.trim() } : {}),
    };
    if (await persist(replaceProjectAction(props.scripts, saved))) setEditor(null);
  };

  const disabled = pending || !canEdit;
  const editingExisting =
    editor !== null && props.scripts.some((script) => script.id === editor.id);
  const input = (
    key: "name" | "command" | "previewUrl",
    placeholder: string,
    label = placeholder,
  ) => (
    <TextInput
      accessibilityLabel={label}
      placeholder={placeholder}
      value={editor?.[key] ?? ""}
      multiline={key === "command"}
      autoCapitalize={key === "name" ? undefined : "none"}
      autoCorrect={key === "name" ? undefined : false}
      editable={!disabled}
      onChangeText={(value) => {
        if (editor) setEditor({ ...editor, [key]: value });
      }}
    />
  );
  const toggle = (
    key: "runOnWorktreeCreate" | "async" | "runOnSettle" | "autoOpenPreview",
    label: string,
  ) => (
    <View className="flex-row items-center justify-between gap-3">
      <Text textRole="footnote" className="min-w-0 flex-1">
        {label}
      </Text>
      <ThemedSwitch
        accessibilityLabel={label}
        value={key === "async" ? editor?.async === false : editor?.[key] === true}
        disabled={disabled}
        onValueChange={(value) => {
          if (editor) setEditor({ ...editor, [key]: key === "async" ? !value : value });
        }}
      />
    </View>
  );

  return (
    <View className="gap-3">
      <ListSection
        title={gt("Project actions")}
        footer={
          !props.canRun
            ? gt("Running actions requires a saved thread and terminal access.")
            : undefined
        }
      >
        {props.scripts.map((script) => (
          <View key={script.id} className="flex-row items-center">
            <View className="min-w-0 flex-1">
              <ListRow
                icon="play"
                label={projectScriptMenuLabel(script)}
                description={script.command}
                disabled={!props.canRun || pending}
                onPress={() => props.onRun(script)}
              />
            </View>
            {canEdit ? (
              <View className="pr-2">
                <IconButton
                  icon="pencil"
                  accessibilityLabel={gt("Edit {name}", { name: script.name })}
                  disabled={pending}
                  onPress={() => setEditor(script)}
                />
              </View>
            ) : null}
          </View>
        ))}
        {props.scripts.length === 0 ? (
          <Text textRole="footnote" className="px-4 py-4 text-foreground-muted">
            <T>No project actions configured.</T>
          </Text>
        ) : null}
        {importable.map((script) => (
          <ListRow
            key={`${script.name}:${script.command}`}
            icon="arrow.down.circle"
            label={gt("Import {name}", { name: script.name })}
            description={gt("From {file} · {command}", {
              file: T3_PROJECT_FILE_NAME,
              command: script.command,
            })}
            disabled={!canEdit || pending}
            onPress={() =>
              void persist(
                replaceProjectAction(props.scripts, {
                  ...script,
                  id: uuidv4(),
                  icon: script.icon ?? "play",
                  runOnWorktreeCreate: script.runOnWorktreeCreate ?? false,
                }),
              )
            }
          />
        ))}
        <ListRow
          icon="plus"
          label={gt("Add project action")}
          disabled={!canEdit || pending}
          onPress={() =>
            setEditor({
              id: uuidv4(),
              name: "",
              command: "",
              icon: "play",
              runOnWorktreeCreate: false,
            })
          }
        />
      </ListSection>
      {editor ? (
        <View className="gap-3 rounded-2xl bg-grouped-card p-4">
          <Text textRole="headline">{editingExisting ? gt("Edit action") : gt("New action")}</Text>
          {input("name", gt("Action name"))}
          {input("command", gt("Command"), gt("Action command"))}
          <View className="flex-row flex-wrap gap-2">
            {ProjectScriptIcon.literals.map((icon) => (
              <Pressable
                key={icon}
                accessibilityRole="radio"
                accessibilityLabel={gt("{icon} action icon", { icon })}
                accessibilityState={{ checked: editor.icon === icon }}
                disabled={pending || !canEdit}
                onPress={() => setEditor({ ...editor, icon })}
                className={
                  editor.icon === icon
                    ? "rounded-lg bg-secondary px-3 py-2"
                    : "rounded-lg bg-subtle px-3 py-2"
                }
              >
                <Text textRole="footnote">{icon}</Text>
              </Pressable>
            ))}
          </View>
          {toggle("runOnWorktreeCreate", gt("Run on worktree creation"))}
          {editor.runOnWorktreeCreate
            ? toggle("async", gt("Wait for setup before starting the agent"))
            : null}
          {toggle("runOnSettle", gt("Run when the thread settles"))}
          {input("previewUrl", gt("Preview URL (optional)"), gt("Action preview URL"))}
          {editor.previewUrl?.trim()
            ? toggle("autoOpenPreview", gt("Open preview after running"))
            : null}
          <View className="flex-row gap-2">
            <View className="flex-1">
              <Button
                label={pending ? gt("Saving…") : gt("Save action")}
                disabled={pending || !canEdit || !editor.name.trim() || !editor.command.trim()}
                onPress={() => void save()}
              />
            </View>
            <Button
              label={gt("Cancel")}
              tone="secondary"
              disabled={pending}
              onPress={() => setEditor(null)}
            />
          </View>
          {editingExisting ? (
            <Button
              label={gt("Delete action")}
              tone="danger"
              disabled={pending || !canEdit}
              onPress={() =>
                Dialog.confirm({
                  title: gt("Delete {name}?", { name: editor.name }),
                  message: gt("This removes the action from this project, not its files."),
                  confirmText: gt("Delete action"),
                  destructive: true,
                  onConfirm: () => {
                    void persist(props.scripts.filter((script) => script.id !== editor.id)).then(
                      (saved) => {
                        if (saved) setEditor(null);
                      },
                    );
                  },
                })
              }
            />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
