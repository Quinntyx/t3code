import { useEffect, useState, useSyncExternalStore } from "react";
import { Link } from "@tanstack/react-router";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { ArrowUp, AudioLines, MicOff, Square } from "lucide-react";
import { Button } from "../components/ui/button";
import { Input } from "../components/ui/input";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../components/ui/tooltip";
import { useThreadShell } from "../state/entities";
import { cn } from "../lib/utils";
import { SpectralEdge } from "./SpectralEdge";
import {
  connectVoiceMicrophone,
  muteVoice,
  openVoiceSession,
  voiceAudio,
  voiceSession,
} from "./controller";

type Target = { readonly environmentId: string; readonly threadId: string };

const STATUS: Record<string, { readonly label: string; readonly tone: string }> = {
  preparing: { label: "Starting", tone: "bg-muted-foreground/60" },
  queued: { label: "Queued", tone: "bg-muted-foreground/60" },
  starting: { label: "Starting", tone: "bg-muted-foreground/60" },
  running: { label: "Running", tone: "bg-emerald-500" },
  waiting: { label: "Needs you", tone: "bg-amber-500" },
  completed: { label: "Done", tone: "bg-muted-foreground/40" },
  failed: { label: "Failed", tone: "bg-destructive" },
  interrupted: { label: "Stopped", tone: "bg-muted-foreground/40" },
  cancelled: { label: "Stopped", tone: "bg-muted-foreground/40" },
  rolled_back: { label: "Rolled back", tone: "bg-muted-foreground/40" },
  idle: { label: "Idle", tone: "bg-muted-foreground/40" },
};

function ThreadPill({ target }: { readonly target: Target }) {
  const shell = useThreadShell(
    scopeThreadRef(EnvironmentId.make(target.environmentId), ThreadId.make(target.threadId)),
  );
  if (!shell) return null;
  const status = STATUS[shell.latestRun?.status ?? "idle"] ?? STATUS.idle!;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={target}
      className="flex h-[34px] items-center gap-2.5 rounded-full border border-border/70 bg-background/70 px-3.5 text-xs shadow-xs backdrop-blur-md transition-colors hover:bg-accent/60"
    >
      <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", status.tone)} />
      <span className="min-w-0 flex-1 truncate font-medium text-foreground">{shell.title}</span>
      <span className="shrink-0 text-3xs text-muted-foreground">{status.label}</span>
    </Link>
  );
}

export function VoicePanel({ visible }: { readonly visible: boolean }) {
  const session = useSyncExternalStore(voiceSession.subscribe, voiceSession.getSnapshot);
  const audio = useSyncExternalStore(voiceAudio.subscribe, voiceAudio.snapshot);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a rendered Voice surface owns the client Gemini session; closing the last one ends it.
  useEffect(() => {
    void openVoiceSession().catch(() => {});
  }, []);

  const needsKey = session.status === "disabled";
  const connecting = session.status === "connecting" || audio.phase === "connecting";
  const live = ["listening", "speaking", "muted"].includes(audio.phase);
  const busy = needsKey || connecting;
  const problem = session.error ?? audio.error ?? error;
  const threads = [
    ...new Map(
      session.activity.flatMap((item) =>
        item.target ? [[`${item.target.environmentId}:${item.target.threadId}`, item.target]] : [],
      ),
    ).values(),
  ].slice(-4);

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
  const phase = audio.muted
    ? "Muted"
    : audio.phase === "speaking"
      ? "Speaking"
      : audio.phase === "listening"
        ? "Listening"
        : connecting
          ? "Connecting…"
          : null;

  return (
    <section aria-label="Voice" className="relative flex h-full min-h-0 flex-col overflow-hidden">
      {threads.length ? (
        <nav aria-label="Threads Voice is following" className="shrink-0 space-y-1.5 px-4 pt-4">
          {threads.map((target) => (
            <ThreadPill key={`${target.environmentId}:${target.threadId}`} target={target} />
          ))}
        </nav>
      ) : null}

      <div
        role="log"
        aria-label="Voice conversation"
        className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-6 py-8 wrap-anywhere scrollbar-gutter-both"
      >
        {session.messages.length === 0 ? (
          <div className="m-auto flex max-w-xs flex-col items-center gap-3 text-center">
            <AudioLines aria-hidden className="size-5 text-muted-foreground/70" />
            <p className="text-sm leading-relaxed text-muted-foreground">
              {needsKey
                ? "Voice drives the threads this window can see. Add a Gemini key on this device to start."
                : "Ask about your threads, start new work, or steer what's running. Type or talk."}
            </p>
            {needsKey ? (
              <Button
                render={<Link to="/settings/voice" hash="voice-key" />}
                variant="outline"
                size="sm"
              >
                Set up Voice
              </Button>
            ) : null}
          </div>
        ) : (
          session.messages.map((message) =>
            message.role === "user" ? (
              <p
                key={message.id}
                className="max-w-[85%] self-end rounded-2xl bg-muted px-4 py-2.75 text-sm leading-relaxed whitespace-pre-wrap text-foreground"
              >
                <span className="sr-only">You: </span>
                {message.text}
              </p>
            ) : (
              <p
                key={message.id}
                className="max-w-[540px] self-start text-base leading-7 tracking-tight whitespace-pre-wrap text-foreground/90"
              >
                <span className="sr-only">Voice: </span>
                {message.text}
              </p>
            ),
          )
        )}
      </div>

      <div className="relative isolate h-36 shrink-0">
        <SpectralEdge open={visible} connected={session.status === "connected"} />
        <div className="absolute inset-x-0 bottom-7 flex flex-col items-center gap-2 px-5">
          {problem ? (
            <p role="alert" className="max-w-[440px] text-center text-xs text-destructive">
              {problem}{" "}
              <Link to="/settings/voice" hash="voice-key" className="underline underline-offset-4">
                Voice settings
              </Link>
            </p>
          ) : phase ? (
            <p role="status" className="text-2xs tracking-wide text-muted-foreground">
              {phase}
            </p>
          ) : null}
          <form
            data-voice-composer
            data-liquid-glass=""
            className="flex h-10 w-full max-w-[440px] items-center gap-2 rounded-full border border-black/8 py-1 pr-1.5 pl-1 shadow-float surface-glass focus-within:border-ring/60 dark:border-white/8"
            onSubmit={(event) => {
              event.preventDefault();
              void send();
            }}
          >
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant={live ? "ghost" : "ghost-muted"}
                    size="icon-sm"
                    aria-label={live ? "Turn voice off" : "Talk"}
                    aria-pressed={live}
                    disabled={busy || audio.cleanupRequired}
                    onClick={toggleMicrophone}
                  />
                }
              >
                {live ? <AudioLines /> : <span className="text-xs font-medium">Aa</span>}
              </TooltipTrigger>
              <TooltipPopup>{live ? "Turn voice off" : "Talk"}</TooltipPopup>
            </Tooltip>
            <div className="min-w-0 flex-1">
              <Input
                unstyled
                aria-label="Message Voice"
                autoComplete="off"
                value={text}
                disabled={busy || sending}
                onChange={(event) => setText(event.target.value)}
              />
            </div>
            {live ? (
              <>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost-muted"
                        size="icon-sm"
                        aria-label={audio.muted ? "Unmute" : "Mute"}
                        aria-pressed={audio.muted}
                        onClick={muteVoice}
                      />
                    }
                  >
                    <MicOff />
                  </TooltipTrigger>
                  <TooltipPopup>{audio.muted ? "Unmute" : "Mute"}</TooltipPopup>
                </Tooltip>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost-muted"
                        size="icon-sm"
                        aria-label="Stop speaking"
                        onClick={() => voiceSession.interrupt()}
                      />
                    }
                  >
                    <Square />
                  </TooltipTrigger>
                  <TooltipPopup>Stop speaking</TooltipPopup>
                </Tooltip>
              </>
            ) : null}
            <Button
              variant="glass"
              size="icon-sm"
              type="submit"
              aria-label="Send"
              disabled={busy || sending || !text.trim()}
            >
              <ArrowUp />
            </Button>
          </form>
        </div>
      </div>
    </section>
  );
}
