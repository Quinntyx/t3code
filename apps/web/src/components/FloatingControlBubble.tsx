import type { ComponentProps } from "react";

import { cn } from "~/lib/utils";

/** A round glass bubble that holds controls in a window corner, beside the floating panels. */
export function FloatingControlBubble({ className, children, ...props }: ComponentProps<"div">) {
  return (
    <div
      className={cn(
        "isolate flex flex-col items-center gap-0.5 rounded-full p-1 shadow-float [--radius:1rem]",
        className,
      )}
      {...props}
    >
      <div aria-hidden className="panel-glass" />
      {children}
    </div>
  );
}
