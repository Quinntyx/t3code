import type { WebContents } from "electron";

/** Only the app itself captures: its microphone, or getDisplayMedia (an empty list) for previews. */
export function allowsAppMedia(input: {
  readonly appUrl: string;
  readonly contentsId: number | undefined;
  readonly mainContentsId: number;
  readonly mainUrl: string;
  readonly requestingUrl: string;
  readonly mainFrame: boolean;
  readonly mediaTypes: readonly string[];
}) {
  if (
    input.contentsId !== input.mainContentsId ||
    !input.mainFrame ||
    input.mediaTypes.length > 1 ||
    (input.mediaTypes.length === 1 && input.mediaTypes[0] !== "audio")
  )
    return false;
  try {
    const app = new URL(input.appUrl);
    return [input.mainUrl, input.requestingUrl].every((value) => {
      const url = new URL(value);
      return (
        url.protocol === app.protocol && url.host === app.host && !url.username && !url.password
      );
    });
  } catch {
    return false;
  }
}

export function installAppMediaPermissions(main: WebContents, appUrl: string) {
  const allowed = (
    contents: WebContents | null,
    requestingUrl: string,
    mainFrame: boolean,
    mediaTypes: readonly string[],
  ) =>
    !main.isDestroyed() &&
    allowsAppMedia({
      appUrl,
      contentsId: contents?.id,
      mainContentsId: main.id,
      mainUrl: main.getURL(),
      requestingUrl,
      mainFrame,
      mediaTypes,
    });
  // The main window shares the default session, whose prior handler-less behavior granted the rest.
  // Display capture stays with the app because preview recording's display-media handler picks its tab.
  main.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission !== "media" && permission !== "display-capture") return callback(true);
    const mediaTypes = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
    callback(
      allowed(contents, details.requestingUrl, details.isMainFrame, mediaTypes) &&
        allowed(
          contents,
          "securityOrigin" in details
            ? (details.securityOrigin ?? details.requestingUrl)
            : details.requestingUrl,
          details.isMainFrame,
          mediaTypes,
        ),
    );
  });
  main.session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) =>
    permission !== "media" && permission !== "display-capture"
      ? true
      : [
          requestingOrigin,
          details.securityOrigin ?? requestingOrigin,
          details.requestingUrl ?? requestingOrigin,
        ].every((url) =>
          allowed(
            contents,
            url,
            details.isMainFrame,
            permission === "media" ? [details.mediaType ?? "unknown"] : [],
          ),
        ),
  );
}
