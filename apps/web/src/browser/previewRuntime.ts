import { useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, PreviewRuntime, PreviewSessionSnapshot } from "@t3tools/contracts";

import { isElectron } from "~/env";
import { isPreviewSupportedInRuntime } from "~/previewStateStore";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { primaryEnvironmentIdAtom } from "~/state/primaryEnvironment";
import {
  readEnvironmentSupportsServerBrowser,
  useEnvironmentSupportsServerBrowser,
} from "~/state/entities";

export function previewRuntimeFor(environmentId: EnvironmentId): PreviewRuntime | undefined {
  if (!readEnvironmentSupportsServerBrowser(environmentId)) return undefined;
  if (
    isPreviewSupportedInRuntime() &&
    environmentId !== appAtomRegistry.get(primaryEnvironmentIdAtom)
  ) {
    return undefined;
  }
  return "server";
}

export function alternatePreviewRuntime(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  serverBrowser: boolean,
  snapshot: Pick<PreviewSessionSnapshot, "runtime"> | null | undefined,
): PreviewRuntime | null {
  if (!snapshot || !serverBrowser || !isPreviewSupportedInRuntime()) return null;
  if (environmentId === primaryEnvironmentId) return null;
  return snapshot.runtime === "server" ? "desktop" : "server";
}

export function isPreviewAvailableFor(environmentId: EnvironmentId): boolean {
  return isPreviewSupportedInRuntime() || readEnvironmentSupportsServerBrowser(environmentId);
}

export function usePreviewAvailable(environmentId: EnvironmentId | null): boolean {
  const serverBrowser = useEnvironmentSupportsServerBrowser(environmentId);
  return isPreviewSupportedInRuntime() || serverBrowser;
}

export function rendersServerTabNatively(
  environmentId: EnvironmentId,
  primaryEnvironmentId: EnvironmentId | null,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "headless"> | null | undefined,
): boolean {
  return (
    isElectron &&
    snapshot?.runtime === "server" &&
    !snapshot.headless &&
    primaryEnvironmentId !== null &&
    environmentId === primaryEnvironmentId
  );
}

export function useRendersServerTabNatively(
  environmentId: EnvironmentId,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "headless"> | null | undefined,
): boolean {
  return rendersServerTabNatively(environmentId, useAtomValue(primaryEnvironmentIdAtom), snapshot);
}

/**
 * Whether this client plays a server tab's sound itself. A tab rendered as a stream owns its
 * audio here, whichever host owns the page: `headless` says the server runs it, not whether
 * this client has a webview to mute, so a CLI-hosted or remote-desktop tab is streamed too.
 */
export function useStreamsServerTabAudio(
  environmentId: EnvironmentId,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "headless"> | null | undefined,
): boolean {
  const rendersNatively = useRendersServerTabNatively(environmentId, snapshot);
  return snapshot?.runtime === "server" && !rendersNatively;
}

/** The non-hook form the tab bar and its context menu need for a list of tabs. */
export function streamsServerTabAudio(
  environmentId: EnvironmentId | null,
  snapshot: Pick<PreviewSessionSnapshot, "runtime" | "headless"> | null | undefined,
): boolean {
  if (snapshot?.runtime !== "server" || environmentId === null) return false;
  return !rendersServerTabNatively(
    environmentId,
    appAtomRegistry.get(primaryEnvironmentIdAtom),
    snapshot,
  );
}
