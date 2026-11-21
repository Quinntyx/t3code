import { describe, expect, it } from "vite-plus/test";

import { formReplayLoadOptions, makeFormReplays, type FormReplay } from "./FormReplay.ts";

const session = {};
const replay: FormReplay = {
  url: "https://codio.example/lti/login",
  session,
  postBody: {
    data: [{ type: "rawData", bytes: Buffer.from("login_hint=example") }],
    contentType: "application/x-www-form-urlencoded",
  },
  referrer: { url: "https://canvas.example/courses/1", policy: "strict-origin-when-cross-origin" },
};

describe("makeFormReplays", () => {
  it("hands a form POST to the first matching webview only", () => {
    const replays = makeFormReplays();
    replays.offer(replay, 0);
    expect(replays.claim("https://codio.example/other", session, 1)).toBeUndefined();
    expect(replays.claim(replay.url, {}, 1)).toBeUndefined();
    expect(replays.claim(replay.url, session, 1)).toBe(replay);
    expect(replays.claim(replay.url, session, 2)).toBeUndefined();
  });

  it("does not resubmit a form into a tab opened after it expired", () => {
    const replays = makeFormReplays();
    replays.offer(replay, 0);
    expect(replays.claim(replay.url, session, 30_000)).toBeUndefined();
  });
});

describe("formReplayLoadOptions", () => {
  it("sends the form body with its content type and referrer", () => {
    expect(formReplayLoadOptions(replay)).toEqual({
      postData: replay.postBody.data,
      extraHeaders: "Content-Type: application/x-www-form-urlencoded",
      httpReferrer: replay.referrer,
    });
    expect(
      formReplayLoadOptions({
        ...replay,
        postBody: { data: [], contentType: "multipart/form-data", boundary: "----Boundary" },
      }).extraHeaders,
    ).toBe("Content-Type: multipart/form-data; boundary=----Boundary");
  });
});
