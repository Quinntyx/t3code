import { lazy, Suspense, useState, type CSSProperties } from "react";

import { cn } from "~/lib/utils";

const ModelViewerContent = lazy(() =>
  import("./ModelViewerContent").then((module) => ({ default: module.ModelViewerContent })),
);

export function ModelViewer(props: {
  readonly src: string;
  readonly name: string;
  readonly cacheKey?: string | undefined;
  readonly className?: string | undefined;
  readonly style?: CSSProperties | undefined;
  readonly onRetry?: (() => Promise<unknown>) | undefined;
}) {
  const [reloadToken, setReloadToken] = useState(0);
  return (
    <span
      className={cn(
        "block aspect-video max-h-[30rem] w-full max-w-[min(100%,30rem)] overflow-hidden rounded-lg border border-border/40 bg-muted/30",
        props.className,
      )}
      style={props.style}
    >
      <Suspense fallback={<span className="block size-full motion-safe:animate-skeleton" />}>
        <ModelViewerContent
          key={`${props.src}:${reloadToken}`}
          src={props.src}
          name={props.name}
          cacheKey={props.cacheKey}
          onRetry={props.onRetry}
          onReload={() => setReloadToken((token) => token + 1)}
        />
      </Suspense>
    </span>
  );
}
