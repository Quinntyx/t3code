export interface FormReplay {
  readonly url: string;
  readonly session: unknown;
  readonly postBody: Electron.PostBody;
  readonly referrer: Electron.Referrer;
}

// Long enough for the open-link round trip through the server; short enough that a later tab
// at the same URL cannot resubmit the form.
const FORM_REPLAY_TTL_MS = 30_000;

interface PendingFormReplay {
  readonly replay: FormReplay;
  readonly expiresAt: number;
}

/** Form POSTs opening a new tab, waiting for that tab's webview to attach. */
export const makeFormReplays = () => {
  // Partition first: two profiles can POST the same URL at once without overwriting each other.
  const pending = new Map<unknown, Map<string, PendingFormReplay>>();
  const prune = (now: number): void => {
    for (const [session, entries] of pending) {
      for (const [url, entry] of entries) {
        if (entry.expiresAt <= now) entries.delete(url);
      }
      if (entries.size === 0) pending.delete(session);
    }
  };
  return {
    offer: (replay: FormReplay, now: number): void => {
      prune(now);
      const entries = pending.get(replay.session) ?? new Map<string, PendingFormReplay>();
      entries.set(replay.url, { replay, expiresAt: now + FORM_REPLAY_TTL_MS });
      pending.set(replay.session, entries);
    },
    claim: (url: string, session: unknown, now: number): FormReplay | undefined => {
      prune(now);
      const entries = pending.get(session);
      if (entries === undefined) return undefined;
      const entry = entries.get(url);
      if (entry === undefined) return undefined;
      entries.delete(url);
      if (entries.size === 0) pending.delete(session);
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
