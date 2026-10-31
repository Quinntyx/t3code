import { describe, expect, it } from "vite-plus/test";
import { allowsAppMicrophone, installAppMediaPermissions } from "./MediaPermission.ts";
import type { Session, WebContents } from "electron";

describe("trusted app microphone permission", () => {
  const base = {
    appUrl: "t3code://app",
    contentsId: 7,
    mainContentsId: 7,
    mainUrl: "t3code://app/#/project",
    requestingUrl: "t3code://app/",
    mainFrame: true,
    mediaTypes: ["audio"],
  };
  it("allows audio only for the installed main app, including its development origin", () => {
    expect(allowsAppMicrophone(base)).toBe(true);
    expect(
      allowsAppMicrophone({
        ...base,
        appUrl: "http://localhost:5173",
        mainUrl: "http://localhost:5173/a",
        requestingUrl: "http://localhost:5173",
      }),
    ).toBe(true);
  });
  it("installs request and check handlers that deny preview contents, camera and display capture", () => {
    let request!: NonNullable<Parameters<Session["setPermissionRequestHandler"]>[0]>;
    let check!: NonNullable<Parameters<Session["setPermissionCheckHandler"]>[0]>;
    const main = {
      id: 7,
      isDestroyed: () => false,
      getURL: () => "t3code://app/",
      session: {
        setPermissionRequestHandler: (handler: typeof request) => {
          request = handler;
        },
        setPermissionCheckHandler: (handler: typeof check) => {
          check = handler;
        },
      },
    } as unknown as WebContents;
    installAppMediaPermissions(main, "t3code://app/");
    let result = false;
    request(
      main,
      "media",
      (value) => {
        result = value;
      },
      { requestingUrl: "t3code://app/", isMainFrame: true, mediaTypes: ["audio"] },
    );
    expect(result).toBe(true);
    request(
      main,
      "media",
      (value) => {
        result = value;
      },
      {
        requestingUrl: "t3code://app/",
        securityOrigin: "https://preview.example",
        isMainFrame: true,
        mediaTypes: ["audio"],
      },
    );
    expect(result).toBe(false);
    expect(
      check(main, "media", "https://preview.example", {
        requestingUrl: "t3code://app/",
        isMainFrame: true,
        mediaType: "audio",
      }),
    ).toBe(false);
    expect(check(main, "media", "t3code://app", { isMainFrame: true, mediaType: "audio" })).toBe(
      true,
    );
    expect(
      check({ ...main, id: 8 } as WebContents, "media", "t3code://app", {
        isMainFrame: true,
        mediaType: "audio",
      }),
    ).toBe(false);
    for (const mediaTypes of [["video"], ["audio", "video"]] as const) {
      request(
        main,
        "media",
        (value) => {
          result = value;
        },
        { requestingUrl: "t3code://app/", isMainFrame: true, mediaTypes: [...mediaTypes] },
      );
      expect(result).toBe(false);
    }
    expect(check(main, "display-capture", "t3code://app", { isMainFrame: true })).toBe(false);
  });
  it("denies previews, subframes, navigation away and other media", () => {
    for (const override of [
      { contentsId: 8 },
      { mainFrame: false },
      { requestingUrl: "https://evil.example" },
      { mainUrl: "https://evil.example" },
      { mediaTypes: ["video"] },
      { mediaTypes: ["audio", "video"] },
      { mediaTypes: [] },
      { mediaTypes: ["unknown"] },
      { requestingUrl: "t3://preview/" },
      { appUrl: "http://localhost:5173", requestingUrl: "http://localhost:5174" },
      { requestingUrl: "not a url" },
    ])
      expect(allowsAppMicrophone({ ...base, ...override })).toBe(false);
  });
});
