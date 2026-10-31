import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import { resolveDeusCapabilities, type DeusScope } from "@t3tools/contracts";
import { XIcon } from "lucide-react";
import { useDeusPanelStore } from "../../deusPanelStore";
import { useProject } from "../../state/entities";
import { useEnvironment } from "../../state/environments";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY } from "../../rightPanelLayout";
import { usePanelAnimationSettings } from "../../panelAnimations";
import { RightPanelFrame } from "../RightPanelFrame";
import { RightPanelSheet } from "../RightPanelSheet";
import { RightPanelMaximizeControl } from "../chat/PanelLayoutControls";
import { Button } from "../ui/button";
import { useDeusConversation } from "./DeusConversation";
import { useDeusVoice } from "../../deus/useDeusVoice";

export function DeusPanel({
  target,
  background = false,
}: {
  target: DeusScope;
  background?: boolean;
}) {
  const project = useProject(scopeProjectRef(target.environmentId, target.projectId));
  const environment = useEnvironment(target.environmentId);
  const maximized = useDeusPanelStore((state) => state.maximized);
  const pending = useDeusPanelStore((state) => state.pendingTarget);
  const busy = useDeusPanelStore((state) => state.busy);
  const error = useDeusPanelStore((state) => state.error);
  const sheet = useMediaQuery(RIGHT_PANEL_INLINE_LAYOUT_MEDIA_QUERY) && !maximized;
  const animations = usePanelAnimationSettings();
  const capabilities = resolveDeusCapabilities(environment?.serverConfig ?? {});
  const connected = environment?.connection.phase === "connected";
  const available = connected && !!project && capabilities.available;
  const status = !environment
    ? "Environment removed."
    : !connected
      ? connectionStatusText(environment.connection)
      : !project
        ? "Project unavailable or deleted."
        : !environment.serverConfig
          ? "Loading environment capabilities…"
          : capabilities.available
            ? "Text service available"
            : capabilities.reason === "disabled"
              ? "Deus is disabled on this environment."
              : capabilities.reason === "not-configured"
                ? "Deus needs a configured credential on this environment."
                : "This server does not advertise Deus support (legacy or unavailable).";
  const conversation = useDeusConversation({ target, available });
  const voiceAvailable = available && capabilities.available && capabilities.liveAudio;
  const voice = useDeusVoice(target, conversation.session, voiceAvailable);
  const attached =
    voice.state.cleanupRequired ||
    (voice.state.phase !== "disconnected" && voice.state.phase !== "error");
  const controlDisabled = voice.state.phase === "connecting" || voice.state.cleanupRequired;
  const close = () => {
    void useDeusPanelStore.getState().close();
  };
  const content = (
    <RightPanelFrame
      mode={sheet ? "sheet" : "inline"}
      maximized={maximized}
      open
      widthStorageKey="t3code:deus-panel-width"
    >
      <section aria-label="Project Deus" className="flex h-full min-h-0 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4 [-webkit-app-region:no-drag]">
          <h2 className="flex-1 text-sm font-medium">Deus</h2>
          <RightPanelMaximizeControl
            maximized={maximized}
            onToggle={() => useDeusPanelStore.getState().setMaximized(!maximized)}
          />
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Close Deus"
            disabled={busy}
            onClick={close}
          >
            <XIcon className="size-4" />
          </Button>
        </header>
        <div className="space-y-1 border-b border-border px-4 py-3">
          <p className="text-sm font-medium">
            {project?.title ?? "Unavailable project"} ·{" "}
            {environment?.label ?? "Unavailable environment"}
          </p>
          <p
            aria-label="Deus destination"
            className="break-all font-mono text-3xs text-muted-foreground"
          >
            {target.environmentId} / {target.projectId}
          </p>
          <p role="status" className="text-xs text-muted-foreground">
            {status}
          </p>
        </div>
        {pending ? (
          <div className="space-y-2 border-b border-border p-4 text-sm" role="alert">
            <p>
              Switch Deus destination? Stop any local voice attachment first. Workers keep running.
            </p>
            <p className="break-all font-mono text-xs">
              {pending.environmentId} / {pending.projectId}
            </p>
            <div className="flex gap-2">
              <Button
                size="sm"
                disabled={busy}
                onClick={() => {
                  void useDeusPanelStore.getState().confirmSwitch();
                }}
              >
                Stop local attachment and switch
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => useDeusPanelStore.getState().cancelSwitch()}
              >
                Keep current destination
              </Button>
            </div>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="px-4 py-2 text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <div className="space-y-2 border-b border-border px-4 py-3">
          <p role="status" aria-label="Voice status" className="text-xs text-muted-foreground">
            {!voiceAvailable
              ? "Voice unavailable at this destination."
              : !voice.permitted
                ? "Permission required to use voice at this destination."
                : `Voice: ${voice.state.phase}.`}
          </p>
          {voice.state.error ? (
            <p role="alert" className="text-sm text-destructive">
              {voice.state.error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {attached ? (
              <>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={controlDisabled}
                  onClick={voice.state.muted ? voice.resume : voice.mute}
                >
                  {voice.state.muted ? "Resume microphone" : "Mute microphone"}
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={controlDisabled}
                  onClick={voice.interrupt}
                >
                  Interrupt speech
                </Button>
                <Button size="sm" variant="outline" onClick={voice.disconnect}>
                  Disconnect voice
                </Button>
              </>
            ) : (
              <Button size="sm" disabled={!voice.ready || busy} onClick={voice.connect}>
                Connect voice
              </Button>
            )}
          </div>
          <p className="text-3xs text-muted-foreground">
            Voice controls affect this attachment only. Workers keep running.
          </p>
        </div>
        {conversation.content}
      </section>
    </RightPanelFrame>
  );
  return sheet ? (
    <RightPanelSheet
      open={!background}
      animationDurationMs={animations.active ? animations.durationMs : 0}
      onClose={close}
    >
      {content}
    </RightPanelSheet>
  ) : (
    content
  );
}
