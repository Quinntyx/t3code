import type { WebContents } from "electron";

export function allowsAppMicrophone(input: {
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
    input.mediaTypes.length !== 1 ||
    input.mediaTypes[0] !== "audio"
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
    allowsAppMicrophone({
      appUrl,
      contentsId: contents?.id,
      mainContentsId: main.id,
      mainUrl: main.getURL(),
      requestingUrl,
      mainFrame,
      mediaTypes,
    });
  main.session.setPermissionRequestHandler((contents, permission, callback, details) => {
    const mediaTypes = "mediaTypes" in details ? (details.mediaTypes ?? []) : [];
    callback(
      permission === "media" &&
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
  main.session.setPermissionCheckHandler(
    (contents, permission, requestingOrigin, details) =>
      permission === "media" &&
      [
        requestingOrigin,
        details.securityOrigin ?? requestingOrigin,
        details.requestingUrl ?? requestingOrigin,
      ].every((url) =>
        allowed(contents, url, details.isMainFrame, [details.mediaType ?? "unknown"]),
      ),
  );
}
