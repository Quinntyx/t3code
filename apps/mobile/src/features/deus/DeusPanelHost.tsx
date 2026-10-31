import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { resolveDeusCapabilities, type DeusScope } from "@t3tools/contracts";
import {
  FlatList,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import type { ReactNode } from "react";
import { useAdaptiveWorkspaceLayout } from "../layout/adaptive-workspace-context";
import { AppText as Text } from "../../components/ui/AppText";
import { useProject, useProjects } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useDeusPanelStore } from "./panelStore";
import { useDeusConversation } from "./useDeusConversation";
import { useDeusVoice } from "./useDeusVoice";

function Action({
  label,
  onPress,
  disabled = false,
}: {
  label: string;
  onPress(): void;
  disabled?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`min-h-11 justify-center rounded-xl border border-border px-3 py-2 ${disabled ? "opacity-40" : "active:opacity-70"}`}
    >
      <Text>{label}</Text>
    </Pressable>
  );
}

export function DeusWorkspace({ children }: { children: ReactNode }) {
  return (
    <View className="flex-1 flex-row">
      <View className="flex-1">{children}</View>
      <DeusPanelHost />
    </View>
  );
}

function DeusPanelHost() {
  const { visible, choosing, target, pendingTarget, busy, error } = useDeusPanelStore();
  const { panes } = useAdaptiveWorkspaceLayout();
  const inline = panes.contentPaneWidth >= 1040;
  const projects = useProjects();
  const { environments } = useEnvironments();
  const close = () => {
    void useDeusPanelStore.getState().close();
  };
  if (!visible) return null;
  const content = (
    <SafeAreaView className="flex-1 bg-screen">
      <KeyboardAvoidingView
        className="flex-1"
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <View className="flex-row items-center justify-between border-b border-border px-4 py-2">
          <Text className="text-lg font-semibold">Deus</Text>
          <Action label="Close Deus" onPress={close} disabled={busy} />
        </View>
        {error ? (
          <Text accessibilityRole="alert" className="px-4 py-2 text-destructive">
            {error}
          </Text>
        ) : null}
        {choosing ? (
          <View className="flex-1 gap-3 p-4">
            <Text className="font-semibold">Choose a project and environment</Text>
            <Text className="text-muted">
              This pins Deus to that destination. Worker navigation never changes it.
            </Text>
            {pendingTarget ? (
              <View className="gap-3 rounded-xl border border-border p-3">
                <Text>
                  Stop local voice and switch to {pendingTarget.environmentId} /{" "}
                  {pendingTarget.projectId}? Workers keep running.
                </Text>
                <Action
                  label="Stop local voice and switch"
                  disabled={busy}
                  onPress={() => {
                    void useDeusPanelStore.getState().confirmSwitch();
                  }}
                />
                <Action
                  label="Keep current destination"
                  disabled={busy}
                  onPress={() => useDeusPanelStore.getState().cancelSwitch()}
                />
              </View>
            ) : (
              <FlatList
                data={projects}
                keyExtractor={(project) => `${project.environmentId}/${project.id}`}
                ListEmptyComponent={<Text>No projects available. Add a project first.</Text>}
                renderItem={({ item }) => (
                  <View className="mb-2">
                    <Action
                      label={`${item.title} · ${environments.find((environment) => environment.environmentId === item.environmentId)?.label ?? item.environmentId} (${item.environmentId} / ${item.id})`}
                      disabled={busy}
                      onPress={() =>
                        useDeusPanelStore
                          .getState()
                          .select({ environmentId: item.environmentId, projectId: item.id })
                      }
                    />
                  </View>
                )}
              />
            )}
            {target && !pendingTarget ? (
              <Action
                label="Keep current destination"
                onPress={() => useDeusPanelStore.getState().cancelSwitch()}
              />
            ) : null}
          </View>
        ) : null}
        {target ? (
          <View className="flex-1" style={choosing ? { display: "none" } : undefined}>
            <ProjectPanel key={`${target.environmentId}/${target.projectId}`} target={target} />
          </View>
        ) : null}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
  return inline ? (
    <View className="border-l border-border" style={{ width: 400 }}>
      {content}
    </View>
  ) : (
    <Modal visible presentationStyle="pageSheet" animationType="slide" onRequestClose={close}>
      {content}
    </Modal>
  );
}

function ProjectPanel({ target }: { target: DeusScope }) {
  const project = useProject(scopeProjectRef(target.environmentId, target.projectId));
  const { environments } = useEnvironments();
  const environment = environments.find((item) => item.environmentId === target.environmentId);
  const capabilities = resolveDeusCapabilities(environment?.serverConfig ?? {});
  const connected = environment?.connection.phase === "connected";
  const available = connected && !!project && capabilities.available;
  const status = !environment
    ? "Environment removed."
    : !connected
      ? connectionStatusText(environment.connection)
      : !project
        ? "Project unavailable or deleted."
        : !capabilities.available
          ? capabilities.reason === "disabled"
            ? "Deus is disabled on this environment."
            : capabilities.reason === "not-configured"
              ? "Configure a Deus credential on this environment."
              : "This server does not advertise Deus support."
          : "Text service available.";
  const conversation = useDeusConversation(target, available);
  const voiceAvailable = available && capabilities.available && capabilities.liveAudio;
  const voice = useDeusVoice(target, conversation.session, voiceAvailable);
  const attached =
    voice.state.cleanupRequired ||
    (voice.state.phase !== "disconnected" && voice.state.phase !== "error");
  const controlDisabled = voice.state.phase === "connecting" || voice.state.cleanupRequired;
  const header = (
    <>
      <View className="gap-2 border-b border-border p-4">
        <Text className="font-semibold">
          {project?.title ?? "Unavailable project"} ·{" "}
          {environment?.label ?? "Unavailable environment"}
        </Text>
        <Text className="text-xs text-muted">
          {target.environmentId} / {target.projectId}
        </Text>
        <Text accessibilityLiveRegion="polite" className="text-sm text-muted">
          {status}
        </Text>
        <Action
          label="Change Deus destination"
          onPress={() => useDeusPanelStore.getState().openPicker()}
        />
      </View>
      <View className="gap-2 border-b border-border px-4 py-3">
        <Text accessibilityLiveRegion="polite">
          {!voiceAvailable
            ? "Voice unavailable at this destination. Text remains independent."
            : !voice.permitted
              ? "Permission required for voice."
              : !voice.nativeAvailable
                ? "Native voice is unavailable in this binary. Text remains available."
                : `Voice: ${voice.state.phase}.`}
        </Text>
        {voice.state.error ? (
          <Text accessibilityRole="alert" className="text-destructive">
            {voice.state.error}
          </Text>
        ) : null}
        <View className="flex-row flex-wrap gap-2">
          {attached ? (
            <>
              <Action
                label={voice.state.muted ? "Resume microphone" : "Mute microphone"}
                disabled={controlDisabled}
                onPress={voice.state.muted ? voice.resume : voice.mute}
              />
              <Action
                label="Interrupt speech"
                disabled={controlDisabled}
                onPress={voice.interrupt}
              />
              <Action
                label={voice.state.cleanupRequired ? "Retry voice cleanup" : "Disconnect voice"}
                onPress={voice.disconnect}
              />
            </>
          ) : (
            <Action label="Connect voice" disabled={!voice.ready} onPress={voice.connect} />
          )}
        </View>
      </View>
      <Text accessibilityLiveRegion="polite" className="px-4 py-2 text-xs text-muted">
        {conversation.status}
      </Text>
      {conversation.error ? (
        <Text accessibilityRole="alert" className="px-4 text-destructive">
          {conversation.error}
        </Text>
      ) : null}
      {!conversation.session || conversation.error ? (
        <View className="px-4 py-2">
          <Action
            label="Refresh conversation"
            onPress={conversation.refresh}
            disabled={!available}
          />
        </View>
      ) : null}
    </>
  );
  return (
    <>
      <FlatList
        className="flex-1"
        ListHeaderComponent={header}
        data={conversation.transcripts}
        keyboardShouldPersistTaps="handled"
        keyExtractor={(row) => row.id}
        accessibilityLabel="Deus transcript"
        ListEmptyComponent={
          <Text className="p-4 text-muted">
            This project conversation is separate from worker threads.
          </Text>
        }
        renderItem={({ item }) => (
          <View className="gap-1 px-4 py-3">
            <Text className="text-xs font-semibold text-muted">
              {item.role === "human" ? "You" : "Deus"} · Conversation {item.conversation}
            </Text>
            <Text selectable>{item.text}</Text>
          </View>
        )}
      />
      <View className="gap-2 border-t border-border p-4">
        <TextInput
          className="min-h-11 max-h-32 rounded-xl border border-border p-3 text-foreground"
          accessibilityLabel="Message Deus"
          placeholder="Coordinate work in this project…"
          value={conversation.text}
          onChangeText={conversation.setText}
          multiline
          maxLength={16000}
          editable={!!conversation.session && !conversation.sending}
        />
        <Text className="text-xs text-muted">
          Workers require approval; new worktrees are not allowed. Closing only stops local voice,
          never workers.
        </Text>
        <Action
          label={conversation.sending ? "Sending…" : "Send message"}
          disabled={!conversation.canSend}
          onPress={() => {
            void conversation.submit();
          }}
        />
      </View>
    </>
  );
}
