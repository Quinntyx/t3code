import { GUEST_RENDER_ROUTE, GUEST_SHARE_PARAM } from "@t3tools/contracts";
import {
  type HtmlRenderReference,
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFrameHeight,
  htmlRenderResult,
  htmlRenderThemeFragment,
  htmlRenderThemeMessage,
  readHtmlRenderContentHeight,
  readHtmlRenderLinkRequest,
} from "@t3tools/shared/htmlRender";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { Skeleton } from "~/components/ui/skeleton";
import { useHtmlRenderTheme } from "~/hooks/useHtmlRenderTheme";
import { observeResize } from "~/lib/observeResize";
import { cn } from "~/lib/utils";

/**
 * A visual the agent published, as the guest sees it. The server sends it with a sandbox CSP and
 * the frame is sandboxed too, so the page runs scripts in an opaque origin. It can size itself
 * and ask to open a web link; it cannot reach the guest's session.
 */
export function GuestHtmlRender({
  itemId,
  reference,
  shareId,
}: {
  readonly itemId: string;
  readonly reference: HtmlRenderReference;
  readonly shareId: string;
}) {
  const theme = useHtmlRenderTheme();
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  const [contentHeight, setContentHeight] = useState<number>();
  const [loaded, setLoaded] = useState(false);
  // The theme rides in the fragment for the first paint; later changes are posted.
  const [src] = useState(
    () =>
      `${GUEST_RENDER_ROUTE}?${GUEST_SHARE_PARAM}=${encodeURIComponent(shareId)}&item=${encodeURIComponent(itemId)}${htmlRenderThemeFragment(theme)}`,
  );
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the frame box and follows its width with a ResizeObserver before paint
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    return observeResize(box, ([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
  }, []);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- posts theme changes to the iframe's window
  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(htmlRenderThemeMessage(theme), "*");
  }, [theme]);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- window message listener for the iframe's height reports and link requests
  useEffect(() => {
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      if (frame === null || event.source !== frame.contentWindow) return;
      const height = readHtmlRenderContentHeight(event.data);
      if (height !== undefined) {
        setContentHeight(height);
        return;
      }
      // Only while the reader is using this frame, so a page cannot open links on its own.
      const link = readHtmlRenderLinkRequest(event.data);
      if (
        link === undefined ||
        document.activeElement !== frame ||
        navigator.userActivation?.isActive === false
      ) {
        return;
      }
      window.open(link.url, "_blank", "noopener,noreferrer");
      frame.contentWindow?.postMessage(htmlRenderResult(link.id), "*");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, []);

  return (
    <div
      ref={boxRef}
      className="relative"
      style={{
        height: htmlRenderFrameHeight(reference, width, contentHeight),
      }}
    >
      {loaded ? null : (
        <Skeleton
          role="status"
          aria-label="Loading page"
          shape="card"
          className="absolute inset-0"
        />
      )}
      <iframe
        ref={frameRef}
        src={src}
        title={reference.title}
        sandbox="allow-scripts allow-forms allow-popups allow-downloads"
        onLoad={() => setLoaded(true)}
        className={cn("block size-full rounded-lg border border-border", !loaded && "opacity-0")}
      />
    </div>
  );
}
