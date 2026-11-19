export interface FormReplay {
  readonly url: string;
  readonly session: unknown;
  readonly postBody: Electron.PostBody;
  readonly referrer: Electron.Referrer;
}

// Long enough for the open-link round trip through the server; short enough that a later tab
// at the same URL cannot resubmit the form.
const FORM_REPLAY_TTL_MS = 30_000;

/** Form POSTs opening a new tab, waiting for that tab's webview to attach. */
export const makeFormReplays = () => {
  const pending = new Map<string, { readonly replay: FormReplay; readonly expiresAt: number }>();
  return {
    offer: (replay: FormReplay, now: number): void => {
      pending.set(replay.url, { replay, expiresAt: now + FORM_REPLAY_TTL_MS });
    },
    claim: (url: string, session: unknown, now: number): FormReplay | undefined => {
      for (const [key, entry] of pending) {
        if (entry.expiresAt <= now) pending.delete(key);
      }
      const entry = pending.get(url);
      if (!entry || entry.replay.session !== session) return undefined;
      pending.delete(url);
      return entry.replay;
    },
  };
};

export const formReplayLoadOptions = ({
  postBody,
  referrer,
}: FormReplay): Electron.LoadURLOptions => ({
  postData: postBody.data,
  extraHeaders: `Content-Type: ${
    postBody.boundary === undefined
      ? postBody.contentType
      : `${postBody.contentType}; boundary=${postBody.boundary}`
  }`,
  httpReferrer: referrer,
});
