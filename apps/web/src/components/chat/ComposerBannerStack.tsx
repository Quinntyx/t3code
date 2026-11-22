import { useGT } from "gt-react";
import { InfoIcon } from "lucide-react";
import { useLayoutEffect, useRef, useState, type ReactNode, type TransitionEvent } from "react";

import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ComposerBanner, type ComposerBannerVariant } from "./ComposerBanner";
import { observeResize } from "~/lib/observeResize";
import { isFadingOut } from "~/hooks/useExitTransition";

/**
 * Where a notice sits in the stack. The machine comes first, then what needs you; the
 * order is fixed so rows never trade places as notices come and go.
 */
export type ComposerBannerGroup = "environment" | "attention";

export interface ComposerBannerStackItem {
  readonly id: string;
  readonly variant: ComposerBannerVariant;
  readonly group?: ComposerBannerGroup;
  readonly icon: ReactNode;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly children?: ReactNode;
  readonly actions?: ReactNode;
  readonly dismissLabel?: string;
  readonly onDismiss?: () => void;
}

const GROUPS = ["environment", "attention"] as const;

const FADE_IN =
  "transition-opacity duration-150 ease-out starting:opacity-0 motion-reduce:transition-none";

const inGroupOrder = (items: ReadonlyArray<ComposerBannerStackItem>) =>
  GROUPS.flatMap((group) => items.filter((item) => (item.group ?? "attention") === group));

/**
 * The notices to draw: the current ones, plus each removed one at its old place, marked
 * `data-ending-style` until a theme's fade ends (at once without one), showing what it last said.
 */
function useExitingNotices(items: ReadonlyArray<ComposerBannerStackItem>) {
  const [previous, setPrevious] = useState(items);
  const [exiting, setExiting] = useState<
    ReadonlyArray<{ readonly item: ComposerBannerStackItem; readonly after: string | null }>
  >([]);
  if (items !== previous) {
    const ids = new Set(items.map((item) => item.id));
    const before = inGroupOrder(previous);
    setPrevious(items);
    setExiting((current) => [
      ...current.filter((entry) => !ids.has(entry.item.id)),
      ...before.flatMap((item, index) =>
        ids.has(item.id) ? [] : [{ item, after: before[index - 1]?.id ?? null }],
      ),
    ]);
  }
  const rows = inGroupOrder(items).map((item) => ({ item, exiting: false }));
  for (const entry of exiting) {
    const at = entry.after === null ? -1 : rows.findIndex((row) => row.item.id === entry.after);
    rows.splice(at + 1, 0, { item: entry.item, exiting: true });
  }
  const exitProps = (row: (typeof rows)[number]) => {
    if (!row.exiting) return {};
    const release = () =>
      setExiting((current) => current.filter((entry) => entry.item.id !== row.item.id));
    return {
      "data-ending-style": "",
      inert: true,
      ref: (element: HTMLElement | null) => {
        if (element && !isFadingOut(element)) release();
      },
      onTransitionEnd: (event: TransitionEvent) => {
        if (event.target === event.currentTarget && event.propertyName === "opacity") release();
      },
    };
  };
  return { rows, exitProps };
}

/**
 * Notices about sending from this composer, each its own attached card. Consecutive cards join
 * edge to edge, and the last joins the composer or the drawer below it. Detached cards stand
 * apart instead, for layouts where the composer must not move when a notice appears.
 */
export function ComposerBannerStack({
  items,
  detached = false,
}: {
  readonly items: ReadonlyArray<ComposerBannerStackItem>;
  readonly detached?: boolean;
}) {
  const { rows, exitProps } = useExitingNotices(items);
  if (detached) {
    return rows.map((row) => (
      <div
        key={row.item.id}
        data-composer-banner-stack="true"
        data-side="top"
        {...exitProps(row)}
        className={FADE_IN}
      >
        <NoticeCard item={row.item} detached />
      </div>
    ));
  }
  return rows.map((row) => (
    <ComposerBanner.Attachment
      key={row.item.id}
      data-composer-banner-stack="true"
      data-side="top"
      {...exitProps(row)}
      className={FADE_IN}
    >
      <NoticeCard item={row.item} />
    </ComposerBanner.Attachment>
  ));
}

const SUBPIXEL_ROUNDING = 0.001;

export function NoticeText({
  children,
  className,
  detailsLabel,
}: {
  readonly children: ReactNode;
  readonly className: string;
  readonly detailsLabel: string;
}) {
  const gt = useGT();
  const textRef = useRef<HTMLSpanElement>(null);
  const detailsRef = useRef<HTMLButtonElement>(null);
  const [detailsAtWidth, setDetailsAtWidth] = useState<number | null>(null);
  const showDetails = detailsAtWidth !== null;

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures text overflow in the DOM via ResizeObserver and MutationObserver to show the details button
  useLayoutEffect(() => {
    const text = textRef.current;
    if (!text) return;
    const banner = text.closest("[data-slot=composer-banner]");
    const range = document.createRange();
    const measure = () => {
      // Ignore the space taken by the details button itself so it cannot
      // sustain its own overflow after the text would otherwise fit.
      const recoveredWidth = detailsRef.current ? detailsRef.current.offsetWidth + 4 : 0;
      const hidden = getComputedStyle(text).position === "absolute";
      const overflowing =
        hidden ||
        [text, ...text.querySelectorAll("*")].some((element) => {
          // A range spans laid-out content only; scrollWidth also counts positioned layers
          // such as a link's touch hit area, which overflow without cutting any text.
          // The two rects can disagree by float rounding (~0.00001px on phones); real
          // overflow is at least one layout unit, 1/64 of a device pixel.
          range.selectNodeContents(element);
          return (
            range.getBoundingClientRect().width >
            element.getBoundingClientRect().width + recoveredWidth + SUBPIXEL_ROUNDING
          );
        });
      // The button's width can wrap the banner's actions onto a second row, which gives
      // the text room and removes the button, which unwraps the row again. Once shown,
      // the button stays until the banner itself gets wider than where it appeared.
      const width = banner?.clientWidth ?? text.clientWidth;
      setDetailsAtWidth((shownAt) =>
        overflowing
          ? (shownAt ?? width)
          : banner && shownAt !== null && width <= shownAt
            ? shownAt
            : null,
      );
    };
    measure();
    const stopObserving = observeResize([text, banner ?? text], measure);
    let content = text.textContent;
    const mutations = new MutationObserver(() => {
      if (text.textContent !== content) {
        content = text.textContent;
        setDetailsAtWidth(null);
      }
      measure();
    });
    mutations.observe(text, { childList: true, subtree: true, characterData: true });
    return () => {
      stopObserving();
      mutations.disconnect();
    };
  }, []);

  return (
    <span className="contents">
      <span ref={textRef} className={className}>
        {children}
      </span>
      {showDetails ? (
        <Popover>
          <PopoverTrigger
            openOnHover
            render={
              <Button
                ref={detailsRef}
                size="icon-xs"
                variant="ghost-muted"
                aria-label={detailsLabel}
                className="flex-none"
              />
            }
          >
            <InfoIcon />
          </PopoverTrigger>
          <PopoverPopup
            aria-label={gt("Notice details")}
            tooltipStyle
            side="top"
            className="max-w-[min(30rem,calc(100vw-2rem))] whitespace-normal wrap-anywhere [--inline-button-text-align:start] [--inline-button-white-space:normal] [&_[data-slot=inline-button]]:max-w-full"
          >
            <ComposerBanner.Scroll>{children}</ComposerBanner.Scroll>
          </PopoverPopup>
        </Popover>
      ) : null}
    </span>
  );
}

function NoticeCard({
  item,
  detached = false,
}: {
  readonly item: ComposerBannerStackItem;
  readonly detached?: boolean;
}) {
  const gt = useGT();
  return (
    <ComposerBanner.Root
      role={item.variant === "error" || item.variant === "warning" ? "alert" : undefined}
      variant={item.variant}
      detached={detached}
      density="comfortable"
      data-chat-composer-collapsed-controls="true"
    >
      <ComposerBanner.Row layout="wrap-actions">
        <ComposerBanner.Icon className="h-(--composer-banner-icon-column) self-start">
          {item.icon}
        </ComposerBanner.Icon>
        <ComposerBanner.Content className="items-baseline whitespace-nowrap">
          <NoticeText
            detailsLabel={
              typeof item.title === "string"
                ? gt("Show full title: {title}", { title: item.title })
                : gt("Show title details")
            }
            className="min-w-0 truncate font-medium leading-7 sm:leading-6"
          >
            {item.title}
          </NoticeText>
          {item.description ? (
            <NoticeText
              detailsLabel={
                typeof item.title === "string"
                  ? gt("Show details: {title}", { title: item.title })
                  : gt("Show notice details")
              }
              className="w-0 min-w-0 grow truncate text-muted-foreground @max-[400px]:sr-only"
            >
              {item.description}
            </NoticeText>
          ) : null}
        </ComposerBanner.Content>
        {item.actions || item.onDismiss ? (
          <ComposerBanner.Actions className="min-w-14 sm:min-w-12">
            {item.actions}
            {item.onDismiss ? (
              <ComposerBanner.Dismiss
                aria-label={item.dismissLabel ?? gt("Dismiss warning")}
                onClick={item.onDismiss}
              />
            ) : null}
          </ComposerBanner.Actions>
        ) : null}
      </ComposerBanner.Row>
      {item.children ? <ComposerBanner.Children>{item.children}</ComposerBanner.Children> : null}
    </ComposerBanner.Root>
  );
}
