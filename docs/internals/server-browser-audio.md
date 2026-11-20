# Server browser audio

Headless Chromium offers no audio over CDP and Playwright launches it with `--mute-audio`, so a
streamed tab's sound is captured inside the page and encoded there. Scripts live in
[`ServerBrowserPage.ts`](../../apps/server/src/preview/ServerBrowserPage.ts), the wire in
[`ServerBrowserStream.ts`](../../apps/server/src/preview/ServerBrowserStream.ts), playback in
[`serverBrowserStream.ts`](../../packages/client-runtime/src/preview/serverBrowserStream.ts).

## Tracking has to precede viewers

The tracker is installed with the tab, before page script runs, and never removed: a page builds
its graph and starts its media on its own schedule, so a capture installed for the first viewer
would miss both, and removing the tracker afterwards would restore a `connect` the page may since
have wrapped. It only records — destination edges, played elements — and weakly, so a page that
builds and drops graphs costs no memory. The mixer and encoder are created per capture.

## Why `captureStream` and not `createMediaElementSource`

A media element's source association is one-shot and belongs to the page: a capture that took it
would make the page's own `createMediaElementSource` throw for the element's whole life. So an
unrouted element is tapped with `captureStream()`, which is reversible, and the element's
`muted`/`volume`, which that path ignores, are applied by a gain. The stream that call returns
has no audio track until the element has loaded media, and Chromium adds the track to that same
stream later, so a capture that finds none waits on the stream's `addtrack` rather than asking
again from an event that may precede it. When the page routes the element, the tracker sees it
and the capture lets go; the page's graph then carries it once. A page graph is captured by
mirroring each node's destination edges onto a tap, which keeps the page's processing
authoritative and makes its `disconnect` stop the sound.

## One run per document

A player resets its decoder, clock pin and queued audio when the forwarded run changes, so the
generation must follow the page's encoder timeline, not the server's capture setup. Each
document's capture announces a run id before it sends anything, and the server starts a new
generation when that id changes; a packet naming a superseded run is dropped rather than
forwarded, since its source clock started over in another document. Mute is a gain in the
client, so it never resets that run: unmuting after a stall must not anchor the backlog to now.

## Only the main frame

Every injected script returns when `window !== window.top`. Frames have independent contexts and
clocks, and one Opus stream cannot carry two without decoding and re-encoding across contexts.
Restricting capture to the tab's own document is what lets teardown be one `stop()`.

## The limits a viewer sees

WebCodecs needs a secure context, so a plain-HTTP page cannot encode and the tab reports audio as
unavailable; a tab the desktop renders has no tracker for the same reason. Each capture answers
this for its own document, so navigating to a page that can encode clears the answer even when no
viewer was attached to receive it. Cross-origin media without CORS never reaches a captured
track.
