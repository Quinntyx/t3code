import { cn } from "~/lib/utils";
import { guestBubbleClassName } from "./guestMessageStyle";

/** A message the agent has not received yet: unfilled, with a dashed edge, like the queue. */
export function unsentMessageBubbleClassName(tone: "default" | "guest" = "default"): string {
  return tone === "guest"
    ? guestBubbleClassName(true)
    : cn("border border-dashed bg-transparent", "border-muted-foreground/40");
}

/** The dashed edge is the only sighted cue, so the state is spoken as well. */
export const UNSENT_MESSAGE_ANNOUNCEMENT = "Waiting for the agent to receive this message";
