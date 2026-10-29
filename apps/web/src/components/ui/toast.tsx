import { Spinner } from "~/components/ui/spinner";

import { Toast } from "@base-ui/react/toast";
import {
  useEffect,
  useState,
  type CSSProperties,
  type ComponentPropsWithoutRef,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { Check, ChevronDown, ChevronUp, Copy } from "lucide";

import { cn } from "~/lib/utils";
import { Button, buttonVariants } from "~/components/ui/button";
import { MorphIcon } from "~/components/MorphIcon";
import { useComposerDraftStore } from "~/composerDraftStore";
import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import {
  buildVisibleToastLayout,
  hasVisibleToastAction,
  shouldHideCollapsedToastContent,
  shouldRenderThreadScopedToast,
} from "./toast.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./tooltip";
import { useThreadRouteTarget } from "~/hooks/useThreadRouteTarget";

export type ThreadToastData = {
  threadRef?: ScopedThreadRef | null;
  threadId?: ThreadId | null;
  leadingIcon?: ReactNode;
  tooltipStyle?: boolean;
  onClose?: (() => void) | undefined;
  dismissAfterVisibleMs?: number;
  hideCopyButton?: boolean;
  additionalActions?: ReadonlyArray<{
    id: string;
    props: ComponentPropsWithoutRef<"button">;
  }>;
  secondaryActionProps?: ComponentPropsWithoutRef<"button">;
  secondaryActionVariant?:
    | "default"
    | "destructive"
    | "destructive-outline"
    | "ghost"
    | "link"
    | "outline"
    | "secondary";
  expandableContent?: ReactNode;
  expandableLabels?: { expand?: string; collapse?: string };
  expandableDescriptionTrigger?: boolean;
  actionLayout?: "inline" | "stacked-end";
  actionVariant?:
    | "default"
    | "destructive"
    | "destructive-outline"
    | "ghost"
    | "link"
    | "outline"
    | "secondary";
};

type BaseToastManager = ReturnType<typeof Toast.createToastManager<ThreadToastData>>;
type ToastManagerListener = Parameters<BaseToastManager[" subscribe"]>[0];
type ToastManagerEvent = Parameters<ToastManagerListener>[0];

/**
 * base-ui's manager drops events while no provider is subscribed. App services raise toasts
 * from before the first render (and while the root error view replaces the providers), so hold
 * those until a provider listens.
 */
function createBufferedToastManager(): BaseToastManager {
  const manager = Toast.createToastManager<ThreadToastData>();
  const listeners = new Set<ToastManagerListener>();
  const pending: ToastManagerEvent[] = [];
  manager[" subscribe"]((event) => {
    if (listeners.size === 0) {
      pending.push(event);
      return;
    }
    for (const listener of listeners) listener(event);
  });
  return {
    ...manager,
    " subscribe"(listener) {
      listeners.add(listener);
      for (const event of pending.splice(0)) listener(event);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const toastManager = createBufferedToastManager();
const anchoredToastManager = createBufferedToastManager();
type ToastId = ReturnType<typeof toastManager.add>;
const threadToastVisibleTimeoutRemainingMs = new Map<ToastId, number>();

const TOAST_ICONS = {
  error: CircleAlertIcon,
  info: InfoIcon,
  loading: Spinner,
  success: CircleCheckIcon,
  warning: TriangleAlertIcon,
} as const;

const ERROR_DESCRIPTION_CLAMP_MIN_CHARS = 180;
function errorDescriptionClampClass(type: unknown, description: unknown): string | undefined {
  if (type !== "error" || typeof description !== "string") {
    return undefined;
  }
  if (description.length < ERROR_DESCRIPTION_CLAMP_MIN_CHARS) {
    return undefined;
  }
  return "line-clamp-4";
}

const toastDismissClass =
  "absolute top-[calc(--spacing(2)-1px)] right-[calc(--spacing(2)-1px)] z-20";
const toastCloseClass = cn(
  "inline-flex size-8 shrink-0 cursor-pointer items-center justify-center rounded-[calc(var(--radius-glass)-0.5rem)] border border-border/60 bg-muted/20 text-muted-foreground outline-none",
  "transition-[color,background-color,box-shadow] hover:bg-accent/35 hover:text-foreground",
  "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
);

function handleToastDismissClick(
  manager: typeof toastManager | typeof anchoredToastManager,
  toastId: ToastId,
  onClose: (() => void) | undefined,
) {
  onClose?.();
  manager.close(toastId);
}

function CopyErrorButton({ text }: { text: string }) {
  const { copyToClipboard, isCopied } = useCopyToClipboard({ target: "error-message" });
  const label = isCopied ? "Copied error" : "Copy error";

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            size="icon-micro"
            variant="ghost-muted"
            aria-label={label}
            className="[--control-icon-color:currentColor] rounded-md text-muted-foreground/80 hover:bg-transparent hover:text-muted-foreground"
            onClick={() => copyToClipboard(text)}
          />
        }
      >
        <MorphIcon
          className={cn("size-3", isCopied && "text-success")}
          icon={isCopied ? Check : Copy}
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{label}</TooltipPopup>
    </Tooltip>
  );
}

const toastExpandablePanelClassName =
  "mt-2 max-h-40 min-h-0 overflow-y-auto overscroll-contain pr-0.5 select-text";

function ToastExpandableSection({
  children,
  labels,
}: {
  children: ReactNode;
  labels: { expand?: string; collapse?: string };
}) {
  const [open, setOpen] = useState(false);
  const expandLabel = labels.expand ?? "Show details";
  const collapseLabel = labels.collapse ?? "Hide details";

  return (
    <div className="min-w-0">
      <button
        aria-expanded={open}
        className="inline-flex cursor-pointer items-center gap-1 rounded-md py-0.5 text-left text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen((prev) => !prev)}
        type="button"
      >
        <MorphIcon
          className="size-3.5 shrink-0 opacity-80"
          icon={open ? ChevronUp : ChevronDown}
          strokeWidth={2.25}
        />
        {open ? collapseLabel : expandLabel}
      </button>
      {open ? <div className={toastExpandablePanelClassName}>{children}</div> : null}
    </div>
  );
}

function ToastDescriptionAndExpandable({
  toastData,
  toastDescription,
  toastType,
}: {
  toastData: ThreadToastData | undefined;
  toastDescription: unknown;
  toastType: unknown;
}) {
  const expandableContent = toastData?.expandableContent;
  const labels = toastData?.expandableLabels ?? {};
  const descriptionTrigger = toastData?.expandableDescriptionTrigger ?? false;
  const descriptionClassName = cn(
    "min-w-0 select-text wrap-break-word text-muted-foreground",
    errorDescriptionClampClass(toastType, toastDescription),
  );
  const [open, setOpen] = useState(false);

  if (!expandableContent) {
    return <Toast.Description className={descriptionClassName} data-slot="toast-description" />;
  }

  if (!descriptionTrigger) {
    return (
      <>
        <Toast.Description className={descriptionClassName} data-slot="toast-description" />
        <ToastExpandableSection labels={labels}>{expandableContent}</ToastExpandableSection>
      </>
    );
  }

  const expandLabel = labels.expand ?? "Show details";
  const collapseLabel = labels.collapse ?? "Hide details";

  const toggle = () => setOpen((v) => !v);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      toggle();
    }
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <div
              aria-label={open ? collapseLabel : expandLabel}
              aria-expanded={open}
              className={cn(
                "group flex min-w-0 w-full cursor-pointer select-none items-start gap-1.5 rounded-sm text-left outline-none ring-offset-background",
                "transition-colors hover:bg-muted/40",
                "focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background",
              )}
              onClick={toggle}
              onKeyDown={onKeyDown}
              role="button"
              tabIndex={0}
            />
          }
        >
          <div className="min-w-0 flex-1">
            <Toast.Description
              className={cn(
                "min-w-0 select-none wrap-break-word text-muted-foreground",
                errorDescriptionClampClass(toastType, toastDescription),
                "underline-offset-2 decoration-muted-foreground/60 group-hover:underline",
              )}
              data-slot="toast-description"
            />
          </div>
          <MorphIcon
            aria-hidden
            className="size-3.5 h-lh shrink-0 text-muted-foreground opacity-80"
            icon={open ? ChevronUp : ChevronDown}
            strokeWidth={2.25}
          />
        </TooltipTrigger>
        <TooltipPopup side="top">{open ? collapseLabel : expandLabel}</TooltipPopup>
      </Tooltip>
      {open ? <div className={toastExpandablePanelClassName}>{expandableContent}</div> : null}
    </>
  );
}

type ToastIconComponent = (typeof TOAST_ICONS)[keyof typeof TOAST_ICONS];

interface ToastBodyDescriptor {
  readonly Icon: ToastIconComponent | null | undefined;
  readonly actionVariant: NonNullable<ThreadToastData["actionVariant"]>;
  readonly secondaryActionVariant: NonNullable<ThreadToastData["secondaryActionVariant"]>;
  readonly copyErrorText: string | null;
  readonly hasTrailingControls: boolean;
}

function deriveToastBodyDescriptor(toast: {
  readonly type?: string | undefined;
  readonly description?: unknown;
  readonly actionProps?: unknown;
  readonly data?: ThreadToastData | undefined;
}): ToastBodyDescriptor {
  const Icon = toast.type ? TOAST_ICONS[toast.type as keyof typeof TOAST_ICONS] : null;
  const actionVariant: NonNullable<ThreadToastData["actionVariant"]> =
    toast.data?.actionVariant ?? "default";
  const secondaryActionVariant: NonNullable<ThreadToastData["secondaryActionVariant"]> =
    toast.data?.secondaryActionVariant ?? "outline";
  const copyErrorText =
    toast.type === "error" && typeof toast.description === "string" && !toast.data?.hideCopyButton
      ? toast.description
      : null;
  const hasAdditionalActions = (toast.data?.additionalActions?.length ?? 0) > 0;
  const hasSecondaryAction = toast.data?.secondaryActionProps !== undefined;
  const hasTrailingControls =
    copyErrorText !== null ||
    hasVisibleToastAction(toast.actionProps) ||
    hasAdditionalActions ||
    hasSecondaryAction;
  return {
    Icon,
    actionVariant,
    secondaryActionVariant,
    copyErrorText,
    hasTrailingControls,
  };
}

interface ToastBodyContentProps extends ToastBodyDescriptor {
  readonly actionProps: { readonly children?: ReactNode } | undefined;
  readonly toastData: ThreadToastData | undefined;
  readonly toastDescription: unknown;
  readonly toastType: unknown;
}

function ToastBodyContent({
  Icon,
  copyErrorText,
  actionProps,
  actionVariant,
  secondaryActionVariant,
  hasTrailingControls,
  toastData,
  toastDescription,
  toastType,
}: ToastBodyContentProps) {
  const additionalActions = toastData?.additionalActions ?? [];
  const secondaryActionProps = toastData?.secondaryActionProps;
  const leadingIcon = toastData?.leadingIcon;
  const { className: secondaryActionClassName, ...secondaryActionRest } =
    secondaryActionProps ?? {};

  return (
    <>
      <div className="flex min-h-8 min-w-0 flex-col gap-0.5 px-1.5 pt-1 pr-10">
        <div className="flex min-w-0 gap-2">
          {leadingIcon ? (
            <div
              className="flex h-lh w-4 shrink-0 items-center justify-center"
              data-slot="toast-icon"
            >
              {leadingIcon}
            </div>
          ) : Icon ? (
            <div
              className="[&>svg]:h-lh [&>svg]:w-4 [&_svg]:pointer-events-none [&_svg]:shrink-0"
              data-slot="toast-icon"
            >
              <Icon className="in-data-[type=error]:text-destructive in-data-[type=info]:text-info in-data-[type=success]:text-success in-data-[type=warning]:text-warning in-data-[type=loading]:opacity-80" />
            </div>
          ) : null}
          <Toast.Title className="min-w-0 wrap-break-word font-medium" data-slot="toast-title" />
        </div>
        <ToastDescriptionAndExpandable
          toastData={toastData}
          toastDescription={toastDescription}
          toastType={toastType}
        />
      </div>
      {hasTrailingControls ? (
        <div
          className="flex w-full flex-wrap items-center justify-end gap-2 [--control-radius:calc(var(--radius-glass)-0.5rem)]"
          data-slot="toast-actions"
        >
          {copyErrorText !== null ? <CopyErrorButton text={copyErrorText} /> : null}
          {additionalActions.map(({ id, props: { className, ...props } }) => (
            <Button
              {...props}
              className={className}
              key={id}
              size="default"
              type="button"
              variant={secondaryActionVariant}
            />
          ))}
          {secondaryActionProps ? (
            <Button
              {...secondaryActionRest}
              className={secondaryActionClassName}
              size="default"
              type="button"
              variant={secondaryActionVariant}
            />
          ) : null}
          {hasVisibleToastAction(actionProps) ? (
            <Toast.Action
              className={buttonVariants({ size: "default", variant: actionVariant })}
              data-slot="toast-action"
            >
              {actionProps?.children}
            </Toast.Action>
          ) : null}
        </div>
      ) : null}
    </>
  );
}

type ToastPosition =
  | "top-left"
  | "top-center"
  | "top-right"
  | "bottom-left"
  | "bottom-center"
  | "bottom-right";

interface ToastProviderProps extends Toast.Provider.Props {
  position?: ToastPosition;
}

function useActiveThreadRefFromRoute(): ScopedThreadRef | null {
  const routeTarget = useThreadRouteTarget();
  const activeDraftSession = useComposerDraftStore((store) =>
    routeTarget?.kind === "draft" ? store.getDraftSession(routeTarget.draftId) : null,
  );

  if (routeTarget?.kind === "server") {
    return routeTarget.threadRef;
  }
  if (routeTarget?.kind === "draft" && activeDraftSession) {
    return {
      environmentId: activeDraftSession.environmentId,
      threadId: activeDraftSession.threadId,
    };
  }
  return null;
}

function ThreadToastVisibleAutoDismiss({
  toastId,
  dismissAfterVisibleMs,
}: {
  toastId: ToastId;
  dismissAfterVisibleMs: number | undefined;
}) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- dismiss timer that pauses on visibilitychange, focus and blur so it only counts visible time
  useEffect(() => {
    if (!dismissAfterVisibleMs || dismissAfterVisibleMs <= 0) return;
    if (typeof window === "undefined" || typeof document === "undefined") return;

    let remainingMs = threadToastVisibleTimeoutRemainingMs.get(toastId) ?? dismissAfterVisibleMs;
    let startedAtMs: number | null = null;
    let timeoutId: number | null = null;
    let closed = false;

    const clearTimer = () => {
      if (timeoutId === null) return;
      window.clearTimeout(timeoutId);
      timeoutId = null;
    };

    const closeToast = () => {
      if (closed) return;
      closed = true;
      threadToastVisibleTimeoutRemainingMs.delete(toastId);
      toastManager.close(toastId);
    };

    const pause = () => {
      if (startedAtMs === null) return;
      remainingMs = Math.max(0, remainingMs - (Date.now() - startedAtMs));
      startedAtMs = null;
      clearTimer();
      threadToastVisibleTimeoutRemainingMs.set(toastId, remainingMs);
    };

    const start = () => {
      if (closed || startedAtMs !== null) return;
      if (remainingMs <= 0) {
        closeToast();
        return;
      }
      startedAtMs = Date.now();
      clearTimer();
      timeoutId = window.setTimeout(() => {
        remainingMs = 0;
        startedAtMs = null;
        closeToast();
      }, remainingMs);
    };

    const syncTimer = () => {
      const shouldRun = document.visibilityState === "visible" && document.hasFocus();
      if (shouldRun) {
        start();
        return;
      }
      pause();
    };

    syncTimer();
    document.addEventListener("visibilitychange", syncTimer);
    window.addEventListener("focus", syncTimer);
    window.addEventListener("blur", syncTimer);

    return () => {
      document.removeEventListener("visibilitychange", syncTimer);
      window.removeEventListener("focus", syncTimer);
      window.removeEventListener("blur", syncTimer);
      pause();
      clearTimer();
    };
  }, [dismissAfterVisibleMs, toastId]);

  return null;
}

function ToastProvider({ children, position = "top-right", ...props }: ToastProviderProps) {
  return (
    <Toast.Provider toastManager={toastManager} {...props}>
      {children}
      <Toasts position={position} />
    </Toast.Provider>
  );
}

function Toasts({ position }: { position: ToastPosition }) {
  const { toasts } = Toast.useToastManager<ThreadToastData>();
  const activeThreadRef = useActiveThreadRefFromRoute();
  const isTop = position.startsWith("top");
  const visibleToasts = toasts.filter((toast) =>
    shouldRenderThreadScopedToast(toast.data, activeThreadRef),
  );
  const visibleToastLayout = buildVisibleToastLayout(visibleToasts);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- prunes the module-level remaining-time map of toasts the manager has dropped
  useEffect(() => {
    const activeToastIds = new Set(toasts.map((toast) => toast.id));
    for (const toastId of threadToastVisibleTimeoutRemainingMs.keys()) {
      if (!activeToastIds.has(toastId)) {
        threadToastVisibleTimeoutRemainingMs.delete(toastId);
      }
    }
  }, [toasts]);

  return (
    <Toast.Portal data-slot="toast-portal">
      <Toast.Viewport
        className={cn(
          "fixed z-100 mx-auto flex w-[calc(100%-var(--toast-inset)*2)] max-w-90 [--toast-header-offset:var(--workspace-topbar-height)] [--toast-inset:--spacing(4)] sm:[--toast-inset:--spacing(8)]",
          "data-[position*=top]:top-[calc(var(--toast-inset)+var(--toast-header-offset))]",
          "data-[position*=bottom]:bottom-(--toast-inset)",
          "data-[position*=left]:left-(--toast-inset)",
          "data-[position*=right]:right-(--toast-inset)",
          "data-[position*=center]:-translate-x-1/2 data-[position*=center]:left-1/2",
        )}
        data-position={position}
        data-slot="toast-viewport"
        style={
          {
            "--toast-frontmost-height": `${visibleToastLayout.frontmostHeight}px`,
          } as CSSProperties
        }
      >
        {visibleToastLayout.items.map(({ toast, visibleIndex, offsetY }) => {
          const hideCollapsedContent = shouldHideCollapsedToastContent(
            visibleIndex,
            visibleToastLayout.items.length,
          );
          const bodyDescriptor = deriveToastBodyDescriptor(toast);

          return (
            <Toast.Root
              className={cn(
                "dropdown-glass absolute z-[calc(9999-var(--toast-index))] min-h-12 w-full overflow-visible select-none rounded-glass text-popover-foreground shadow-xl shadow-black/25 [transition:transform_.5s_cubic-bezier(.22,1,.36,1),opacity_.5s,height_.15s]",
                "data-[position*=right]:right-0 data-[position*=right]:left-auto",
                "data-[position*=left]:right-auto data-[position*=left]:left-0",
                "data-[position*=center]:right-0 data-[position*=center]:left-0",
                "data-[position*=top]:top-0 data-[position*=top]:bottom-auto data-[position*=top]:origin-top",
                "data-[position*=bottom]:top-auto data-[position*=bottom]:bottom-0 data-[position*=bottom]:origin-bottom",
                "after:absolute after:left-0 after:h-[calc(var(--toast-gap)+1px)] after:w-full",
                "data-[position*=top]:after:top-full",
                "data-[position*=bottom]:after:bottom-full",
                visibleIndex > 0
                  ? "not-data-expanded:[--toast-calc-height:var(--toast-frontmost-height)] data-expanded:[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))]"
                  : "[--toast-calc-height:max(var(--toast-frontmost-height,var(--toast-height)),var(--toast-height))]",
                "[--toast-gap:--spacing(3)] [--toast-peek:--spacing(3)] [--toast-scale:calc(max(0,1-(var(--toast-index)*.1)))] [--toast-shrink:calc(1-var(--toast-scale))]",
                // Base UI measures with height:auto; --toast-height as min-height would prevent shrinking.
                visibleIndex > 0
                  ? "not-data-expanded:h-(--toast-calc-height) data-expanded:h-auto"
                  : "h-auto",
                "data-[position*=top]:[--toast-calc-offset-y:calc(var(--toast-offset-y)+var(--toast-index)*var(--toast-gap)+var(--toast-swipe-movement-y))]",
                "data-[position*=bottom]:[--toast-calc-offset-y:calc(var(--toast-offset-y)*-1+var(--toast-index)*var(--toast-gap)*-1+var(--toast-swipe-movement-y))]",
                "data-[position*=top]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)+(var(--toast-index)*var(--toast-peek))+(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-[position*=bottom]:transform-[translateX(var(--toast-swipe-movement-x))_translateY(calc(var(--toast-swipe-movement-y)-(var(--toast-index)*var(--toast-peek))-(var(--toast-shrink)*var(--toast-calc-height))))_scale(var(--toast-scale))]",
                "data-limited:opacity-0",
                "data-position:data-expanded:transform-[translateX(var(--toast-swipe-movement-x))_translateY(var(--toast-calc-offset-y))]",
                "data-[position*=top]:data-starting-style:transform-[translateY(calc(-100%-var(--toast-inset)))]",
                "data-[position*=bottom]:data-starting-style:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-starting-style:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:opacity-0",
                "data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateY(calc(100%+var(--toast-inset)))]",
                "data-[position*=top]:data-[position*=right]:data-ending-style:not-data-limited:not-data-swipe-direction:transform-[translateX(calc(100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
                "data-expanded:data-ending-style:data-[swipe-direction=left]:transform-[translateX(calc(var(--toast-swipe-movement-x)-100%-var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=right]:transform-[translateX(calc(var(--toast-swipe-movement-x)+100%+var(--toast-inset)))_translateY(var(--toast-calc-offset-y))]",
                "data-expanded:data-ending-style:data-[swipe-direction=up]:transform-[translateY(calc(var(--toast-swipe-movement-y)-100%-var(--toast-inset)))]",
                "data-expanded:data-ending-style:data-[swipe-direction=down]:transform-[translateY(calc(var(--toast-swipe-movement-y)+100%+var(--toast-inset)))]",
              )}
              data-position={position}
              data-slot="toast-popup"
              key={toast.id}
              style={
                {
                  "--toast-index": visibleIndex,
                  "--toast-offset-y": `${offsetY}px`,
                } as CSSProperties
              }
              swipeDirection={
                position.includes("center")
                  ? [isTop ? "up" : "down"]
                  : position.includes("left")
                    ? ["left", isTop ? "up" : "down"]
                    : ["right", isTop ? "up" : "down"]
              }
              toast={toast}
            >
              <ThreadToastVisibleAutoDismiss
                dismissAfterVisibleMs={toast.data?.dismissAfterVisibleMs}
                toastId={toast.id}
              />
              <div className={toastDismissClass}>
                <button
                  aria-label="Dismiss notification"
                  className={toastCloseClass}
                  data-slot="toast-close"
                  onClick={() =>
                    handleToastDismissClick(toastManager, toast.id, toast.data?.onClose)
                  }
                  type="button"
                >
                  <XIcon className="size-3" strokeWidth={2.25} />
                </button>
              </div>
              <Toast.Content
                className={cn(
                  // overflow-x:clip preserves visible vertical overflow; hidden would force overflow-y:auto
                  // and clip detail panels.
                  "pointer-events-auto flex min-h-12 flex-col gap-3 overflow-y-visible p-[calc(--spacing(2)-1px)] text-sm transition-opacity duration-250 [overflow-x:clip] data-expanded:opacity-100",
                  hideCollapsedContent &&
                    "not-data-expanded:pointer-events-none not-data-expanded:opacity-0",
                )}
              >
                <ToastBodyContent
                  {...bodyDescriptor}
                  actionProps={toast.actionProps}
                  toastData={toast.data}
                  toastDescription={toast.description}
                  toastType={toast.type}
                />
              </Toast.Content>
            </Toast.Root>
          );
        })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

function AnchoredToastProvider({ children, ...props }: Toast.Provider.Props) {
  return (
    <Toast.Provider toastManager={anchoredToastManager} {...props}>
      {children}
      <AnchoredToasts />
    </Toast.Provider>
  );
}

function AnchoredToasts() {
  const { toasts } = Toast.useToastManager<ThreadToastData>();
  const activeThreadRef = useActiveThreadRefFromRoute();

  return (
    <Toast.Portal data-slot="toast-portal-anchored">
      <Toast.Viewport className="outline-none" data-slot="toast-viewport-anchored">
        {toasts
          .filter((toast) => shouldRenderThreadScopedToast(toast.data, activeThreadRef))
          .map((toast) => {
            const tooltipStyle = toast.data?.tooltipStyle ?? false;
            const positionerProps = toast.positionerProps;
            const bodyDescriptor = deriveToastBodyDescriptor(toast);

            if (!positionerProps?.anchor) {
              return null;
            }

            return (
              <Toast.Positioner
                className="z-100 max-w-[min(--spacing(64),var(--available-width))]"
                data-slot="toast-positioner"
                key={toast.id}
                sideOffset={positionerProps.sideOffset ?? 4}
                toast={toast}
              >
                <Toast.Root
                  className={cn(
                    "dropdown-glass relative overflow-visible text-balance text-popover-foreground text-xs shadow-xl shadow-black/25 transition-[scale,opacity] data-ending-style:scale-98 data-starting-style:scale-98 data-ending-style:opacity-0 data-starting-style:opacity-0",
                    "rounded-glass",
                    !tooltipStyle && "min-h-12",
                  )}
                  data-slot="toast-popup"
                  toast={toast}
                >
                  {tooltipStyle ? (
                    <Toast.Content className="pointer-events-auto px-2 py-1">
                      <Toast.Title data-slot="toast-title" />
                    </Toast.Content>
                  ) : (
                    <>
                      <div className={toastDismissClass}>
                        <button
                          aria-label="Dismiss notification"
                          className={toastCloseClass}
                          data-slot="toast-close"
                          onClick={() =>
                            handleToastDismissClick(
                              anchoredToastManager,
                              toast.id,
                              toast.data?.onClose,
                            )
                          }
                          type="button"
                        >
                          <XIcon className="size-3" strokeWidth={2.25} />
                        </button>
                      </div>
                      <Toast.Content className="pointer-events-auto flex min-h-12 flex-col gap-3 overflow-y-visible p-[calc(--spacing(2)-1px)] text-sm [overflow-x:clip]">
                        <ToastBodyContent
                          {...bodyDescriptor}
                          actionProps={toast.actionProps}
                          toastData={toast.data}
                          toastDescription={toast.description}
                          toastType={toast.type}
                        />
                      </Toast.Content>
                    </>
                  )}
                </Toast.Root>
              </Toast.Positioner>
            );
          })}
      </Toast.Viewport>
    </Toast.Portal>
  );
}

export { stackedThreadToast } from "./toastHelpers";
export type { StackedThreadToastOptions } from "./toastHelpers";

export {
  ToastProvider,
  type ToastPosition,
  toastManager,
  AnchoredToastProvider,
  anchoredToastManager,
};
