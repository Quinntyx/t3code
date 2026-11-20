import { Button } from "../../components/ui/Button";
import { AppActivityIndicator } from "../../components/ui/AppActivityIndicator";
import * as Dialog from "../../components/ui/Dialog";
import previewStreamScript from "@t3tools/mobile-preview-stream";
import {
  previewStreamHostSetupMessage,
  previewStreamOverlayDetail,
  previewStreamPhase,
  previewStreamStatusLabel,
  type PreviewStreamControl,
  type PreviewStreamDownload,
  type PreviewStreamFileChooser,
  type PreviewStreamInput,
  type PreviewStreamPhase,
} from "@t3tools/client-runtime/preview/server-browser-stream";
import type { EnvironmentId, PreviewStreamHostSetup } from "@t3tools/contracts";
import {
  useEffect,
  useEffectEvent,
  useImperativeHandle,
  useLayoutEffect,
  useRef,
  useState,
  type Ref,
} from "react";
import { AccessibilityInfo, Platform, Pressable, TextInput, View } from "react-native";
import { WebView } from "react-native-webview";
import * as Clipboard from "expo-clipboard";

import { AppText } from "../../components/ui/AppText";
import { PdfPreview } from "../../components/PdfPreview";
import { downloadAndShareAttachment } from "../../lib/attachmentDownload";
import { beginForegroundHandoff } from "../../lib/foreground-handoff";
import { usePreviewStreamAccess } from "../../state/preview";
import { ConnectionStatusDot } from "../connection/ConnectionStatusDot";
import { previewPromptText } from "./previewPromptText";

import {
  previewStreamDocument,
  previewStreamMessage,
  type PreviewStreamConfiguration,
} from "./preview-stream-document";

export interface PreviewStreamRef {
  readonly command: (input: PreviewStreamInput) => void;
  readonly paste: () => void;
  readonly togglePictureInPicture: () => void;
}

export interface PreviewPictureInPictureState {
  readonly supported: boolean;
  readonly active: boolean;
}

type NativeStreamBridge = {
  readonly ref?: Ref<PreviewStreamRef>;
  readonly onUnauthorized: () => void;
  /** Asks for fresh access after a refusal, once `delayMs` has passed. */
  readonly onRefused: (delayMs: number) => void;
  readonly onGone?: () => void;
  readonly onViewport?: (viewport: { readonly width: number; readonly height: number }) => void;
  readonly onControl?: (control: PreviewStreamControl | null) => void;
  readonly onPictureInPicture?: (state: PreviewPictureInPictureState, detail?: string) => void;
  /** True while frames show, so commands reach the page. */
  readonly onStreamingChange?: (streaming: boolean) => void;
  readonly onPhaseChange?: (phase: PreviewStreamPhase) => void;
  readonly onErrorChange?: (failed: boolean) => void;
  readonly compact?: boolean;
  readonly pdfUri?: string | null;
  readonly environmentLabel?: string | undefined;
};

function CompactErrorBadge() {
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      className="flex-row items-center gap-1.5 rounded-full bg-black/65 px-2.5 py-1"
    >
      <ConnectionStatusDot state="error" pulse={false} size={6} />
      <AppText className="text-2xs text-white">Unavailable</AppText>
    </View>
  );
}

function PreviewStreamFallback({
  compact,
  error,
  retrying,
  paused,
  onRetry,
  onPhaseChange,
  onErrorChange,
}: {
  readonly compact?: boolean | undefined;
  readonly error: string | null;
  readonly retrying?: boolean | undefined;
  readonly paused?: boolean | undefined;
  readonly onRetry: () => void;
  readonly onPhaseChange?: ((phase: PreviewStreamPhase) => void) | undefined;
  readonly onErrorChange?: ((failed: boolean) => void) | undefined;
}) {
  const hasError = !paused && error !== null;
  const lastAnnouncedError = useRef<string | null>(null);
  const reportPhase = useEffectEvent((phase: PreviewStreamPhase) => onPhaseChange?.(phase));
  const reportError = useEffectEvent((failed: boolean) => onErrorChange?.(failed));
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports connecting phase to compact parent containers while no frame-bearing WebView is mounted
  useLayoutEffect(() => {
    reportPhase("connecting");
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports terminal access failure to compact parent containers while the stream WebView is unmounted
  useLayoutEffect(() => {
    reportError(hasError);
  }, [hasError]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- announces fallback access errors to VoiceOver on iOS where accessibilityLiveRegion is unsupported
  useEffect(() => {
    if (compact || !hasError || error === null) {
      lastAnnouncedError.current = null;
      return;
    }
    if (Platform.OS !== "ios" || lastAnnouncedError.current === error) return;
    lastAnnouncedError.current = error;
    AccessibilityInfo.announceForAccessibility(error);
  }, [compact, error, hasError]);
  return (
    <View
      className={
        compact
          ? "flex-1 items-center justify-center"
          : "flex-1 items-center justify-center gap-4 px-6"
      }
    >
      {compact ? (
        hasError ? (
          <CompactErrorBadge />
        ) : paused ? null : (
          <AppActivityIndicator colorClassName="accent-icon" />
        )
      ) : (
        <>
          {!error ? <AppActivityIndicator colorClassName="accent-icon" /> : null}
          <AppText
            accessibilityLiveRegion={error ? "polite" : "none"}
            selectable={!!error}
            className={
              error ? "text-center text-sm text-foreground-muted" : "text-sm text-foreground-muted"
            }
          >
            {error || "Connecting to remote browser…"}
          </AppText>
          {error && (
            <View className="items-center">
              <Button label="Retry" tone="secondary" loading={retrying} onPress={onRetry} />
            </View>
          )}
        </>
      )}
    </View>
  );
}

async function sendFilesToPage(chooser: PreviewStreamFileChooser, pick: boolean) {
  const body = new FormData();
  if (pick) {
    const { getDocumentAsync } = await import("expo-document-picker");
    const endHandoff = beginForegroundHandoff();
    let result: Awaited<ReturnType<typeof getDocumentAsync>>;
    try {
      result = await getDocumentAsync({ multiple: chooser.multiple, copyToCacheDirectory: true });
    } finally {
      endHandoff();
    }
    for (const asset of result.canceled ? [] : result.assets) {
      body.append("file", {
        uri: asset.uri,
        name: asset.name,
        type: asset.mimeType ?? "application/octet-stream",
      } as unknown as Blob);
    }
  }
  const response = await fetch(chooser.uploadUrl, {
    method: "POST",
    body,
    credentials: chooser.credentials ? "include" : "omit",
  });
  if (!response.ok) throw new Error((await response.text()) || "The upload was refused.");
}

function offerDownload(download: PreviewStreamDownload) {
  Dialog.alert(`Downloaded ${download.fileName}`, undefined, [
    { text: "Not now", style: "cancel" },
    {
      text: "Save or share",
      onPress: () =>
        void downloadAndShareAttachment({
          url: download.url,
          attachment: { name: download.fileName, mimeType: "application/octet-stream" },
          signal: new AbortController().signal,
        }).catch((cause: unknown) =>
          Dialog.alert(
            "Could not save the download",
            cause instanceof Error ? cause.message : undefined,
          ),
        ),
    },
  ]);
}

const MAX_REFUSALS = 3;

type NativeStreamConfiguration = Omit<PreviewStreamConfiguration, "reuseNearbyTouchProbe">;

export function PreviewStreamWebView(
  props: Omit<NativeStreamConfiguration, "access"> &
    Omit<NativeStreamBridge, "onUnauthorized" | "onRefused"> & {
      readonly environmentId: EnvironmentId;
      readonly paused?: boolean;
    },
) {
  const { access, error, isPending, refresh, retryAfter } = usePreviewStreamAccess(
    props.environmentId,
  );
  const targetKey = JSON.stringify({
    environmentId: props.environmentId,
    threadId: props.threadId,
    tabId: props.tabId,
    interactive: props.interactive,
    background: props.background,
    reuseNearbyTouchProbe: Platform.OS === "ios",
  });
  const [seeded, setSeeded] = useState<{
    readonly key: string;
    readonly access: PreviewStreamConfiguration["access"];
  } | null>(() => (access && !props.paused ? { key: targetKey, access } : null));
  const activeSeed = props.paused
    ? null
    : seeded?.key === targetKey
      ? seeded
      : access
        ? { key: targetKey, access }
        : null;
  // Keep the active WebView mounted across mid-session access outages for the same target so the painted frame survives recovery.
  if ((seeded?.key ?? null) !== (activeSeed?.key ?? null)) {
    setSeeded(activeSeed);
  }
  if (activeSeed) {
    return (
      <AuthorizedPreviewStream
        key={targetKey}
        {...props}
        initialAccess={activeSeed.access}
        access={access}
        accessError={error}
        accessPending={isPending}
        onUnauthorized={refresh}
        onRefused={retryAfter}
      />
    );
  }
  return (
    <PreviewStreamFallback
      compact={props.compact}
      error={error}
      retrying={isPending}
      paused={props.paused}
      onRetry={refresh}
      onPhaseChange={props.onPhaseChange}
      onErrorChange={props.onErrorChange}
    />
  );
}

function AuthorizedPreviewStream({
  ref,
  initialAccess,
  access,
  accessError,
  accessPending,
  ...props
}: Omit<NativeStreamConfiguration, "access"> &
  NativeStreamBridge & {
    readonly initialAccess: PreviewStreamConfiguration["access"];
    readonly access: PreviewStreamConfiguration["access"] | null;
    readonly accessError: string | null;
    readonly accessPending: boolean;
  }) {
  const [attempt, setAttempt] = useState(0);
  const processRetried = useRef(false);
  const unauthorized = useRef(0);
  const bootAccess = access ?? initialAccess;
  const initialConfiguration = JSON.stringify({
    access: bootAccess,
    accessGeneration: 0,
    threadId: props.threadId,
    tabId: props.tabId,
    interactive: props.interactive,
    background: props.background,
    reuseNearbyTouchProbe: Platform.OS === "ios",
  } satisfies PreviewStreamConfiguration);
  return (
    <PreviewStreamDocumentView
      key={attempt}
      {...props}
      ref={ref}
      bootAccess={bootAccess}
      access={access}
      accessError={accessError}
      accessPending={accessPending}
      initialConfiguration={initialConfiguration}
      onUnauthorized={() => {
        const refusals = ++unauthorized.current;
        if (refusals >= MAX_REFUSALS) return false;
        props.onRefused(refusals === 1 ? 0 : 1_000 * 2 ** (refusals - 1));
        return true;
      }}
      onRefreshAccess={() => {
        unauthorized.current = 0;
        props.onUnauthorized();
      }}
      onRetry={() => {
        processRetried.current = false;
        unauthorized.current = 0;
        setAttempt((current) => current + 1);
        props.onUnauthorized();
      }}
      onStreaming={() => {
        processRetried.current = false;
        unauthorized.current = 0;
      }}
      onRecoverProcess={() => {
        if (processRetried.current) return false;
        processRetried.current = true;
        setAttempt((current) => current + 1);
        return true;
      }}
    />
  );
}

function PreviewStreamDocumentView({
  ref,
  bootAccess,
  access,
  accessError,
  accessPending,
  initialConfiguration,
  background,
  compact,
  pdfUri,
  environmentLabel,
  onUnauthorized,
  onRefreshAccess,
  onGone,
  onViewport,
  onControl,
  onPictureInPicture,
  onStreamingChange,
  onPhaseChange,
  onErrorChange,
  onRetry,
  onStreaming,
  onRecoverProcess,
}: Omit<NativeStreamBridge, "onUnauthorized" | "onRefused"> & {
  readonly bootAccess: PreviewStreamConfiguration["access"];
  readonly access: PreviewStreamConfiguration["access"] | null;
  readonly accessError: string | null;
  readonly accessPending: boolean;
  readonly initialConfiguration: string;
  readonly background: string;
  readonly onUnauthorized: () => boolean;
  readonly onRefreshAccess: () => void;
  readonly onRetry: () => void;
  readonly onStreaming: () => void;
  readonly onRecoverProcess: () => boolean;
}) {
  const webView = useRef<WebView<object>>(null);
  const active = useRef(false);
  const failed = useRef(false);
  const bootstrapped = useRef(false);
  const appliedAccess = useRef<PreviewStreamConfiguration["access"] | null>(bootAccess);
  const accessGeneration = useRef(0);
  const bootstrapTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [status, setStatus] = useState<"connecting" | "streaming" | "error">("connecting");
  // Survives mid-session reconnects and access outages because only a target or attempt change remounts this view.
  const [hasStreamed, setHasStreamed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState(false);
  const [hostSetup, setHostSetup] = useState<PreviewStreamHostSetup | null>(null);
  const [control, setControl] = useState<PreviewStreamControl | null>(null);
  const [fileChooser, setFileChooser] = useState<PreviewStreamFileChooser | null>(null);
  const [refusedAccess, setRefusedAccess] = useState<PreviewStreamConfiguration["access"] | null>(
    null,
  );
  const [previousAccess, setPreviousAccess] = useState(access);
  if (previousAccess !== access) {
    setPreviousAccess(access);
    if (refusedAccess !== null && access !== refusedAccess) {
      setRefusedAccess(null);
    }
    setControl(null);
    setFileChooser(null);
    setStatus((current) => (current === "error" ? current : "connecting"));
  }
  const authRefused = refusedAccess !== null;
  const displayError =
    status === "error"
      ? error
      : authRefused
        ? "This session can't open the browser stream. Reconnect to try again."
        : access === null
          ? accessError
          : null;
  const hasError = displayError !== null;
  const showRetainedErrorBanner = hasError && status !== "error" && hasStreamed;
  const phase = previewStreamPhase(control, status === "streaming", hasStreamed);
  const statusLabel = previewStreamStatusLabel(phase, control);
  const announcement = compact ? null : hasError ? displayError : statusLabel;
  const lastAnnouncement = useRef<string | null>(announcement);
  const dialogRef = useRef<PreviewStreamControl["dialog"]>(null);
  const [promptText, setPromptText] = useState("");
  const answerFileChooser = (pick: boolean) => {
    const chooser = fileChooser;
    if (!chooser) return;
    setFileChooser(null);
    void sendFilesToPage(chooser, pick).catch((cause: unknown) =>
      Dialog.alert(
        "Could not send the files to the page",
        cause instanceof Error ? cause.message : undefined,
      ),
    );
  };
  const command = (input: PreviewStreamInput) =>
    webView.current?.injectJavaScript(
      `window.T3PreviewStream?.command(${JSON.stringify(input)}); true;`,
    );
  // Reads here rather than in the screen: a tab switch during the iOS paste prompt unmounts
  // this view and nulls its WebView ref, so the text can never type into another tab.
  const paste = () =>
    void Clipboard.getStringAsync().then(
      (text) => {
        if (text) command({ type: "text", text });
      },
      () => Dialog.alert("Could not read the clipboard"),
    );
  const clearBootstrapTimer = () => {
    if (bootstrapTimer.current === null) return;
    clearTimeout(bootstrapTimer.current);
    bootstrapTimer.current = null;
  };
  const fail = (message: string) => {
    if (!active.current || failed.current) return;
    failed.current = true;
    clearBootstrapTimer();
    webView.current?.injectJavaScript("window.T3PreviewStream?.stop(); true;");
    onStreamingChange?.(false);
    setControl(null);
    setFileChooser(null);
    onControl?.(null);
    setError(message);
    setStatus("error");
  };
  const bootstrapTimedOut = useEffectEvent(() =>
    fail("Browser viewer could not start. Reconnect to try again."),
  );
  const reportPhase = useEffectEvent((nextPhase: PreviewStreamPhase) => {
    onPhaseChange?.(nextPhase);
  });
  const reportError = useEffectEvent((failedState: boolean) => {
    onErrorChange?.(failedState);
  });
  const streamEnded = useEffectEvent(() => {
    onStreamingChange?.(false);
    onControl?.(null);
  });
  // The stream lives exactly as long as this view.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- starts the bootstrap timeout and stops the WebView stream when this view unmounts
  useLayoutEffect(() => {
    active.current = true;
    const view = webView.current;
    bootstrapTimer.current = setTimeout(bootstrapTimedOut, 15_000);
    return () => {
      if (bootstrapTimer.current !== null) clearTimeout(bootstrapTimer.current);
      bootstrapTimer.current = null;
      active.current = false;
      view?.injectJavaScript("window.T3PreviewStream?.stop(); true;");
      streamEnded();
    };
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports authoritative stream phase to compact parent containers without reconstructing retained-frame state
  useLayoutEffect(() => {
    reportPhase(phase);
  }, [phase]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- reports terminal stream or access failure to compact parent containers
  useLayoutEffect(() => {
    reportError(hasError);
  }, [hasError]);
  // Push refreshed credentials (or null to suspend) into the live WebView so mid-session outages keep the painted frame.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- forwards stream access updates into the imperative WebView bridge without remounting the canvas
  useLayoutEffect(() => {
    if (!active.current || failed.current) return;
    if (appliedAccess.current !== access) {
      dialogRef.current = null;
      streamEnded();
    }
    if (authRefused || !bootstrapped.current || appliedAccess.current === access) return;
    appliedAccess.current = access;
    const nextGeneration = ++accessGeneration.current;
    webView.current?.injectJavaScript(
      `window.T3PreviewStream?.updateAccess(${JSON.stringify(access)}, ${nextGeneration}); true;`,
    );
  }, [access, authRefused]);
  // Announce distinct status transitions to VoiceOver on iOS, where accessibilityLiveRegion is unsupported.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- announces stream phase and error changes to VoiceOver on iOS
  useEffect(() => {
    if (announcement === null || announcement === lastAnnouncement.current) return;
    lastAnnouncement.current = announcement;
    if (Platform.OS === "ios") AccessibilityInfo.announceForAccessibility(announcement);
  }, [announcement]);
  const [source] = useState(() => ({
    html: previewStreamDocument(initialConfiguration, previewStreamScript),
    baseUrl: Platform.OS === "android" ? "https://localhost/" : "file:///",
  }));
  useImperativeHandle(ref, () => ({
    command,
    paste,
    togglePictureInPicture: () =>
      webView.current?.injectJavaScript("window.T3PreviewStream?.pictureInPicture(); true;"),
  }));
  const processTerminated = () => {
    if (!active.current || failed.current) return;
    if (!onRecoverProcess()) fail("Browser viewer stopped. Reconnect to try again.");
  };
  return (
    <View className="flex-1" style={{ backgroundColor: background }}>
      {!compact ? (
        <View
          accessibilityElementsHidden={hasError}
          importantForAccessibility={hasError ? "no-hide-descendants" : "auto"}
          className="min-h-16 flex-row items-center justify-between gap-2 border-b border-secondary-border px-3 py-2"
        >
          <View className="flex-1 flex-row items-center gap-2">
            <ConnectionStatusDot
              state={hasError ? "error" : phase === "live" ? "connected" : "connecting"}
              pulse={!hasError && phase !== "live"}
              size={7}
            />
            <AppText
              accessibilityLiveRegion={hasError ? "none" : "polite"}
              numberOfLines={1}
              className="flex-1 text-xs text-foreground-muted"
            >
              {hasError ? "Stream disconnected" : statusLabel}
            </AppText>
          </View>
          {control?.canOperate ? (
            <Button
              label={control.controller === "you" ? "Release control" : "Take control"}
              tone="secondary"
              disabled={control.controller === "another-viewer"}
              onPress={() =>
                command({ type: control.controller === "you" ? "releaseControl" : "takeControl" })
              }
            />
          ) : phase !== "live" && environmentLabel?.trim() ? (
            <AppText
              numberOfLines={1}
              className="rounded bg-secondary px-1.5 py-0.5 font-mono text-2xs text-foreground-muted"
            >
              {environmentLabel.trim()}
            </AppText>
          ) : null}
        </View>
      ) : null}
      <View className="relative flex-1">
        <WebView<object>
          ref={webView}
          source={source}
          originWhitelist={["*"]}
          scrollEnabled={false}
          bounces={false}
          mixedContentMode="always"
          allowUniversalAccessFromFileURLs
          contentInsetAdjustmentBehavior="never"
          setSupportMultipleWindows={false}
          allowsInlineMediaPlayback
          allowsPictureInPictureMediaPlayback
          mediaPlaybackRequiresUserAction={false}
          style={{ flex: 1, backgroundColor: background }}
          onError={() => fail("Browser viewer could not load. Reconnect to try again.")}
          onHttpError={() => fail("Browser viewer could not load. Reconnect to try again.")}
          onContentProcessDidTerminate={processTerminated}
          onRenderProcessGone={processTerminated}
          onShouldStartLoadWithRequest={(request) =>
            request.url === "about:blank" || request.url === source.baseUrl
          }
          onMessage={(event) => {
            if (!active.current || failed.current) return;
            const message = previewStreamMessage(event.nativeEvent.data);
            if (message === null) return;
            const wasBootstrapped = bootstrapped.current;
            bootstrapped.current = true;
            clearBootstrapTimer();
            if (
              !wasBootstrapped &&
              !authRefused &&
              appliedAccess.current !== access &&
              message.type !== "gone" &&
              message.type !== "hostSetup" &&
              !(message.type === "status" && message.status === "error")
            ) {
              appliedAccess.current = access;
              const nextGeneration = ++accessGeneration.current;
              webView.current?.injectJavaScript(
                `window.T3PreviewStream?.updateAccess(${JSON.stringify(access)}, ${nextGeneration}); true;`,
              );
            }
            const connectionScoped =
              message.type !== "pictureInPicture" &&
              !(message.type === "status" && message.status === "error");
            if (connectionScoped && (message.accessGeneration ?? 0) !== accessGeneration.current) {
              return;
            }
            if (
              (access === null || authRefused) &&
              (message.type === "control" ||
                message.type === "unauthorized" ||
                message.type === "fileChooser" ||
                (message.type === "status" && message.status === "streaming"))
            ) {
              return;
            }
            switch (message.type) {
              case "control": {
                setControl(message);
                const previousDialog = dialogRef.current;
                dialogRef.current = message.dialog;
                setPromptText((draft) => previewPromptText(previousDialog, message.dialog, draft));
                onControl?.(message);
                return;
              }
              case "unauthorized":
                if (!onUnauthorized()) {
                  dialogRef.current = null;
                  setControl(null);
                  setFileChooser(null);
                  setStatus((current) => (current === "error" ? current : "connecting"));
                  setRefusedAccess(access);
                  appliedAccess.current = null;
                  const nextGeneration = ++accessGeneration.current;
                  webView.current?.injectJavaScript(
                    `window.T3PreviewStream?.updateAccess(null, ${nextGeneration}); true;`,
                  );
                  streamEnded();
                }
                return;
              case "gone":
                setGone(true);
                fail("This tab was closed.");
                onGone?.();
                return;
              case "hostSetup":
                setHostSetup({ need: message.need, command: message.command });
                fail(previewStreamHostSetupMessage(message));
                return;
              case "viewport":
                onViewport?.(message);
                return;
              case "clipboard":
                void Clipboard.setStringAsync(message.text).catch(() => undefined);
                return;
              case "download":
                offerDownload(message);
                return;
              case "fileChooser":
                setFileChooser(message.chooser);
                return;
              case "pictureInPicture":
                onPictureInPicture?.(message, message.detail);
                return;
              case "status": {
                if (message.status === "error") {
                  fail(message.detail ?? "Browser stream failed.");
                  return;
                }
                setStatus(message.status);
                if (message.status === "streaming") setHasStreamed(true);
                if (message.status === "connecting") {
                  // Dialogs may have closed and reopened while this viewer was disconnected.
                  dialogRef.current = null;
                  setControl(null);
                  onControl?.(null);
                }
                onStreamingChange?.(message.status === "streaming");
                if (message.status === "streaming") onStreaming();
              }
            }
          }}
        />
        {pdfUri ? (
          <View className="absolute inset-0">
            <PdfPreview key={pdfUri} uri={pdfUri} />
          </View>
        ) : null}
        {!hasError && (phase === "connecting" || phase === "awaiting-frame") && !pdfUri ? (
          <View
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            className="absolute inset-0 items-center justify-center gap-2 px-6"
            style={{ backgroundColor: background }}
          >
            <AppActivityIndicator colorClassName="accent-icon" />
            {compact ? null : (
              <>
                <AppText className="text-center text-sm text-foreground-muted">
                  Connecting to remote browser
                </AppText>
                <AppText className="text-center text-xs text-foreground-muted">
                  {previewStreamOverlayDetail(phase, environmentLabel)}
                </AppText>
              </>
            )}
          </View>
        ) : null}
        {!hasError && phase === "reconnecting" && !pdfUri ? (
          <View
            pointerEvents="none"
            accessibilityElementsHidden
            importantForAccessibility="no-hide-descendants"
            className={
              compact
                ? "absolute bottom-1.5 left-1.5"
                : "absolute inset-x-0 bottom-3 items-center px-3"
            }
          >
            <View
              className={
                compact
                  ? "flex-row items-center gap-1.5 rounded-full bg-black/65 px-2 py-1"
                  : "flex-row items-center gap-2 rounded-full border border-secondary-border bg-secondary px-3 py-1.5"
              }
            >
              <ConnectionStatusDot state="connecting" pulse size={compact ? 6 : 7} />
              <AppText
                className={compact ? "text-2xs text-white" : "text-xs text-secondary-foreground"}
              >
                {compact ? "Reconnecting…" : previewStreamOverlayDetail(phase, environmentLabel)}
              </AppText>
            </View>
          </View>
        ) : null}
        {showRetainedErrorBanner ? (
          compact ? (
            <View testID="stream-error-banner" className="absolute bottom-1.5 left-1.5">
              <CompactErrorBadge />
            </View>
          ) : (
            <View
              testID="stream-error-banner"
              className="absolute inset-x-3 bottom-3 flex-row items-center justify-between gap-3 rounded-xl border border-secondary-border bg-secondary px-3 py-2.5"
            >
              <AppText
                accessibilityLiveRegion="polite"
                selectable
                className="flex-1 text-xs text-secondary-foreground"
              >
                {displayError}
              </AppText>
              <Button
                label={authRefused ? "Reconnect" : "Retry"}
                tone="secondary"
                loading={accessPending}
                onPress={onRefreshAccess}
              />
            </View>
          )
        ) : null}
      </View>
      {!compact && fileChooser && control?.controller === "you" ? (
        <View className="absolute inset-x-3 top-16 gap-3 rounded-xl border border-secondary-border bg-secondary p-4">
          <AppText className="text-sm text-secondary-foreground">
            The page asks for {fileChooser.multiple ? "files" : "a file"}.
          </AppText>
          <View className="flex-row justify-end gap-3">
            <Button label="Cancel" tone="text" onPress={() => answerFileChooser(false)} />
            <Button
              label={`Choose ${fileChooser.multiple ? "files" : "file"}`}
              tone="secondary"
              onPress={() => answerFileChooser(true)}
            />
          </View>
        </View>
      ) : null}
      {!compact && control?.dialog ? (
        <View className="absolute inset-x-3 top-16 gap-3 rounded-xl border border-secondary-border bg-secondary p-4">
          <AppText className="text-sm text-secondary-foreground">{control.dialog.message}</AppText>
          {control.controller === "you" ? (
            <>
              {control.dialog.type === "prompt" ? (
                <TextInput
                  accessibilityLabel="Dialog response"
                  className="rounded-lg border border-input-border bg-input px-3 py-2 text-foreground"
                  placeholderTextColorClassName="accent-placeholder"
                  selectionColorClassName="accent-focus/32"
                  value={promptText}
                  onChangeText={setPromptText}
                />
              ) : null}
              <View className="flex-row justify-end gap-3">
                <Button
                  label="Dismiss"
                  tone="text"
                  onPress={() => command({ type: "dialog", accept: false })}
                />
                <Button
                  label="Accept"
                  tone="secondary"
                  onPress={() =>
                    command({
                      type: "dialog",
                      accept: true,
                      ...(control.dialog?.type === "prompt" ? { promptText } : {}),
                    })
                  }
                />
              </View>
            </>
          ) : (
            <AppText className="text-xs text-foreground-muted">Take control to respond.</AppText>
          )}
        </View>
      ) : null}
      {hasError && !showRetainedErrorBanner ? (
        <View
          testID="stream-error-overlay"
          className="absolute inset-0 items-center justify-center gap-4 px-6"
          style={{ backgroundColor: background }}
        >
          {compact ? (
            <CompactErrorBadge />
          ) : (
            <AppText
              accessibilityLiveRegion="polite"
              selectable={status !== "error"}
              className="text-center text-sm text-foreground-muted"
            >
              {displayError}
            </AppText>
          )}
          {status === "error" && hostSetup && !compact ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Copy ${hostSetup.command}`}
              className="w-full flex-row items-center gap-2 rounded-xl border border-secondary-border bg-secondary px-4 py-3"
              onPress={() => {
                void Clipboard.setStringAsync(hostSetup.command).catch(() => undefined);
              }}
            >
              <AppText selectable className="flex-1 font-mono text-sm text-secondary-foreground">
                {hostSetup.command}
              </AppText>
              <AppText className="text-xs text-foreground-muted">Copy</AppText>
            </Pressable>
          ) : null}
          {!gone && !compact ? (
            <View className="items-center">
              <Button
                label={
                  status === "error"
                    ? hostSetup
                      ? "Try again"
                      : "Reconnect"
                    : authRefused
                      ? "Reconnect"
                      : "Retry"
                }
                tone="secondary"
                loading={status !== "error" && accessPending}
                onPress={status === "error" ? onRetry : onRefreshAccess}
              />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
