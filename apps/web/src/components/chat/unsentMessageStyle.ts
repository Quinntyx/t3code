import { cn } from "~/lib/utils";

/** A message the agent has not received yet: unfilled, with a dashed edge, like the queue. */
export function unsentMessageBubbleClassName(tone: "default" | "guest" = "default"): string {
  return cn(
    "border border-dashed bg-transparent",
    tone === "guest" ? "border-guest/50" : "border-muted-foreground/40",
  );
}
