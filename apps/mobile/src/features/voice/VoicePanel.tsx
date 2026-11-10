import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Platform, Pressable, ScrollView, View, type ScrollViewInstance } from "react-native";
import { KeyboardAvoidingView } from "react-native-keyboard-controller";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text, AppTextInput as TextInput } from "../../components/ui/AppText";
import { SymbolView, type AppSymbolName } from "../../components/ui/AppSymbol";
import { GlassSurface } from "../../components/ui/GlassSurface";
import { SheetHeader } from "../../components/ui/SheetHeader";
import { cn } from "../../lib/cn";
import { useThreadShell } from "../../state/entities";
import {
  connectVoiceMicrophone,
  muteVoice,
  retainVoice,
  voiceAudio,
  voiceSession,
} from "./controller";
import { VoiceGlow } from "./VoiceGlow";

export interface VoiceThreadTarget {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}

const STATUS: Record<string, { readonly label: string; readonly tone: string }> = {
  preparing: { label: "Starting", tone: "bg-foreground-muted" },
  queued: { label: "Queued", tone: "bg-foreground-muted" },
  starting: { label: "Starting", tone: "bg-foreground-muted" },
  running: { label: "Running", tone: "bg-adaptive-emerald-600-400" },
  waiting: { label: "Needs you", tone: "bg-adaptive-amber-700-400" },
  completed: { label: "Done", tone: "bg-foreground-tertiary" },
  failed: { label: "Failed", tone: "bg-danger" },
  interrupted: { label: "Stopped", tone: "bg-foreground-tertiary" },
  cancelled: { label: "Stopped", tone: "bg-foreground-tertiary" },
  rolled_back: { label: "Rolled back", tone: "bg-foreground-tertiary" },
  idle: { label: "Idle", tone: "bg-foreground-tertiary" },
};

function ThreadPill(props: {
  readonly target: VoiceThreadTarget;
  readonly onOpen: (target: VoiceThreadTarget) => void;
}) {
  const shell = useThreadShell(scopeThreadRef(props.target.environmentId, props.target.threadId));
  if (!shell) return null;
  const status = STATUS[shell.latestRun?.status ?? "idle"] ?? STATUS.idle!;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${shell.title}, ${status.label}`}
      onPress={() => props.onOpen(props.target)}
      className="h-10 flex-row items-center gap-2.5 rounded-full border border-border bg-card px-4 active:bg-subtle"
    >
      <View className={cn("size-1.5 rounded-full", status.tone)} />
      <Text numberOfLines={1} className="min-w-0 flex-1 text-sm font-medium text-foreground">
        {shell.title}
      </Text>
      <Text className="text-xs text-foreground-muted">{status.label}</Text>
    </Pressable>
  );
}

function ComposerButton(props: {
  readonly icon: AppSymbolName;
  readonly label: string;
  readonly onPress: () => void;
  readonly disabled?: boolean;
  readonly selected?: boolean;
  readonly prominent?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={props.label}
      accessibilityState={{ disabled: !!props.disabled, selected: !!props.selected }}
      disabled={props.disabled}
      onPress={props.onPress}
      hitSlop={4}
      className={cn(
        "size-9 items-center justify-center rounded-full",
        props.prominent ? "bg-prominent-action" : props.selected ? "bg-subtle" : undefined,
        props.disabled && "opacity-40",
      )}
    >
      <SymbolView
        name={props.icon}
        size={17}
        weight="semibold"
        tintColorClassName={
          props.prominent ? "accent-prominent-action-foreground" : "accent-foreground"
        }
      />
    </Pressable>
  );
}

/**
 * Voice's conversation, the threads it is following and its composer. A sheet on phones and
 * the thread's inspector on wide layouts; either keeps the session open while mounted.
 */
export function VoicePanel(props: {
  readonly presentation: "sheet" | "inspector";
  readonly headerInset?: number;
  readonly onClose: () => void;
  readonly onOpenThread: (target: VoiceThreadTarget) => void;
  readonly onOpenSettings: () => void;
}) {
  const session = useSyncExternalStore(voiceSession.subscribe, voiceSession.getSnapshot);
  const audio = useSyncExternalStore(voiceAudio.subscribe, voiceAudio.snapshot);
  const insets = useSafeAreaInsets();
  const log = useRef<ScrollViewInstance>(null);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a mounted Voice panel owns the client Gemini session; unmounting the last one ends it.
  useEffect(() => retainVoice(), []);

  const needsKey = session.status === "disabled";
  const connecting = session.status === "connecting" || audio.phase === "connecting";
  const live = ["listening", "speaking", "muted"].includes(audio.phase);
  const busy = needsKey || connecting;
  const problem = session.error ?? audio.error ?? error;
  const threads = [
    ...new Map(
      session.activity.flatMap((item) =>
        item.target
          ? [
              [
                `${item.target.environmentId}:${item.target.threadId}`,
                {
                  environmentId: EnvironmentId.make(item.target.environmentId),
                  threadId: ThreadId.make(item.target.threadId),
                },
              ] as const,
            ]
          : [],
      ),
    ).values(),
  ].slice(-4);
  const phase = audio.muted
    ? "Muted"
    : audio.phase === "speaking"
      ? "Speaking"
      : audio.phase === "listening"
        ? "Listening"
        : connecting
          ? "Connecting…"
          : null;

  const send = async () => {
    if (!text.trim() || sending) return;
    setError(null);
    setSending(true);
    const value = text;
    const sent = await voiceSession.sendText(value).then(
      () => true,
      () => false,
    );
    setSending(false);
    if (sent) setText((current) => (current === value ? "" : current));
    else setError("Couldn't send. Check your device key and connection.");
  };
  const toggleMicrophone = () => {
    setError(null);
    if (live) void voiceAudio.disconnect();
    else void connectVoiceMicrophone().catch(() => setError("The microphone couldn't connect."));
  };

  return (
    <View
      collapsable={false}
      className={cn(
        "flex-1 bg-sheet",
        props.presentation === "inspector" && "ios:border-l ios:border-border",
      )}
    >
      {props.headerInset ? <View style={{ height: props.headerInset }} /> : null}
      <SheetHeader
        title="Voice"
        presentation={props.presentation === "sheet" ? "native" : "inline"}
        accessibilityLabel="Close Voice"
        onClose={props.onClose}
        trailing={
          <ComposerButton icon="gearshape" label="Voice settings" onPress={props.onOpenSettings} />
        }
      />
      <KeyboardAvoidingView automaticOffset behavior="padding" className="flex-1">
        <ScrollView
          ref={log}
          className="flex-1"
          contentInsetAdjustmentBehavior={
            Platform.OS === "ios" && props.presentation === "sheet" ? "automatic" : "never"
          }
          keyboardDismissMode="interactive"
          keyboardShouldPersistTaps="handled"
          contentContainerClassName="grow gap-5 px-5 pt-3 pb-6"
          onContentSizeChange={() => log.current?.scrollToEnd({ animated: true })}
        >
          {threads.length ? (
            <View accessibilityLabel="Threads Voice is following" className="gap-2">
              {threads.map((target) => (
                <ThreadPill
                  key={`${target.environmentId}:${target.threadId}`}
                  target={target}
                  onOpen={props.onOpenThread}
                />
              ))}
            </View>
          ) : null}
          {session.messages.length === 0 ? (
            <View className="m-auto max-w-xs items-center gap-3 py-10">
              <SymbolView name="waveform" size={22} tintColorClassName="accent-foreground-muted" />
              <Text className="text-center text-sm leading-relaxed text-foreground-muted">
                {needsKey
                  ? "Voice drives the threads this device can see. Add a Gemini key on this device to start."
                  : "Ask about your threads, start new work, or steer what's running. Type or talk."}
              </Text>
              {needsKey ? (
                <Pressable
                  accessibilityRole="button"
                  onPress={props.onOpenSettings}
                  className="mt-1 h-9 justify-center rounded-full border border-border px-4 active:bg-subtle"
                >
                  <Text className="text-sm font-medium text-foreground">Set up Voice</Text>
                </Pressable>
              ) : null}
            </View>
          ) : (
            session.messages.map((message) =>
              message.role === "user" ? (
                <Text
                  key={message.id}
                  accessibilityLabel={`You: ${message.text}`}
                  className="max-w-[85%] self-end overflow-hidden rounded-2xl bg-subtle px-4 py-2.5 text-[15px] leading-relaxed text-foreground"
                >
                  {message.text}
                </Text>
              ) : (
                <Text
                  key={message.id}
                  accessibilityLabel={`Voice: ${message.text}`}
                  className="self-start text-[17px] leading-7 text-foreground"
                >
                  {message.text}
                </Text>
              ),
            )
          )}
        </ScrollView>

        <View
          className="relative justify-end"
          style={{ minHeight: 132, paddingBottom: Math.max(insets.bottom, 14) }}
        >
          <VoiceGlow live={live && audio.phase !== "muted"} />
          <View className="items-center gap-2 px-4">
            {problem ? (
              <Text
                accessibilityRole="alert"
                className="text-center text-xs text-danger"
                onPress={props.onOpenSettings}
              >
                {problem} <Text className="text-xs text-danger underline">Voice settings</Text>
              </Text>
            ) : phase ? (
              <Text
                accessibilityLiveRegion="polite"
                className="text-[11px] tracking-wide text-foreground-muted"
              >
                {phase}
              </Text>
            ) : null}
            <View
              className={cn(
                "w-full max-w-[520px] overflow-hidden rounded-full",
                Platform.OS === "ios" && "shadow-[0_6px_28px] shadow-adaptive-black-a15-a35",
              )}
            >
              <GlassSurface
                chrome="none"
                fallbackClassName="border border-composer-border bg-composer-surface"
                glassEffectStyle="regular"
                pointerEvents="none"
                tintColor="transparent"
                style={{ position: "absolute", inset: 0, borderRadius: 999 }}
              >
                {null}
              </GlassSurface>
              <View className="h-12 flex-row items-center gap-1.5 py-1.5 pr-1.5 pl-1.5">
                <ComposerButton
                  icon={live ? "waveform" : "mic"}
                  label={live ? "Stop talking" : "Talk"}
                  selected={live}
                  disabled={busy || audio.cleanupRequired}
                  onPress={toggleMicrophone}
                />
                <TextInput
                  accessibilityLabel="Message Voice"
                  placeholder={live ? "Listening… or type" : "Message Voice"}
                  placeholderTextColorClassName="accent-placeholder"
                  cursorColorClassName="accent-focus"
                  selectionColorClassName="accent-focus/32"
                  className="min-w-0 flex-1 px-1 font-sans text-base text-foreground"
                  editable={!busy && !sending}
                  returnKeyType="send"
                  submitBehavior="submit"
                  value={text}
                  onChangeText={setText}
                  onSubmitEditing={() => void send()}
                />
                {live ? (
                  <>
                    <ComposerButton
                      icon="mic.slash"
                      label={audio.muted ? "Unmute" : "Mute"}
                      selected={audio.muted}
                      onPress={muteVoice}
                    />
                    <ComposerButton
                      icon="stop.fill"
                      label="Stop speaking"
                      onPress={() => voiceSession.interrupt()}
                    />
                  </>
                ) : null}
                <ComposerButton
                  icon="arrow.up"
                  label="Send"
                  prominent
                  disabled={busy || sending || !text.trim()}
                  onPress={() => void send()}
                />
              </View>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </View>
  );
}
